#!/usr/bin/env python3
"""Manage one private Agent installation. Requires Linux, Python 3 and Docker Compose."""
import argparse
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import time
import uuid
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
KIND = 'agentic-browser-installation-v1'
VOLUMES = ['browser-data', 'mongo-data', 'redis-data', 'uploads', 'images', 'logs']
SERVICES = ['mongo', 'redis', 'browser', 'agent', 'gateway']
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
BROWSER_IDLE = "const db=new(require('node:sqlite').DatabaseSync)('/data/scheduler.sqlite',{readOnly:true});const n=db.prepare(\"SELECT COUNT(*) n FROM leases WHERE state IN ('queued','starting','active','closing','cleanup_pending')\").get().n;const events=db.prepare(\"SELECT COUNT(*) n FROM events WHERE id>COALESCE((SELECT cursor FROM consumers WHERE name='librechat'),0)\").get().n;db.close();const records=require('fs').readdirSync('/data/runtimes').filter(n=>n.endsWith('.json')).length;console.log(JSON.stringify({idle:n===0&&events===0&&records===0,leases:n,events,records}));"

class Failure(Exception):
    pass

def run(args, *, data=None, timeout=120, binary=False):
    env = {key: os.environ[key] for key in ['PATH', 'HOME', 'TERM'] if key in os.environ}
    try:
        result = subprocess.run(args, input=data, capture_output=True, text=not binary,
                                timeout=timeout, env=env, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Failure('command_unavailable_or_timeout') from None
    if result.returncode:
        raise Failure('command_failed; check configuration, Docker access and service readiness')
    return result.stdout if binary else result.stdout.strip()

def private(path, directory=False):
    info = path.lstat()
    if path.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise Failure('private_path_permissions_required')
    if directory and not stat.S_ISDIR(info.st_mode) or not directory and not stat.S_ISREG(info.st_mode):
        raise Failure('invalid_private_path')

def read_json(path):
    private(path)
    return json.loads(path.read_text())

def atomic(path, value):
    if path.exists() or path.is_symlink(): private(path)
    pending = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    try:
        with pending.open('x') as handle:
            os.chmod(pending, 0o600)
            handle.write(value if isinstance(value, str) else json.dumps(value, indent=2) + '\n')
            handle.flush(); os.fsync(handle.fileno())
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def release_file(path, development=False):
    value = json.loads(path.read_text())
    if set(value) != {'version', 'images'} or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', value['version']):
        raise Failure('invalid_release_manifest')
    required = {'agent', 'browser', 'runtime', 'gateway', 'mongo', 'redis'}
    if set(value['images']) != required: raise Failure('invalid_release_images')
    for ref in value['images'].values():
        if not isinstance(ref, str) or not (re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}', ref) or development and re.fullmatch(r'sha256:[a-f0-9]{64}', ref)):
            raise Failure('immutable_release_images_required')
    return value

def host_platform():
    architecture = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(os.uname().machine)
    if not sys.platform.startswith('linux') or not architecture: raise Failure('supported_linux_host_required')
    return 'linux/' + architecture


def pull_images(release):
    platform = host_platform()
    for ref in release['images'].values():
        if '@sha256:' in ref: run(DOCKER + ['pull', '--platform', platform, ref], timeout=900)
        try: run(DOCKER + ['image', 'inspect', ref])
        except Failure: run(DOCKER + ['pull', ref], timeout=900)
        info = json.loads(run(DOCKER + ['image', 'inspect', ref]))[0]
        if info['Os'] + '/' + info['Architecture'] != platform: raise Failure('host_image_architecture_mismatch')

def transfer_volume(image, volume, project, archive, restore=False):
    name = project + '-archive-' + uuid.uuid4().hex[:12]
    args = DOCKER + ['run', '--rm', '--name', name, '--label', 'dev.agentic-browser.operation=' + project,
        '--network=none', '--read-only', '--user=0:0', '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE',
        '--security-opt=no-new-privileges', '--memory=256m', '--cpus=1']
    if restore: args += ['-i', '--cap-add=CHOWN', '--cap-add=FOWNER']
    args += ['--mount', f'type=volume,src={volume},dst=/volume' + ('' if restore else ',readonly'), '--entrypoint=tar', image,
             '--numeric-owner', *(['--same-owner', '-xzf'] if restore else ['-czf']), '-', '-C', '/volume', *([] if restore else ['.'])]
    try:
        result = subprocess.run(args, stdin=archive if restore else subprocess.DEVNULL,
            stdout=subprocess.PIPE if restore else archive, stderr=subprocess.PIPE, timeout=300)
        if result.returncode: raise Failure('volume_transfer_failed')
    except subprocess.TimeoutExpired: raise Failure('volume_transfer_timeout') from None
    finally:
        # A timed-out Docker client does not itself stop the helper container.
        try: run(DOCKER + ['rm', '-f', name], timeout=30)
        except Failure: pass

class Installation:
    def __init__(self, directory):
        self.root = directory.resolve()
        if directory.absolute() != self.root: raise Failure('installation_symlinks_not_allowed')
        private(self.root, True)
        self.meta = read_json(self.root / 'installation.json')
        if self.meta.get('kind') != KIND or not re.fullmatch(r'agent-[a-f0-9]{12}', self.meta.get('project', '')):
            raise Failure('invalid_installation')
        if (self.meta['uid'], self.meta['gid']) != (os.getuid(), os.getgid()): raise Failure('installation_owner_changed')
        self.release = read_json(self.root / 'release.json')
        self.gate = self.root / 'state/maintenance/active'
        self.intent = self.root / 'state/operation.json'

    def compose(self, args, **kwargs):
        return run(DOCKER + ['compose', '--project-directory', str(self.root), '--env-file', str(self.root / '.env'),
                   '-p', self.meta['project'], '-f', str(self.root / 'compose.yaml'), *args], **kwargs)

    def config(self, action):
        return json.loads(run(DOCKER + ['run', '--rm', '--network=none', '--user', f"{self.meta['uid']}:{self.meta['gid']}",
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m',
            '--volume', str(self.root / 'config') + ':/config', '--entrypoint', 'node', self.release['images']['agent'],
            '/app/selfhost/init.mjs', action, '/config']))

    def render(self):
        storage_directory(self.root)
        result = self.config('render')
        images = self.release['images']
        values = {'AGENT_PROJECT': self.meta['project'], 'AGENT_UID': self.meta['uid'], 'AGENT_GID': self.meta['gid'],
            'DOCKER_GID': Path('/var/run/docker.sock').stat().st_gid, 'AGENT_PORT': self.meta['port'],
            'AGENT_ORIGIN': result['origin'], 'BROWSER_MAX_SESSIONS': result['maximum'],
            'AGENT_DATA_DIR': str(self.root / 'data'),
            **{k.upper() + '_IMAGE': v for k, v in images.items()}}
        atomic(self.root / '.env', ''.join(f'{key}={value}\n' for key, value in values.items()))
        self.compose(['config', '--quiet'])
        return result

    def up(self):
        if self.intent.exists() or self.gate.exists(): raise Failure('maintenance_pending; run recover after inspecting status')
        applied = self.root / 'state/applied.json'
        if applied.exists() and read_json(applied) != self.fingerprint():
            raise Failure('configuration_changed; use apply during idle time')
        self.render()
        try: self.compose(['up', '-d', '--wait', '--wait-timeout', '240'], timeout=300)
        except Failure: raise Failure('compose_start_failed; inspect local compose ps and logs') from None
        self.doctor()
        atomic(applied, self.fingerprint())

    def fingerprint(self):
        files = ['settings.json', 'secrets.env', 'browser-token', 'smtp-verified.json']
        return {name: digest(self.root / 'config' / name) for name in files if (self.root / 'config' / name).exists()}

    def doctor(self):
        result = self.config('check')
        raw = self.compose(['ps', '--all', '--format', 'json'])
        rows = json.loads(raw) if raw.startswith('[') else [json.loads(row) for row in raw.splitlines() if row]
        by_name = {row['Service']: row for row in rows}
        if any(by_name.get(name, {}).get('State') != 'running' for name in SERVICES): raise Failure('services_not_running')
        for name in ['agent', 'browser', 'mongo', 'redis']:
            if by_name[name].get('Health') != 'healthy': raise Failure('service_unhealthy')
        # Service DNS is verified inside the private network; external TLS is operator-owned.
        configured = json.loads(self.compose(['config', '--format', 'json']))
        running_origin = configured['services']['browser']['environment']['DOMAIN_CLIENT']
        for attempt in range(6):
            try:
                self.compose(['exec', '-T', 'agent', 'node', '-e', "const q=require('http').get('http://gateway:8080/api/config',{headers:{Host:" + json.dumps(urlsplit(running_origin).netloc) + "}},r=>{r.resume();process.exit(r.statusCode===200?0:1)});q.setTimeout(5000,()=>q.destroy());q.on('error',()=>process.exit(1));"])
                break
            except Failure:
                if attempt == 5: raise Failure('gateway_http_not_ready') from None
                time.sleep(1)
        return {'healthy': True, 'maintenance': self.gate.exists(), 'origin': result['origin'], 'maximum': result['maximum']}

    def idle(self, drain=False):
        browser = json.loads(self.compose(['exec', '-T', 'browser', 'node', '-e', BROWSER_IDLE]))
        agent = json.loads(self.compose(['exec', '-T', 'agent', 'node', '/app/selfhost/idle.mjs']))
        return browser['idle'] and agent['idle'] and (not drain or agent['connections'] == 0)

    def stop_clean(self, service):
        self.compose(['stop', '-t', '60', service], timeout=75)
        cid = self.compose(['ps', '--all', '-q', service])
        state = json.loads(run(DOCKER + ['inspect', cid]))[0]['State']
        if state['Running'] or state['OOMKilled'] or state['ExitCode'] not in [0, 143]: raise Failure('service_did_not_stop_cleanly')

    def enter(self, operation):
        if self.intent.exists() or self.gate.exists(): raise Failure('maintenance_pending')
        self.doctor()
        if not self.idle(): raise Failure('busy; retry after all tasks finish')
        atomic(self.intent, {'kind': KIND, 'operation': operation, 'phase': 'drain'})
        atomic(self.gate, 'maintenance\n')
        origin = json.loads(self.compose(['config', '--format', 'json']))['services']['browser']['environment']['DOMAIN_CLIENT']
        self.compose(['exec', '-T', 'agent', 'node', '-e', "const q=require('http').get('http://gateway:8080/api/config',{headers:{Host:" + json.dumps(urlsplit(origin).netloc) + "}},r=>{r.resume();process.exit(r.statusCode===503&&r.headers['x-agent-maintenance']==='1'?0:1)});q.setTimeout(5000,()=>q.destroy());q.on('error',()=>process.exit(1));"])
        deadline = time.monotonic() + 30
        while not self.idle(drain=True):
            if time.monotonic() > deadline:
                self.gate.unlink(); self.intent.unlink(); raise Failure('busy_or_inflight_requests; retry later')
            time.sleep(0.5)
        atomic(self.intent, {'kind': KIND, 'operation': operation, 'phase': 'stopping'})
        for name in ['agent', 'browser', 'redis', 'mongo']: self.stop_clean(name)

    def recover(self):
        if not self.intent.exists():
            if self.gate.exists(): raise Failure('orphan_maintenance_gate')
            return {'status': 'nothing_to_recover'}
        state = read_json(self.intent)
        if state.get('kind') != KIND: raise Failure('invalid_operation_state')
        if state.get('phase') in ['upgrading', 'upgrade_failed']:
            raise Failure('upgrade_incomplete; restore pre-upgrade backup into a fresh installation')
        if state.get('phase') in ['restoring', 'restore_failed']:
            raise Failure('incomplete_restore; use a fresh target')
        if state.get('operation') == 'restore' and state.get('phase') == 'ready':
            self.render()
        # A killed Docker client can leave its archive helper alive. Remove only
        # this installation's operation helpers before restarting volume writers.
        helpers = run(DOCKER + ['ps', '-aq', '--filter', 'label=dev.agentic-browser.operation=' + self.meta['project']]).split()
        if helpers: run(DOCKER + ['rm', '-f', *helpers])
        self.compose(['up', '-d', '--wait', '--wait-timeout', '240'], timeout=300)
        # Healthchecks must pass before visitors are admitted.
        self.gate.unlink(missing_ok=True)
        try: self.doctor()
        except BaseException:
            atomic(self.gate, 'maintenance\n'); raise
        self.intent.unlink()
        atomic(self.root / 'state/applied.json', self.fingerprint())
        return {'status': 'services_recovered'}

    def volume_names(self):
        config = json.loads(self.compose(['config', '--format', 'json']))
        names = {key: config['volumes'][key]['name'] for key in VOLUMES}
        for name in names.values():
            value = json.loads(run(DOCKER + ['volume', 'inspect', name]))[0]
            if value.get('Labels', {}).get('com.docker.compose.project') != self.meta['project']: raise Failure('volume_ownership_mismatch')
        return names

    def archive(self, destination):
        names = self.volume_names()
        for key, name in names.items():
            target = destination / (key + '.tar.gz')
            # No network or Docker socket; the helper can see only this one volume.
            with target.open('xb') as output:
                transfer_volume(self.release['images']['agent'], name, self.meta['project'], output)
        for name in ['settings.json', 'secrets.env', 'browser-token']:
            private(self.root / 'config' / name)
            shutil.copyfile(self.root / 'config' / name, destination / name)
        if (self.root / 'config/smtp-verified.json').exists(): shutil.copyfile(self.root / 'config/smtp-verified.json', destination / 'smtp-verified.json')
        if (self.root / 'config/backup.json').exists(): shutil.copyfile(self.root / 'config/backup.json', destination / 'backup.json')
        shutil.copyfile(self.root / 'release.json', destination / 'release.json')
        shutil.copyfile(self.root / 'compose.yaml', destination / 'compose.yaml')
        files = {p.name: digest(p) for p in destination.iterdir() if p.is_file()}
        atomic(destination / 'manifest.json', {'kind': KIND, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'uid': self.meta['uid'], 'gid': self.meta['gid'], 'release': self.release, 'files': files})

    def backup(self, stay=False):
        folder = self.root / 'backups'; folder.mkdir(mode=0o700, exist_ok=True)
        name = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
        pending = folder / ('.pending-' + name); pending.mkdir(mode=0o700)
        completed = False
        try:
            self.enter('upgrade' if stay else 'backup')
            self.archive(pending)
            verify_backup(pending)
            complete = folder / name; pending.rename(complete)
            completed = True
            return complete
        finally:
            if (not stay or not completed) and self.intent.exists(): self.recover()

    def operator(self, action, value):
        if self.gate.exists() or self.intent.exists(): raise Failure('maintenance_pending')
        output = self.compose(['exec', '-T', 'agent', 'node', '/app/selfhost/operator.mjs', action], data=json.dumps(value), timeout=90)
        line = next((row for row in output.splitlines() if row.startswith('AGENT_RESULT=')), None)
        if not line: raise Failure('missing_operator_result')
        result = json.loads(line.split('=', 1)[1])
        if action == 'mail-test': atomic(self.root / 'config/smtp-verified.json', result)
        return result

    def upgrade(self, release_path, development):
        target = release_file(release_path, development)
        template = (Path(__file__).resolve().parent / 'compose.yaml').read_text()
        pull_images(target)
        previous = self.backup(stay=True)
        try:
            atomic(self.intent, {'kind': KIND, 'operation': 'upgrade', 'phase': 'upgrading', 'backup': str(previous)})
            atomic(self.root / 'release.json', target); self.release = target
            atomic(self.root / 'compose.yaml', template)
            self.render()
            self.compose(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '240'], timeout=300)
            self.gate.unlink(); self.doctor(); self.intent.unlink()
            atomic(self.root / 'state/applied.json', self.fingerprint())
            install_tools(self.root)
            return {'status': 'upgraded', 'backup': str(previous), 'version': target['version']}
        except BaseException:
            atomic(self.gate, 'maintenance\n')
            atomic(self.intent, {'kind': KIND, 'operation': 'upgrade', 'phase': 'upgrade_failed', 'backup': str(previous)})
            raise Failure('upgrade_failed; maintenance retained; restore the pre-upgrade backup into a fresh installation') from None

