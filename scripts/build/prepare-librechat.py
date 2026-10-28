#!/usr/bin/env python3
"""Materialize the pinned upstream source and this repository's reviewed changes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def prepare(source, target):
    integration = source / 'integrations/librechat'
    lock = json.loads((integration / 'source.lock.json').read_text())
    patch = integration / 'customizations.patch'
    if lock.get('format') != 1 or lock['repository'] != 'https://github.com/LibreChat-AI/LibreChat.git':
        raise ValueError('Unsupported LibreChat source lock')
    if any(not re.fullmatch('[a-f0-9]{40}', lock[key]) for key in ['commit', 'tree']):
        raise ValueError('Exact LibreChat commit and tree required')
    if hashlib.sha256(patch.read_bytes()).hexdigest() != lock['patchSha256']:
        raise ValueError('LibreChat patch checksum mismatch')
    if target.exists():
        raise ValueError('LibreChat output already exists; choose a new directory')
    target.mkdir(parents=True)

    def git(*args):
        return subprocess.check_output(['git', '-c', 'core.autocrlf=false',
            '-c', 'core.hooksPath=/dev/null', '-C', str(target), *args], text=True).strip()

    git('init', '-q')
    git('remote', 'add', 'origin', lock['repository'])
    git('fetch', '--depth=1', 'origin', lock['commit'])
    git('checkout', '--detach', '-q', 'FETCH_HEAD')
    git('apply', '--index', '--whitespace=error', str(patch.resolve()))
    if git('write-tree') != lock['tree']:
        raise ValueError('Customized LibreChat source tree mismatch')
    if (target / 'LICENSE').read_bytes() != (integration / 'LICENSE').read_bytes():
        raise ValueError('LibreChat license mismatch')
    # Generated protocol copies must still refer to the current Browser API.
    for name in ['actions', 'protocol']:
        digest = hashlib.sha256((source / f'src/api/{name}.ts').read_bytes()).hexdigest()
        header = (target / f'packages/data-provider/src/browser/{name}.ts').read_text().splitlines()[0]
        if 'source SHA256 ' + digest + '.' not in header:
            raise ValueError('Browser contract changed; update the LibreChat integration: ' + name)
    return lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'output/sources/librechat')
    args = parser.parse_args()
    lock = prepare(ROOT, args.output.resolve())
    print(json.dumps({'directory': str(args.output.resolve()), **lock}))


if __name__ == '__main__':
    main()
