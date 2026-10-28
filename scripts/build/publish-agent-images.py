#!/usr/bin/env python3
"""Plan or publish a committed three-image build to GHCR using Docker's existing login.

Without --run this is local validation only: no credentials, login, pull or push.
Credentials stay in memory; macOS Docker credential helpers can use Keychain.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('package_agent', ROOT / 'scripts/build/package-agent.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
NAMES = {'agent': 'agentic-browser-agent', 'browser': 'agentic-browser-service', 'runtime': 'agentic-browser-runtime'}
ACCEPT = ', '.join(['application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json'])


def command(args, *, data=None, timeout=120):
    result = subprocess.run(args, input=data, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Credential helpers and registry errors must never echo secret values.
        raise ValueError('Command failed: ' + args[0] + '; check Docker access/login and network')
    return result.stdout


def inspect(ref):
    return json.loads(command(['docker', 'image', 'inspect', ref]))[0]


def credentials():
    config = Path(os.environ.get('DOCKER_CONFIG', str(Path.home() / '.docker'))) / 'config.json'
    data = json.loads(config.read_text()) if config.exists() else {}
    helper = data.get('credHelpers', {}).get('ghcr.io') or data.get('credsStore')
    if helper:
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', helper): raise ValueError('Invalid Docker credential helper')
        saved = json.loads(command(['docker-credential-' + helper, 'get'], data='ghcr.io\n'))
        username, secret = saved.get('Username'), saved.get('Secret')
    else:
        entry = data.get('auths', {}).get('ghcr.io', {})
        raw = base64.b64decode(entry.get('auth', ''), validate=True).decode()
        username, _, secret = raw.partition(':')
    if not username or not secret or username == '<token>':
        raise ValueError('GHCR login unavailable; use docker login ghcr.io with your existing credential store')
    return username, secret


class Registry:
    def __init__(self, login=None):
        self.login = login

    def manifest(self, repository, reference):
        query = urllib.parse.urlencode({'service': 'ghcr.io',
            'scope': 'repository:' + repository + (':pull,push' if self.login else ':pull')})
        headers = {}
        if self.login:
            headers['Authorization'] = 'Basic ' + base64.b64encode(':'.join(self.login).encode()).decode()
        try:
            request = urllib.request.Request('https://ghcr.io/token?' + query, headers=headers)
            with urllib.request.urlopen(request, timeout=30) as response:
                token = json.load(response)['token']
            request = urllib.request.Request('https://ghcr.io/v2/' + repository + '/manifests/' + reference,
                headers={'Authorization': 'Bearer ' + token, 'Accept': ACCEPT})
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024: raise ValueError('Registry manifest too large')
                digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
                if response.headers.get('Docker-Content-Digest') != digest:
                    raise ValueError('Registry manifest digest mismatch')
                return digest, json.loads(raw)
        except urllib.error.HTTPError as error:
            # Only an authenticated manifest 404 establishes tag absence. A
            # token endpoint error, denied access or network outage never does.
            if error.code == 404 and '/manifests/' in error.url: return None
            raise ValueError('GHCR request failed (HTTP ' + str(error.code) + '); tag availability is unknown') from None


def same_image(remote, local, registry, repository):
    digest, manifest = remote
    known = {local['Id'], *[ref.rsplit('@', 1)[-1] for ref in local.get('RepoDigests', [])]}
    if digest in known or manifest.get('config', {}).get('digest') == local['Id']: return True
    # Classic Docker stores the config digest; containerd may store an index.
    platforms = [item for item in manifest.get('manifests', [])
        if item.get('platform', {}).get('os') == 'linux' and item.get('platform', {}).get('architecture') == 'amd64']
    if len(platforms) != 1: return False
    child = registry.manifest(repository, platforms[0]['digest'])
    return bool(child and (child[0] in known or child[1].get('config', {}).get('digest') == local['Id']))


def plan(report, version, namespace):
    package.validate_report(report)
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?', version): raise ValueError('Version must be a fixed release tag')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', namespace): raise ValueError('Invalid GHCR namespace')
    head = command(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']).strip()
    package.validate_image_sources(report['sourceCommits']['browser'], head)
    images = {}
    for name, entry in report['images'].items():
        info = inspect(entry['id'])
        labels = info['Config'].get('Labels') or {}
        if info['Id'] != entry['id'] or (info['Os'], info['Architecture']) != ('linux', 'amd64'):
            raise ValueError('Build image identity/platform mismatch: ' + name)
        if labels.get('org.opencontainers.image.revision') != report['sourceCommits']['browser'] or labels.get('dev.agentic-browser.librechat-revision') != report['sourceCommits']['librechat']:
            raise ValueError('Build image source labels mismatch: ' + name)
        images[name] = {'id': entry['id'], 'target': 'ghcr.io/' + namespace + '/' + NAMES[name] + ':' + version}
    return {'version': version, 'namespace': namespace, 'sourceCommits': report['sourceCommits'],
        'toolCommit': head, 'images': images, 'infrastructure': package.INFRA, 'published': False}


def publish(prepared, registry, docker=command, image_info=inspect):
    originals = {name: image_info(item['id']) for name, item in prepared['images'].items()}
    existing = {}
    # Check every target before uploading anything; serialize publications for
    # the namespace externally as GHCR has no compare-and-swap tag operation.
    for name, item in prepared['images'].items():
        repository = item['target'].removeprefix('ghcr.io/').rsplit(':', 1)[0]
        remote = registry.manifest(repository, prepared['version'])
        if remote and not same_image(remote, originals[name], registry, repository):
            raise ValueError('Version tag already names another image: ' + name)
        existing[name] = remote
    refs = dict(prepared['infrastructure'])
    # Official dependencies are referenced, never re-published under our name.
    for ref in refs.values(): docker(['docker', 'pull', '--platform', 'linux/amd64', ref], timeout=900)
    receipts = {}
    for name, item in prepared['images'].items():
        target = item['target']; repository = target.removeprefix('ghcr.io/').rsplit(':', 1)[0]
        if not existing[name]:
            print('Publishing ' + target, flush=True)
            docker(['docker', 'tag', item['id'], target])
            docker(['docker', 'push', target], timeout=1800)
        remote = registry.manifest(repository, prepared['version'])
        if not remote or not same_image(remote, originals[name], registry, repository):
            raise ValueError('Published image does not match the accepted build: ' + name)
        ref = 'ghcr.io/' + repository + '@' + remote[0]
        docker(['docker', 'pull', '--platform', 'linux/amd64', ref], timeout=900)
        if image_info(ref)['Id'] != item['id']: raise ValueError('Pulled image identity mismatch: ' + name)
        refs[name] = ref
        receipts[name] = {**item, 'digest': remote[0], 'reference': ref}
    return {'version': prepared['version'], 'images': refs}, {**prepared, 'images': receipts,
        'published': True, 'anonymousPullVerified': False, 'independentHostVerified': False}


def verify_public(release, docker=command):
    if set(release.get('images', {})) != set(NAMES) | set(package.INFRA):
        raise ValueError('Six release images required')
    if any(release['images'][name] != ref for name, ref in package.INFRA.items()):
        raise ValueError('Unexpected infrastructure image')
    registry = Registry()
    for name in NAMES:
        ref = release['images'][name]
        if not re.fullmatch(r'ghcr\.io/[a-z0-9/-]+@sha256:[a-f0-9]{64}', ref): raise ValueError('Invalid GHCR digest reference')
        repository, digest = ref.removeprefix('ghcr.io/').split('@')
        remote = registry.manifest(repository, digest)
        if not remote or remote[0] != digest: raise ValueError('Anonymous manifest mismatch')
    # Docker honors its credential helper by default. An empty config proves
    # anonymous pull access even when the operator is already logged in.
    import tempfile
    host = os.environ.get('DOCKER_HOST') or command(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).strip()
    if not host.startswith('unix://'): raise ValueError('Anonymous verification requires a local Unix Docker socket')
    with tempfile.TemporaryDirectory(prefix='agent-anonymous-') as directory:
        for ref in release['images'].values():
            docker(['docker', '--config', directory, '--host', host, 'pull', '--platform', 'linux/amd64', ref], timeout=900)
    return {'version': release['version'], 'anonymousPullVerified': True, 'images': release['images']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-report', type=Path)
    parser.add_argument('--version')
    parser.add_argument('--namespace')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--run', action='store_true', help='Upload using the existing Docker GHCR login')
    parser.add_argument('--verify-public', type=Path, metavar='RELEASE_JSON', help='Verify anonymous access; no upload or credentials')
    args = parser.parse_args()
    if args.verify_public:
        if args.run: parser.error('--verify-public and --run are mutually exclusive')
        print(json.dumps(verify_public(json.loads(args.verify_public.read_text())), indent=2)); return
    if not args.build_report or not args.version or not args.namespace:
        parser.error('--build-report, --version and --namespace are required')
    prepared = plan(json.loads(args.build_report.read_text()), args.version, args.namespace)
    if not args.run:
        print(json.dumps({**prepared, 'dryRun': True, 'credentialsRead': False}, indent=2)); return
    if not args.output or args.output.exists(): parser.error('--output must be a new directory')
    release, receipt = publish(prepared, Registry(credentials()))
    args.output.mkdir(parents=True)
    for name, value in [('release.json', release), ('publication.json', receipt)]:
        (args.output / name).write_text(json.dumps(value, indent=2) + '\n')
    print(json.dumps({'published': True, 'output': str(args.output), 'anonymousPullVerified': False}))


if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, urllib.error.URLError) as error:
        # Deliberately exclude arbitrary subprocess/network response bodies.
        message = str(error) if type(error) is ValueError else type(error).__name__
        print('Publication failed: ' + message, file=sys.stderr)
        sys.exit(1)
