#!/usr/bin/env python3
"""Record tested platform digests and publish an immutable deployment bundle."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
REPOS = {kind: f'ghcr.io/infrasika/agentic-browser-{kind}' for kind in ['controller', 'runtime']}
DIGEST = re.compile(r'sha256:[a-f0-9]{64}')


def deployment_contents(root=ROOT):
    """Public configuration and documentation only; never discover source or local state."""
    files = ['compose.yaml', 'compose.public.yaml', '.env.example',
             'scripts/compose.sh', 'scripts/public-demo.sh', 'scripts/release-compose.sh', 'scripts/install.sh.in', 'scripts/workspace-backup.sh',
             'README.md', 'docs/SELF_HOST.md', 'docs/UBUNTU_PUBLIC_DEMO.md', 'docs/AGENT_CLIENT.md',
             'docs/ARCHITECTURE.md', 'docs/RELEASING.md', 'docs/PLAN.md', 'docs/PROGRESS.md',
             'runtime/README.md', 'deploy/nginx-public.conf', 'deploy/release.env',
             'runtime/DISTRIBUTION-NOTICES.md', 'runtime/PLAYWRIGHT-LICENSE']
    for suffix in ['public', 'install', 'upgrade', 'soak', 'experience']:
        files += sorted(str(path.relative_to(root)) for path in (root / 'deploy/releases').glob(f'*-{suffix}-verification.json'))
    contents = {}
    for name in files:
        path = root / name
        if not path.is_file() or path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent.is_relative_to(root)):
            raise SystemExit(f'Missing or unsafe deployment file: {name}')
        contents[name] = path.read_bytes()
    return contents


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def record(arch, directory):
    result = {'architecture': arch, 'revision': os.environ['GITHUB_SHA'], 'images': {}}
    for kind, repo in REPOS.items():
        tag = os.environ[f'AB_{kind.upper()}_IMAGE']
        digests = json.loads(command('docker', 'image', 'inspect', tag, '--format', '{{json .RepoDigests}}'))
        matches = [ref for ref in digests if ref.startswith(repo + '@') and DIGEST.fullmatch(ref.split('@')[1])]
        if len(matches) != 1:
            raise SystemExit(f'Expected exactly one pushed digest for {kind}')
        result['images'][kind] = matches[0]
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f'{arch}.json').write_text(json.dumps(result, indent=2) + '\n')


def publish(version, directory):
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?', version):
        raise SystemExit('Invalid release version')
    revision = os.environ['GITHUB_SHA']
    records = [json.loads((directory / f'{arch}.json').read_text()) for arch in ['amd64', 'arm64']]
    for arch, record in zip(['amd64', 'arm64'], records):
        if record['architecture'] != arch or record['revision'] != revision:
            raise SystemExit('Both architectures must be verified at the release commit')
    # Preflight both tags before publishing either index. Authentication and
    # network failures are not evidence that a version is available.
    for kind, repo in REPOS.items():
        refs = [record['images'][kind] for record in records]
        if any(not ref.startswith(repo + '@') or not DIGEST.fullmatch(ref.split('@')[1]) for ref in refs):
            raise SystemExit('Unexpected image reference')
        # Never overwrite a published version, even if a later build used the
        # same source. Use a new version when retrying a partially published run.
        existing = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', f'{repo}:{version}'], capture_output=True, text=True)
        if existing.returncode == 0:
            raise SystemExit(f'{repo}:{version} already exists; choose a new release version')
        if not re.search(r'manifest[_ ]unknown|: not found', existing.stderr, re.IGNORECASE):
            raise SystemExit(f'Cannot confirm version availability for {kind}: {existing.stderr.strip()}')
    images = {}
    for kind, repo in REPOS.items():
        refs = [record['images'][kind] for record in records]
        subprocess.run(['docker', 'buildx', 'imagetools', 'create', '--tag', f'{repo}:{version}', *refs], check=True)
        detail = json.loads(command('docker', 'buildx', 'imagetools', 'inspect', f'{repo}:{version}', '--format', '{{json .Manifest}}'))
        digest = detail['digest']
        if not DIGEST.fullmatch(digest):
            raise SystemExit('Invalid published digest')
        platforms = {m.get('platform', {}).get('architecture') for m in detail.get('manifests', [])}
        if platforms != {'amd64', 'arm64'}:
            raise SystemExit(f'Incomplete platforms for {kind}: {platforms}')
        images[kind] = repo + '@' + digest
    output = ROOT / 'output/release'
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'version': version, 'revision': revision, 'platforms': ['linux/amd64', 'linux/arm64'],
                'images': images, 'assets': json.loads((ROOT / 'runtime/assets.lock.json').read_text()),
                'publicPullVerified': False}
    manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
    (output / 'RELEASE.json').write_bytes(manifest_bytes)
    contents = deployment_contents()
    contents['deploy/release.env'] = ''.join(f'AB_{kind.upper()}_IMAGE={ref}\n' for kind, ref in images.items()).encode()
    contents['RELEASE.json'] = manifest_bytes
    archive = output / 'agentic-browser-deploy.tar.gz'
    with tarfile.open(archive, 'w:gz') as bundle:
        for name, data in sorted(contents.items()):
            item = tarfile.TarInfo(f'agentic-browser/{name}')
            item.size = len(data); item.mode = 0o644; item.mtime = 0
            bundle.addfile(item, io.BytesIO(data))
    (output / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in [archive, output / 'RELEASE.json']))
    notes = f"""Native Linux amd64 and arm64 controller/browser images, built from `{revision}`.

Both platforms passed extension and Chrome sandbox checks, team isolation, human handoff, and public five-browser capacity acceptance.

Official demo: https://agentic-browser.zkpass.org/
Self-hosting: https://agentic-browser.zkpass.org/self-host

Extract the deployment bundle and follow docs/SELF_HOST.md. Use scripts/release-compose.sh to pull the images pinned by digest.

Keep the source repository private. GHCR packages must be Public and verified through anonymous pulls; completion of this workflow alone does not establish public availability. Release attachments require repository access and may be distributed separately by an administrator.

"""
    notes += '\n'.join(f'- {kind}: `{ref}`' for kind, ref in images.items()) + '\n'
    (output / 'NOTES.md').write_text(notes)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='mode', required=True)
    p = sub.add_parser('record'); p.add_argument('arch', choices=['amd64', 'arm64']); p.add_argument('directory', type=Path)
    p = sub.add_parser('publish'); p.add_argument('version'); p.add_argument('directory', type=Path)
    args = parser.parse_args()
    os.chdir(ROOT)
    if args.mode == 'record': record(args.arch, args.directory)
    else: publish(args.version, args.directory)
