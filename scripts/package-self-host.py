#!/usr/bin/env python3
"""Build public, reproducible setup files for the currently accepted image pins."""
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('release_manifest', ROOT / 'scripts/release-manifest.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def build(root, output):
    contents = release.deployment_contents(root)
    images = {}
    for line in contents['deploy/release.env'].decode().splitlines():
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'AB_(CONTROLLER|RUNTIME)_IMAGE=(ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64})', line)
        if not match or match[1].lower() in images:
            raise SystemExit('Expected two unique, immutable GHCR image pins')
        images[match[1].lower()] = match[2]
    if set(images) != {'controller', 'runtime'}:
        raise SystemExit('Both controller and runtime image pins are required')
    # Native Compose needs no project checkout or helper after this one-time setup.
    compose = contents['compose.yaml'].decode()
    for key, image in [('AB_CONTROLLER_IMAGE', images['controller']), ('AB_RUNTIME_IMAGE', images['runtime'])]:
        compose, count = re.subn(r'\$\{' + key + r':-[^}]+\}', image, compose)
        if count != 1:
            raise SystemExit(f'Expected exactly one {key} reference in compose.yaml')
    compose = compose.replace('Use bash scripts/compose.sh to detect the socket group', 'Run the standalone installer to detect the socket group')
    compose = compose.replace('Use bash scripts/compose.sh', 'Run the standalone installer')
    installer = contents['scripts/install.sh.in'].decode()
    for marker, value in [('CONTROLLER_IMAGE', images['controller']), ('RUNTIME_IMAGE', images['runtime']), ('COMPOSE', compose.rstrip()), ('SETTINGS', contents['.env.example'].decode().rstrip())]:
        if installer.count(f'@@{marker}@@') != 1:
            raise SystemExit(f'Expected exactly one installer marker: {marker}')
        installer = installer.replace(f'@@{marker}@@', value)
    manifest = {'kind': 'public-self-host-configuration', 'images': images,
                'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(contents.items())}}
    contents['SETUP.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    output.mkdir(parents=True, exist_ok=True)
    (output / 'install.sh').write_text(installer)
    (output / 'workspace-backup.sh').write_bytes(contents['scripts/workspace-backup.sh'])
    for name in ['PUBLIC_DEMO.md', 'SELF_HOST.md', 'AGENT_CLIENT.md', 'STATUS.md']:
        (output / name).write_bytes(contents[f'docs/{name}'])
    archive = output / 'agentic-browser-self-host.tar.gz'
    with archive.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as bundle:
            for name, data in sorted(contents.items()):
                item = tarfile.TarInfo(f'agentic-browser/{name}')
                item.size = len(data)
                item.mode = 0o644
                bundle.addfile(item, io.BytesIO(data))
    (output / 'SHA256SUMS').write_text(f'{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n')
    print(f'Public setup archive: {archive} ({len(contents)} configuration/documentation files)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, default=ROOT / 'web/self-host-downloads')
    args = parser.parse_args()
    build(args.root.resolve(), args.output.resolve())
