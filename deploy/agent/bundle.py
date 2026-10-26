#!/usr/bin/env python3
"""Verify a candidate bundle and optionally import its six images. Python stdlib only."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''): value.update(chunk)
    return value.hexdigest()


def verify(directory):
    directory = directory.resolve()
    sums = directory / 'SHA256SUMS'
    if sums.is_symlink(): raise ValueError('symlink checksum file')
    entries = {}
    for row in sums.read_text().splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([a-zA-Z0-9_./-]+)', row)
        if not match: raise ValueError('invalid checksum line')
        expected, name = match.groups()
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or name in entries or name == 'SHA256SUMS':
            raise ValueError('unsafe or duplicate bundle path')
        file = directory / path
        if file.resolve() != file or not file.is_file() or digest(file) != expected:
            raise ValueError('bundle checksum mismatch: ' + name)
        entries[name] = expected
    paths = list(directory.rglob('*'))
    if any(p.is_symlink() for p in paths): raise ValueError('bundle symlinks are not allowed')
    actual = {p.relative_to(directory).as_posix() for p in paths if not p.is_dir()}
    if actual != set(entries) | {'SHA256SUMS'}: raise ValueError('unexpected or missing bundle files')
    required = {'agentctl.py', 'compose.yaml', 'bundle.py', 'release.json', 'BUILD.json', 'README.md', 'OPERATIONS.md',
                'acceptance/verify.py', 'acceptance/model-fixture.mjs', 'LICENSES/LibreChat.txt',
                'LICENSES/DISTRIBUTION-NOTICES.md', 'LICENSES/PLAYWRIGHT-LICENSE'}
    if not required <= set(entries): raise ValueError('incomplete bundle')
    release = json.loads((directory / 'release.json').read_text())
    build = json.loads((directory / 'BUILD.json').read_text())
    if build.get('distribution') not in ['offline-candidate', 'registry-candidate']:
        raise ValueError('unknown bundle distribution')
    if set(release.get('images', {})) != {'agent', 'browser', 'runtime', 'gateway', 'mongo', 'redis'}:
        raise ValueError('six release images required')
    if set(build.get('images', {})) != set(release['images']): raise ValueError('image inventory mismatch')
    for name, ref in release['images'].items():
        info = build['images'][name]
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', info['id']): raise ValueError('invalid image identity')
        if info.get('platform') != 'linux/amd64': raise ValueError('unsupported platform')
        if build.get('distribution') == 'offline-candidate':
            if ref != info['id']: raise ValueError('offline manifest must use exact image IDs')
        elif not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}', ref):
            raise ValueError('registry digest required')
    return build


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['verify', 'load-images'])
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    build = verify(directory)
    if args.command == 'load-images':
        if build['distribution'] != 'offline-candidate' or not (directory / 'images.tar.gz').is_file():
            raise ValueError('this bundle has no offline image archive')
        # Stream, do not inflate a multi-GB image archive into RAM or disk.
        with gzip.open(directory / 'images.tar.gz', 'rb') as source:
            proc = subprocess.Popen(DOCKER + ['load', '--quiet'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
            try:
                for chunk in iter(lambda: source.read(1024 * 1024), b''): proc.stdin.write(chunk)
                proc.stdin.close()
                if proc.wait() != 0: raise ValueError('image import failed')
            finally:
                if proc.poll() is None: proc.kill(); proc.wait()
        for info in build['images'].values():
            image = json.loads(subprocess.check_output(DOCKER + ['image', 'inspect', info['id']]))[0]
            if image['Id'] != info['id'] or image['Os'] + '/' + image['Architecture'] != info['platform']:
                raise ValueError('imported image mismatch')
    print(json.dumps({'verified': True, 'imagesImported': args.command == 'load-images',
                      'version': build['version'], 'distribution': build['distribution']}))


if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print('Bundle verification/import failed. Check the trusted checksum and Docker access.', file=sys.stderr)
        sys.exit(1)