def verify_backup(path):
    private(path, True)
    manifest = read_json(path / 'manifest.json')
    required = {key + '.tar.gz' for key in VOLUMES} | {'settings.json', 'secrets.env', 'browser-token', 'release.json', 'compose.yaml'}
    if manifest.get('kind') != KIND or not required.issubset(manifest.get('files', {})) or set(manifest['files']) - required - {'smtp-verified.json', 'backup.json'}:
        raise Failure('invalid_backup_manifest')
    for name, sha in manifest['files'].items():
        file = path / name; private(file)
        if digest(file) != sha: raise Failure('backup_checksum_mismatch')
        if name.endswith('.tar.gz'):
            with tarfile.open(file, 'r:gz') as archive:
                for entry in archive:
                    p = PurePosixPath(entry.name)
                    if p.is_absolute() or '..' in p.parts or not (entry.isfile() or entry.isdir()):
                        raise Failure('unsafe_backup_archive_entry')
                    if name == 'browser-data.tar.gz' and len(p.parts) == 2 and p.parts[0] == 'runtimes' and p.suffix == '.json':
                        raise Failure('backup_contains_runtime_records')
    return manifest

def install_tools(directory):
    source = Path(__file__).resolve().parent
    for name in ['agentctl.py', 'maintenance.py']:
        atomic(directory / name, (source / name).read_text())

