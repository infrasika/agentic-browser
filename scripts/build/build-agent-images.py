#!/usr/bin/env python3
"""Build the complete Agent from tracked source, never a checkout's private files.

Uses a dedicated memory/CPU-limited builder. Does not install or publish images.
"""
import argparse
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('librechat_source', ROOT / 'scripts/build/prepare-librechat.py')
librechat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(librechat)


def platforms(value):
    items = value.split(',')
    if not items or len(set(items)) != len(items) or any(p not in ['linux/amd64', 'linux/arm64'] for p in items):
        raise argparse.ArgumentTypeError('Use linux/amd64, linux/arm64 or both, without duplicates')
    return items

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
    # The data filter intentionally drops directory modes. Under our private
    # umask that creates 0700 directories, unreadable by a container's runtime
    # UID after Docker COPY. Keep only the enclosing work directory private.
    for parent, _, _ in os.walk(target):
        Path(parent).chmod(0o755)

def runtime_assets(source, context, architecture='amd64'):
    lock = json.loads((context / 'runtime/assets.lock.json').read_text())
    assets = {f'chrome-{architecture}.deb': lock['chromeArm64' if architecture == 'arm64' else 'chrome']['sha256'],
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
    parser.add_argument('--platforms', type=platforms, default=['linux/amd64', 'linux/arm64'])
    parser.add_argument('--builder', help='Existing Buildx builder (for native multi-node builders); never removed by this tool')
    parser.add_argument('--tag', default='development')
    parser.add_argument('--component', choices=['all', 'agent', 'browser', 'runtime'], default='all')
    parser.add_argument('--committed', action='store_true', help='Build only recorded Git commits (required for release candidates)')
    parser.add_argument('--browser-commit', help='Exact existing commit to rebuild; defaults to HEAD')
    args = parser.parse_args()
    if not args.run:
        parser.print_help(); return
    import re
    if not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,60}', args.tag):
        raise ValueError('Invalid local image tag')
    for revision in [args.browser_commit]:
        if revision and (not args.committed or not re.fullmatch(r'[a-f0-9]{40}', revision)):
            raise ValueError('Commit overrides require --committed and an exact SHA')
    os.umask(0o077)
    parent = ROOT / 'output/build'
    parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='build-', dir=parent))
    builder = args.builder or 'agent-build-' + uuid.uuid4().hex[:10]
    reports = {}
    try:
        revision = subprocess.check_output(['git','rev-parse','--verify',(args.browser_commit or 'HEAD')+'^{commit}'],cwd=ROOT,text=True).strip()
        sources = {'browser': work/'source-browser', 'librechat': work/'source-librechat'}
        if args.committed: committed_checkout(ROOT, sources['browser'], revision)
        else: checkout(ROOT, sources['browser'])
        lock = librechat.prepare(sources['browser'], sources['librechat'])
        if not args.builder:
            run(['docker','buildx','create','--name',builder,'--driver','docker-container',
                 '--driver-opt','memory=5g,cpu-period=100000,cpu-quota=200000'])
        for target in args.platforms:
            architecture = target.split('/')[1]
            directory = work/architecture; directory.mkdir()
            report = {'published': False, 'images': {}, 'platform': target,
                'sourceCommits': {'browser': revision, 'librechat': lock['commit']},
                'librechatTree': lock['tree'], 'runtimeAssets': {},
                'sourceMode': 'committed' if args.committed else 'working-tree'}
            reports[target] = str(directory/'report.json')
            try:
                for component in ['agent','browser','runtime']:
                    if args.component not in ['all', component]: continue
                    context=directory/component
                    shutil.copytree(sources['librechat' if component=='agent' else 'browser'], context,
                                    ignore=shutil.ignore_patterns('.git'))
                    if component=='agent':
                        shutil.copytree(sources['browser']/'deploy/agent/app',context/'selfhost')
                    dockerfile = sources['browser'] / ('runtime/Dockerfile' if component=='runtime' else f'deploy/agent/{component}.Dockerfile')
                    shutil.copy2(dockerfile,context/'Dockerfile.agent')
                    if component=='runtime':
                        # Fetch only public packages, with committed lock hashes. No deployment config.
                        run(['python3',str(sources['browser']/'scripts/build/fetch-runtime-assets.py'),
                             '--arch',architecture,'--output',str(ROOT/'output/runtime/packages')])
                        report['runtimeAssets'] = runtime_assets(ROOT, context, architecture)
                    (context/'.dockerignore').write_text('.git\nnode_modules\n.deployment\n.data\n.env\n.env.*\n' + ('' if component=='runtime' else 'output\n'))
                    image='agentic-browser-'+('service' if component=='browser' else component)+':'+args.tag+'-'+architecture
                    print(f'Building {component} for {target}; log: {directory/(component+".log")}',flush=True)
                    with (directory/(component+'.log')).open('w') as log:
                        # One platform per load works with both classic and containerd image stores.
                        # Native npm dependencies are built in the target architecture, never copied across.
                        run(['docker','buildx','build','--builder',builder,'--platform',target,'--load','--provenance=false',
                             '--progress','plain','--file',str(context/'Dockerfile.agent'),'--tag',image,
                             '--label','org.opencontainers.image.source=https://github.com/infrasika/agentic-browser',
                             '--label','org.opencontainers.image.revision='+revision,
                             '--label','dev.agentic-browser.librechat-revision='+lock['commit'],
                             '--label','dev.agentic-browser.librechat-tree='+lock['tree'],
                             '--build-arg','AB_REVISION='+revision,'--build-arg','AB_VERSION='+args.tag,
                             str(context)],stdout=log,stderr=subprocess.STDOUT)
                    info=json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]
                    if info['Os']+'/'+info['Architecture'] != target: raise ValueError('Built platform mismatch')
                    report['images'][component]={'tag':image,'id':info['Id']}
                    shutil.rmtree(context)
                report['passed']=True
            finally:
                (directory/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    finally:
        if not args.builder:
            subprocess.run(['docker','buildx','rm',builder],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        (work/'reports.json').write_text(json.dumps(reports,indent=2)+'\n')
        print(json.dumps({'directory':str(work),'reports':reports}))
    for component in ['source-browser','source-librechat']:
        shutil.rmtree(work/component,ignore_errors=True)

if __name__=='__main__': main()
