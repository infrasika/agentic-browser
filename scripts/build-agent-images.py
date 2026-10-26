#!/usr/bin/env python3
"""Build the complete Agent from tracked source, never a checkout's private files.

Uses a dedicated memory/CPU-limited builder. Does not install or publish images.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import uuid

ROOT = Path(__file__).resolve().parent.parent

def run(args, **kwargs):
    return subprocess.run(args, cwd=ROOT, check=True, **kwargs)

def checkout(source, target):
    target.mkdir()
    # Copy tracked working files, including reviewed local edits. Git's tracked
    # allowlist excludes .env, deployment data, node_modules and raw logs.
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=source).decode().split('\0')
    for relative in filter(None, paths):
        if any(part in {'.git', 'node_modules', '.deployment', '.data', 'output'} for part in Path(relative).parts):
            raise RuntimeError('Private/generated path is tracked; refusing build context')
        original, dest = source / relative, target / relative
        if not original.exists() and not original.is_symlink():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        if original.is_symlink():
            dest.symlink_to(os.readlink(original))
        elif original.is_file():
            shutil.copy2(original, dest)
            dest.chmod(0o755 if original.stat().st_mode & 0o111 else 0o644)
    # The outer build directory stays private. Packaged source must be readable
    # by the image's non-root user, including arbitrary operator-selected UIDs.
    for parent, directories, _ in os.walk(target):
        Path(parent).chmod(0o755)

def committed_checkout(source, target, revision):
    """Use Git objects, never local generated files or uncommitted changes."""
    target.mkdir()
    data = subprocess.check_output(['git', 'archive', revision], cwd=source)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall(target, filter='data')

def runtime_assets(source, context):
    lock = json.loads((context / 'runtime/assets.lock.json').read_text())
    assets = {'chrome-amd64.deb': lock['chrome']['sha256'],
              **{entry['id'] + '.crx': entry['sha256'] for entry in lock['extensions']}}
    destination = context / 'output/runtime/packages'
    destination.mkdir(parents=True)
    for name, expected in assets.items():
        original = source / 'output/runtime/packages' / name
        if original.is_symlink() or hashlib.sha256(original.read_bytes()).hexdigest() != expected:
            raise ValueError('Locked runtime asset mismatch: ' + name)
        shutil.copyfile(original, destination / name)
        (destination / name).chmod(0o644)
    return assets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--librechat', type=Path, default=ROOT.parent / 'librechat-agent')
    parser.add_argument('--tag', default='selfhost-preview')
    parser.add_argument('--component', choices=['all', 'agent', 'browser', 'runtime'], default='all')
    parser.add_argument('--committed', action='store_true', help='Build only recorded Git commits (required for release candidates)')
    args = parser.parse_args()
    if not args.run:
        parser.print_help(); return
    import re
    if not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,60}', args.tag):
        raise ValueError('Invalid local image tag')
    os.umask(0o077)
    parent = ROOT / '.deployment/agent-build'
    parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='build-', dir=parent))
    builder = 'agent-build-' + uuid.uuid4().hex[:10]
    report = {'published': False, 'images': {}, 'sourceCommits': {}, 'sourceMode': 'committed' if args.committed else 'working-tree'}
    try:
        for name, repo in [('browser', ROOT), ('librechat', args.librechat)]:
            report['sourceCommits'][name] = subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
        run(['docker','buildx','create','--name',builder,'--driver','docker-container',
             '--driver-opt','memory=5g,cpu-period=100000,cpu-quota=200000'])
        # Snapshot each repository once, so helper files and Dockerfiles are also
        # bound to the recorded commits rather than the live working tree.
        sources = {}
        for name, repo in [('browser', ROOT), ('librechat', args.librechat)]:
            sources[name] = work / ('source-' + name)
            if args.committed: committed_checkout(repo, sources[name], report['sourceCommits'][name])
            else: checkout(repo, sources[name])
        for component in ['agent','browser','runtime']:
            if args.component not in ['all', component]: continue
            context=work/component
            shutil.copytree(sources['librechat' if component=='agent' else 'browser'], context)
            if component=='agent':
                shutil.copytree(sources['browser']/'deploy/agent/app',context/'selfhost')
            dockerfile = sources['browser'] / ('runtime/Dockerfile' if component=='runtime' else f'deploy/agent/{component}.Dockerfile')
            shutil.copy2(dockerfile,context/'Dockerfile.agent')
            if component=='runtime': report['runtimeAssets'] = runtime_assets(ROOT, context)
            # The git allowlist is already the boundary; do not inherit a legacy
            # ignore file that excludes required new deployment files.
            (context/'.dockerignore').write_text('.git\nnode_modules\n.deployment\n.data\n.env\n' + ('' if component=='runtime' else 'output\n'))
            image='agentic-browser-'+('service' if component=='browser' else component)+':'+args.tag
            with (work/(component+'.log')).open('w') as log:
                run(['docker','buildx','build','--builder',builder,'--platform','linux/amd64','--load',
                     '--progress','plain','--file',str(context/'Dockerfile.agent'),'--tag',image,
                     '--label','org.opencontainers.image.revision='+report['sourceCommits']['browser'],
                     '--label','dev.agentic-browser.librechat-revision='+report['sourceCommits']['librechat'],
                     '--build-arg','AB_REVISION='+report['sourceCommits']['browser'],
                     '--build-arg','AB_VERSION='+args.tag,str(context)],stdout=log,stderr=subprocess.STDOUT)
            report['images'][component]={'tag':image,'id':subprocess.check_output(['docker','image','inspect',image,'--format','{{.Id}}'],text=True).strip()}
        report['passed']=True
    finally:
        subprocess.run(['docker','buildx','rm',builder],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        (work/'report.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({'report':str(work/'report.json'),**report}))
    for component in ['agent','browser','runtime','source-browser','source-librechat']:
        shutil.rmtree(work/component,ignore_errors=True)

if __name__=='__main__': main()