def storage_directory(root, create=False):
    """A missing/moved data directory must never silently start an empty database."""
    directory = root / 'data'
    if create:
        directory.mkdir(mode=0o700)
        for name in VOLUMES: (directory / name).mkdir(mode=0o700)
    private(directory, True)
    for name in VOLUMES:
        child = directory / name
        if child.is_symlink() or not child.is_dir(): raise Failure('storage_directory_missing_or_unsafe')
    return directory


def initialize(directory, release_path, port, development=False):
    if not 1024 <= port <= 65535: raise Failure('invalid_loopback_port')
    host_platform()
    if directory.exists(): raise Failure('installation_directory_already_exists')
    if directory.absolute() != directory.resolve(): raise Failure('installation_symlinks_not_allowed')
    if any(char in str(directory) for char in [',', '\n', '\r', '$', '#', "'", '"', '\\']): raise Failure('unsupported_installation_path')
    try:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))
    except OSError: raise Failure('loopback_port_unavailable') from None
    release = release_file(release_path, development); pull_images(release)
    run(DOCKER + ['compose', 'version'])
    # Volume subpaths need Docker Engine 26 or newer.
    version = json.loads(run(DOCKER + ['version', '--format', '{{json .Server}}']))
    if int(version['Version'].split('.')[0]) < 26: raise Failure('docker_engine_26_required')
    directory.mkdir(mode=0o700, parents=True)
    for name in ['config', 'state', 'state/maintenance']: (directory / name).mkdir(mode=0o700)
    storage_directory(directory, create=True)
    source = Path(__file__).resolve().parent
    shutil.copyfile(source / 'compose.yaml', directory / 'compose.yaml')
    install_tools(directory)
    meta = {'kind': KIND, 'project': 'agent-' + uuid.uuid4().hex[:12], 'uid': os.getuid(), 'gid': os.getgid(), 'port': port}
    atomic(directory / 'installation.json', meta); atomic(directory / 'release.json', release)
    run(DOCKER + ['run', '--rm', '--network=none', '--user', f'{os.getuid()}:{os.getgid()}', '--read-only', '--cap-drop=ALL',
        '--volume', str(directory / 'config') + ':/config', '--entrypoint=node', release['images']['agent'], '/app/selfhost/init.mjs', 'init', '/config'])
    settings = read_json(directory / 'config/settings.json'); settings['origin'] = f'http://127.0.0.1:{port}'
    atomic(directory / 'config/settings.json', settings)
    return {'status': 'initialized', 'directory': str(directory), 'next': 'Edit config/settings.json and config/secrets.env once, then run up.'}

