#!/usr/bin/env python3
"""Package a committed build into a self-contained private Agent candidate. Never publishes."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
INFRA = {
    'gateway': 'nginx@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951',
    'mongo': 'mongo:8.0@sha256:4a4ab5d4834207389e0d7270fac988e21ffedccecba77991a552f755df229907',
    'redis': 'redis:7.4-alpine@sha256:57e4255cc971b1c8d6f8a6ca283ac01bc3ecdd914273ef6bfaede87aaecd6541',
}
# Exact allowlist: no checkout-wide copy, local account data or private config.
FILES = {
    'agentctl.py': 'deploy/agent/agentctl.py', 'compose.yaml': 'deploy/agent/compose.yaml',
    'maintenance.py': 'deploy/agent/maintenance.py',
    'nginx.host.conf': 'deploy/agent/nginx.host.conf',
    'bundle.py': 'deploy/agent/bundle.py', 'README.md': 'deploy/agent/INSTALL.md',
    'OPERATIONS.md': 'deploy/agent/OPERATIONS.md', 'acceptance/verify.py': 'scripts/agent/verify-bundle.py',
    'acceptance/model-fixture.mjs': 'scripts/agent/model-fixture.mjs',
    'LICENSES/DISTRIBUTION-NOTICES.md': 'runtime/DISTRIBUTION-NOTICES.md',
    'LICENSES/PLAYWRIGHT-LICENSE': 'runtime/PLAYWRIGHT-LICENSE',
}


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): value.update(chunk)
    return value.hexdigest()


def git_bytes(repo, revision, path):
    return subprocess.check_output(['git', 'show', revision + ':' + path], cwd=repo)


def validate_report(report):
    if report.get('passed') is not True or report.get('sourceMode') != 'committed':
        raise ValueError('a completed build from committed sources is required')
    if set(report.get('images', {})) != {'agent', 'browser', 'runtime'}:
        raise ValueError('a complete three-image build is required')
    for revision in report['sourceCommits'].values():
        if not re.fullmatch(r'[a-f0-9]{40}', revision): raise ValueError('invalid source revision')
    for image in report['images'].values():
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', image['id']): raise ValueError('invalid image identity')


def validate_image_sources(source_commit, package_commit):
    paths = ['deploy/agent/app', 'deploy/agent/agent.Dockerfile', 'deploy/agent/browser.Dockerfile',
             'src', 'runtime', 'package-lock.json', 'tsconfig.json']
    changed = subprocess.check_output(['git', 'diff', '--name-only', source_commit, package_commit, '--', *paths], cwd=ROOT)
    if changed.strip(): raise ValueError('application/image inputs changed since the recorded build; rebuild first')
    before = json.loads(git_bytes(ROOT, source_commit, 'package.json'))
    after = json.loads(git_bytes(ROOT, package_commit, 'package.json'))
    # Package script additions are installer tooling; all other manifest fields
    # (including dependency versions and engines) must match the image source.
    before.pop('scripts', None); after.pop('scripts', None)
    if before != after: raise ValueError('application package manifest changed; rebuild first')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-report', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--librechat', type=Path, default=ROOT.parent / 'librechat-agent')
    parser.add_argument('--release', type=Path, help='Published six-image digest manifest; omit for offline candidate')
    args = parser.parse_args()
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?', args.version): raise ValueError('invalid version')
    if args.output.exists(): raise ValueError('output already exists')
    report = json.loads(args.build_report.read_text()); validate_report(report)
    package_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    validate_image_sources(report['sourceCommits']['browser'], package_commit)
    refs = {**{name: item['id'] for name, item in report['images'].items()}, **INFRA}
    distribution = 'offline-candidate'
    if args.release:
        release = json.loads(args.release.read_text())
        if release.get('version') != args.version or set(release.get('images', {})) != set(refs): raise ValueError('invalid release')
        if not all(re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}', v) for v in release['images'].values()): raise ValueError('immutable registry references required')
        refs = release['images']; distribution = 'registry-candidate'
    inventory = {}
    for name, ref in refs.items():
        info = json.loads(subprocess.check_output(DOCKER + ['image', 'inspect', ref]))[0]
        if info['Os'] != 'linux' or info['Architecture'] != 'amd64': raise ValueError('linux/amd64 required')
        if name in report['images'] and info['Id'] != report['images'][name]['id']: raise ValueError('build/image mismatch')
        inventory[name] = {'id': info['Id'], 'platform': 'linux/amd64'}
    if not args.release: refs = {k: v['id'] for k, v in inventory.items()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.agent-package-', dir=args.output.parent) as folder:
        staging = Path(folder); bundle = staging / ('agentic-browser-agent-' + args.version); bundle.mkdir()
        for name, source in FILES.items():
            file = bundle / name; file.parent.mkdir(parents=True, exist_ok=True)
            data = git_bytes(ROOT, package_commit, source)
            if name == 'README.md': data = re.sub(rb'v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?', args.version.encode(), data)
            file.write_bytes(data); file.chmod(0o644)
        (bundle / 'LICENSES/LibreChat.txt').write_bytes(git_bytes(args.librechat, report['sourceCommits']['librechat'], 'LICENSE'))
        (bundle / 'release.json').write_text(json.dumps({'version': args.version, 'images': refs}, indent=2) + '\n')
        build = {'version': args.version, 'distribution': distribution, 'published': False,
                 'sourceCommits': report['sourceCommits'], 'packageCommit': package_commit,
                 'runtimeAssets': report['runtimeAssets'], 'images': inventory,
                 'acceptance': {'independentHost': 'pending', 'note': 'Candidate packaging does not imply installation acceptance.'}}
        (bundle / 'BUILD.json').write_text(json.dumps(build, indent=2) + '\n')
        if not args.release:
            with (bundle / 'images.tar.gz').open('wb') as target, gzip.GzipFile(filename='', mode='wb', fileobj=target, mtime=0, compresslevel=1) as compressed:
                proc = subprocess.Popen(DOCKER + ['save', *dict.fromkeys(refs.values())], stdout=subprocess.PIPE)
                try:
                    shutil.copyfileobj(proc.stdout, compressed, 1024 * 1024)
                    if proc.wait() != 0: raise ValueError('image export failed')
                finally:
                    if proc.poll() is None: proc.kill(); proc.wait()
        sums = ''.join(f'{sha(file)}  {file.relative_to(bundle).as_posix()}\n' for file in sorted(bundle.rglob('*')) if file.is_file())
        (bundle / 'SHA256SUMS').write_text(sums)
        # The verifier has no project imports and is identical to what recipients use.
        subprocess.run(['python3', str(bundle / 'bundle.py'), 'verify'], check=True)
        archive = staging / (bundle.name + '.tar.gz')
        with tarfile.open(archive, 'w:gz', compresslevel=1) as tar:
            tar.add(bundle, arcname=bundle.name)
        (staging / 'SHA256SUMS').write_text(sha(archive) + '  ' + archive.name + '\n')
        # Publish the completed directory atomically; partial exports stay hidden.
        ready = staging / 'complete'; ready.mkdir()
        for item in [bundle, archive, staging / 'SHA256SUMS']: shutil.move(item, ready / item.name)
        ready.rename(args.output)
    print(json.dumps({'candidate': True, 'published': False, 'directory': str(args.output), 'images': len(inventory), 'packageCommit': package_commit}))


if __name__ == '__main__': main()