def restore(source, directory, port, development):
    manifest = verify_backup(source)
    if (manifest['uid'], manifest['gid']) != (os.getuid(), os.getgid()): raise Failure('restore_requires_same_numeric_uid_gid')
    initialize(directory, source / 'release.json', port, development)
    install = Installation(directory)
    # Use this installer's topology: its storage paths resolve inside the new
    # installation, never the source host's mounts. The archived file is audit evidence.
    for name in ['settings.json', 'secrets.env', 'browser-token', 'smtp-verified.json']:
        if (source / name).exists(): atomic(directory / 'config' / name, (source / name).read_text())
    # A clone starts on a new loopback origin. Reconfigure HTTPS/mail after verification.
    settings = read_json(directory / 'config/settings.json')
    settings['origin'] = f'http://127.0.0.1:{port}'; settings['registration'] = 'closed'; settings['turnstileSiteKey'] = ''
    settings.pop('trustedProxyIPs', None)
    atomic(directory / 'config/settings.json', settings)
    secrets = (directory / 'config/secrets.env').read_text()
    secrets = re.sub(r'^TURNSTILE_SECRET_KEY=.*$', 'TURNSTILE_SECRET_KEY=', secrets, flags=re.M)
    atomic(directory / 'config/secrets.env', secrets)
    install.render()
    atomic(install.gate, 'maintenance\n')
    atomic(install.intent, {'kind': KIND, 'operation': 'restore', 'phase': 'restoring'})
    install.compose(['create'], timeout=120)
    names = install.volume_names()
    try:
        for key, name in names.items():
            with (source / (key + '.tar.gz')).open('rb') as archive:
                transfer_volume(install.release['images']['agent'], name, install.meta['project'], archive, restore=True)
        run(DOCKER + ['run', '--rm', '--network=none', '--read-only', '--user', f'{os.getuid()}:{os.getgid()}',
            '--cap-drop=ALL', '--mount', f"type=volume,src={names['browser-data']},dst=/volume", '--entrypoint=node',
            install.release['images']['agent'], '-e', "require('fs').writeFileSync('/volume/runtimes/instance-id',require('crypto').randomUUID(),{mode:0o600})"])
        atomic(install.intent, {'kind': KIND, 'operation': 'restore', 'phase': 'ready'})
        # Do not start applications or repeat old web work until the operator runs recover.
        return {'status': 'restored_stopped', 'directory': str(directory), 'next': 'Review configuration, then run recover.'}
    except BaseException:
        atomic(install.intent, {'kind': KIND, 'operation': 'restore', 'phase': 'restore_failed'})
        raise

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init'); init.add_argument('--release', type=Path, required=True); init.add_argument('--port', type=int, default=3333); init.add_argument('--development', action='store_true')
    for name in ['up', 'doctor', 'backup', 'recover', 'apply']: sub.add_parser(name)
    sub.add_parser('maintain')
    sub.add_parser('maintenance-status')
    schedule = sub.add_parser('schedule')
    schedule.add_argument('--timezone', default='UTC')
    schedule.add_argument('--hour', type=int, default=4)
    schedule.add_argument('--keep', type=int, default=7)
    schedule.add_argument('--retry-minutes', type=int, default=60)
    schedule.add_argument('--copy-to', type=Path)
    for name in ['user-create', 'user-reset']:
        child = sub.add_parser(name); child.add_argument('--input-file', type=Path)
    mail = sub.add_parser('mail-test'); mail.add_argument('--to', required=True)
    upgrade = sub.add_parser('upgrade'); upgrade.add_argument('--release', type=Path, required=True); upgrade.add_argument('--development', action='store_true')
    backup = sub.add_parser('verify-backup'); backup.add_argument('backup', type=Path)
    restored = sub.add_parser('restore'); restored.add_argument('backup', type=Path); restored.add_argument('--port', type=int, default=3333); restored.add_argument('--development', action='store_true')
    args = parser.parse_args(); directory = args.directory.absolute()
    for sig in [signal.SIGTERM, signal.SIGINT]: signal.signal(sig, lambda *_: (_ for _ in ()).throw(Failure('interrupted; use recover if maintenance remains')))
    if args.command == 'init': result = initialize(directory, args.release, args.port, args.development)
    elif args.command == 'restore': result = restore(args.backup.absolute(), directory, args.port, args.development)
    elif args.command == 'verify-backup': verify_backup(args.backup.absolute()); result = {'verified': True}
    else:
        install = Installation(directory)
        with (directory / 'state/lock').open('a') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                if args.command == 'maintain': print(json.dumps({'status': 'operation_in_progress'})); return
                raise Failure('operation_in_progress; retry later') from None
            if args.command == 'up': install.up(); result = {'status': 'running'}
            elif args.command in ['schedule', 'maintain', 'maintenance-status']:
                import maintenance
                if args.command == 'schedule': result = maintenance.configure(install, args)
                elif args.command == 'maintain': result = maintenance.tick(install)
                else: result = maintenance.status(install)
            elif args.command == 'doctor': result = install.doctor()
            elif args.command == 'recover':
                if install.intent.exists() and read_json(install.intent).get('phase') in ['restoring', 'restore_failed']: raise Failure('incomplete_restore; use a fresh target')
                result = install.recover()
            elif args.command == 'backup': result = {'backup': str(install.backup())}
            elif args.command == 'apply': result = install.upgrade(directory / 'release.json', True)
            elif args.command == 'upgrade': result = install.upgrade(args.release, args.development)
            elif args.command == 'mail-test': result = install.operator('mail-test', {'to': args.to}); result = {'accepted': result['accepted'], 'next': 'Run apply during idle time to enable password recovery. Verify inbox delivery separately.'}
            else:
                if args.input_file: value = read_json(args.input_file)
                else:
                    value = {'email': input('Email: ').strip()}
                    if args.command == 'user-create': value.update(name=input('Name: ').strip(), username=input('Username: ').strip())
                    value['password'] = getpass.getpass('New password (12+ characters): ')
                    if value['password'] != getpass.getpass('Repeat password: '): raise Failure('password_mismatch')
                result = install.operator(args.command, value)
    print(json.dumps(result))

if __name__ == '__main__':
    # The maintenance module shares this exact Failure type when run as a script.
    sys.modules['agentctl'] = sys.modules[__name__]
    try: main()
    except Failure as error: print(str(error), file=sys.stderr); sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError): print('Operation failed; check private file permissions, manifest and configuration. No secret values were logged.', file=sys.stderr); sys.exit(1)
