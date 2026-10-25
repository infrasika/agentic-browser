#!/usr/bin/env python3
"""Idle-only, application-quiesced backups. No production restore command.

Run under the supplied systemd unit. ExecStopPost replays only service recovery
after a killed process; it never restores data or resumes a browser action.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
KIND = 'librechat-scheduled-backup-v1'
NAME = re.compile(r'^auto-\d{8}T\d{6}Z-[a-f0-9]{8}$')
SERVICES = ('agentic-browser-service', 'librechat-browser-demo')


class BackupError(Exception):
    """Only fixed error codes may be exposed to the journal/report."""


def now():
    return datetime.now(timezone.utc).isoformat()


def private_json(path):
    if path.resolve() != path or path.is_symlink():
        raise BackupError('unsafe_path')
    with path.open('r') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise BackupError('unsafe_file')
        return json.load(handle)


def write_json(path, value):
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    try:
        with temporary.open('x') as handle:
            os.chmod(temporary, 0o600)
            json.dump(value, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def sha256(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def completed_backups(directory):
    result = []
    for path in directory.iterdir():
        if not NAME.fullmatch(path.name) or path.is_symlink() or not path.is_dir():
            continue
        try:
            manifest = private_json(path / 'manifest.json')
            if manifest.get('kind') != KIND or manifest.get('complete') is not True:
                continue
            datetime.fromisoformat(manifest['createdAt'])
            result.append((path, manifest))
        except (OSError, ValueError, KeyError, BackupError):
            continue
    return sorted(result, key=lambda item: item[1]['createdAt'], reverse=True)


def prune_backups(directory, keep, protected):
    if not 2 <= keep <= 31:
        raise BackupError('invalid_retention')
    deleted = 0
    for path, _ in completed_backups(directory)[keep:]:
        if path == protected or path.resolve() != path:
            continue
        # Only our explicitly tagged, complete automatic snapshots are eligible.
        shutil.rmtree(path)
        deleted += 1
    return deleted


class Backup:
    def __init__(self, root=ROOT, runtime=Path('/run/librechat-backup')):
        self.root, self.runtime = root, runtime
        self.checkout = root.parent / 'librechat-agent'
        self.private = root / '.deployment/librechat'
        self.backups = self.private / 'backups'
        self.state_path = runtime / 'state.json'
        self.gate = runtime / 'maintenance'
        self.report = {'startedAt': now(), 'status': 'failed', 'stage': 'preflight'}
        self.config = json.loads((root / 'deploy/librechat/backup.json').read_text())
        if (self.config['timeZone'] != 'Asia/Shanghai' or self.config['startHour'] != 4 or
                not 1 <= self.config['drainTimeoutSeconds'] <= 30 or
                not 2 <= self.config['keep'] <= 31 or self.config['minimumDiskMiB'] < 1024 or
                self.config['minimumMemoryMiB'] < 3072):
            raise BackupError('invalid_policy')

    def command(self, args, timeout=15, output=None, cwd=None):
        try:
            result = subprocess.run(args, cwd=cwd or self.root, timeout=timeout, check=True,
                                    stdout=output if output is not None else subprocess.PIPE,
                                    stderr=subprocess.DEVNULL)
            return result.stdout.decode().strip() if output is None else ''
        except (OSError, subprocess.SubprocessError):
            raise BackupError('command_failed') from None

    def stage(self, name):
        self.report['stage'] = name

    def active(self, service):
        return self.command(['systemctl', 'show', service, '--property=ActiveState', '--value']) == 'active'

    def stopped_cleanly(self, service):
        state = self.command(['systemctl', 'show', service, '--property=ActiveState,Result'])
        return dict(line.split('=', 1) for line in state.splitlines()) == {'ActiveState': 'inactive', 'Result': 'success'}

    def idle(self):
        path = self.root / '.data/librechat-browser/scheduler.sqlite'
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
            count = db.execute("SELECT COUNT(*) FROM leases WHERE state IN ('queued','starting','active','closing','cleanup_pending')").fetchone()[0]
            delayed = db.execute("SELECT COUNT(*) FROM events WHERE id > COALESCE((SELECT cursor FROM consumers WHERE name='librechat'),0)").fetchone()[0]
        tasks = json.loads(self.command(['node', 'scripts/librechat-backup-state.mjs']))
        return count == 0 and delayed == 0 and tasks['idle'] is True

    def readiness(self):
        try:
            for url in ['http://127.0.0.1:8081/health', 'http://127.0.0.1:8082/health', 'http://127.0.0.1:3080/api/config']:
                with urllib.request.urlopen(url, timeout=2) as response:
                    value = json.load(response)
                    if response.status != 200 or not isinstance(value, dict):
                        return False
                    if url.endswith('/health') and value.get('status') != 'ok':
                        return False
            return True
        except (OSError, ValueError):
            return False

    def maintenance_response(self):
        request = urllib.request.Request('http://127.0.0.1/api/config', headers={'Host': 'agentic-browser.zkpass.org'})
        try:
            urllib.request.urlopen(request, timeout=3).close()
        except urllib.error.HTTPError as error:
            return error.code == 503 and error.headers.get('X-Browser-Demo-Maintenance') == '1'
        return False

    def drain_requests(self):
        # The proxy uses Connection: close for ordinary HTTP. After gating new
        # requests, wait for old upstream requests to finish as well as jobs.
        # This covers requests that started before the gate but haven't yet
        # registered their generation. An open connection causes a safe defer.
        deadline = time.monotonic() + self.config['drainTimeoutSeconds']
        while True:
            if not self.idle():
                return False
            connections = self.command(['ss', '-Htn', 'state', 'established', '( sport = :3080 )'])
            if not connections:
                return self.idle()
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.25)

    def recover(self):
        if not self.state_path.exists():
            if self.gate.exists():
                raise BackupError('orphan_maintenance_gate')
            return
        state = private_json(self.state_path)
        if state.get('kind') != KIND or not re.fullmatch(r'[a-f0-9]{32}', state.get('id', '')):
            raise BackupError('invalid_recovery_state')
        if self.gate.exists() and self.gate.read_text() != state['id']:
            raise BackupError('maintenance_owner_mismatch')
        # Write intent before stopping: recovery also covers a kill in systemctl.
        for service in SERVICES:
            if state.get(service) is True:
                self.command(['sudo', '-n', 'systemctl', 'start', service], timeout=95)
        deadline = time.monotonic() + 45
        while not self.readiness():
            if time.monotonic() >= deadline:
                raise BackupError('service_recovery_failed')
            time.sleep(1)
        self.gate.unlink(missing_ok=True)
        self.state_path.unlink()

    def tar(self, destination, entries):
        with tarfile.open(destination, 'w:gz', compresslevel=1, dereference=False) as archive:
            for source, name in entries:
                if source.is_symlink():
                    raise BackupError('symlink_backup_source')
                if source.exists():
                    archive.add(source, arcname=name)
        os.chmod(destination, 0o600)

    def prepare(self, pending):
        self.stage('prepare_static_files')
        # No live process is paused while compressing source/build artifacts.
        for repository, name in [(self.root, 'browser-source'), (self.checkout, 'librechat-source')]:
            with (pending / (name + '.tar.gz')).open('xb') as output:
                self.command(['git', 'archive', '--format=tar.gz', 'HEAD'], output=output, cwd=repository, timeout=60)
        entries = [(self.checkout / 'client/dist', 'client/dist')]
        entries.extend((self.checkout / 'packages' / name / 'dist', 'packages/' + name + '/dist')
                       for name in ['api', 'data-schemas', 'data-provider'])
        if any(not source.is_dir() for source, _ in entries):
            raise BackupError('missing_build_artifact')
        self.tar(pending / 'librechat-build.tar.gz', entries)

    def capture(self, pending):
        self.stage('capture_data')
        with (pending / 'production-mongo.archive.gz').open('xb') as output:
            self.command(['docker', 'exec', 'librechat-browser-demo-mongo-1', 'mongodump',
                          '--db=LibreChatBrowserDemo', '--archive', '--gzip'], timeout=60, output=output)
        redis_file = '/tmp/librechat-backup-' + uuid.uuid4().hex + '.rdb'
        try:
            self.command(['docker', 'exec', 'librechat-browser-demo-redis-1', 'redis-cli', '--rdb', redis_file], timeout=30)
            self.command(['docker', 'exec', 'librechat-browser-demo-redis-1', 'redis-check-rdb', redis_file], timeout=15)
            self.command(['docker', 'cp', 'librechat-browser-demo-redis-1:' + redis_file, str(pending / 'production-redis.rdb')])
            os.chmod(pending / 'production-redis.rdb', 0o600)
        finally:
            self.command(['docker', 'exec', 'librechat-browser-demo-redis-1', 'rm', '-f', redis_file])
        source = sqlite3.connect((self.root / '.data/librechat-browser/scheduler.sqlite').as_uri() + '?mode=ro', uri=True)
        target = sqlite3.connect(pending / 'browser-ledger.sqlite')
        try:
            source.backup(target)
            if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise BackupError('sqlite_integrity')
        finally:
            target.close()
            source.close()
        config_names = ['private.env', 'production.env', 'production.yaml', 'acceptance.env', 'acceptance.yaml', 'mail-verified.json', 'release.json']
        if any(not (self.private / name).is_file() for name in ['private.env', 'production.env', 'production.yaml']):
            raise BackupError('missing_configuration')
        entries = [(self.private / name, 'configuration/' + name) for name in config_names]
        entries.extend([(self.root / '.data/librechat-browser/runtimes', 'browser/runtimes'),
                        (self.checkout / 'uploads', 'librechat/uploads'),
                        (self.checkout / 'client/public/images', 'librechat/client/public/images'),
                        (Path('/etc/nginx/conf.d/agentic-browser.conf'), 'nginx/agentic-browser.conf')])
        self.tar(pending / 'configuration-and-files.tar.gz', entries)
        for service in SERVICES:
            (pending / (service + '.service')).write_text(self.command(['systemctl', 'cat', service]))
        self.report['dataCapturedAt'] = now()

    def quiesce_and_capture(self, pending):
        state = {'kind': KIND, 'id': uuid.uuid4().hex, **{service: False for service in SERVICES}}
        write_json(self.state_path, state)
        try:
            with self.gate.open('x') as handle:
                handle.write(state['id'])
                handle.flush()
                os.fchmod(handle.fileno(), 0o644)
            self.stage('maintenance_admission')
            if not self.maintenance_response():
                raise BackupError('maintenance_not_effective')
            if not self.drain_requests():
                self.report['status'] = 'deferred_busy'
                return False
            self.stage('stop_writers')
            for service in reversed(SERVICES):
                state[service] = True
                write_json(self.state_path, state)
                self.command(['sudo', '-n', 'systemctl', 'stop', service], timeout=95)
                if not self.stopped_cleanly(service):
                    raise BackupError('service_not_stopped')
            if not self.idle():
                raise BackupError('state_changed_during_drain')
            self.capture(pending)
            return True
        finally:
            start = time.monotonic()
            self.recover()
            self.report['servicesRecovered'] = True
            self.report['recoverySeconds'] = round(time.monotonic() - start, 2)

    def verify(self, path):
        self.stage('verify_mongo_restore')
        self.command(['node', '--import', 'tsx', 'scripts/verify-librechat-backup.ts', '--run', path.name], timeout=120)
        evidence = private_json(self.root / 'output/librechat/backup-restore-latest.json')
        if not evidence.get('passed') or evidence.get('archiveSHA256') != sha256(path / 'production-mongo.archive.gz'):
            raise BackupError('restore_verification_failed')
        self.report['mongoRestoreVerified'] = True

    def run(self, scheduled=False):
        self.recover()
        local = datetime.now(ZoneInfo(self.config['timeZone']))
        if scheduled and local.hour < self.config['startHour']:
            self.report['status'] = 'outside_window'
            return
        complete = completed_backups(self.backups)
        existing = next((path for path, data in complete if data.get('localDate') == local.date().isoformat()), None)
        if existing:
            self.report.update(status='already_completed', backup=existing.name)
            evidence_path = self.root / 'output/librechat/backup-restore-latest.json'
            evidence = private_json(evidence_path) if evidence_path.exists() else {}
            if evidence.get('passed') is not True or evidence.get('archiveSHA256') != sha256(existing / 'production-mongo.archive.gz'):
                self.verify(existing)
            self.report['mongoRestoreVerified'] = True
            self.report['pruned'] = prune_backups(self.backups, self.config['keep'], existing)
            return
        if not all(self.active(service) for service in SERVICES) or not self.readiness():
            raise BackupError('services_not_healthy')
        if not self.idle():
            self.report['status'] = 'deferred_busy'
            return
        memory = re.search(r'MemAvailable:\s+(\d+)', Path('/proc/meminfo').read_text())
        if (shutil.disk_usage(self.backups).free // 1048576 < self.config['minimumDiskMiB'] or
                not memory or int(memory[1]) // 1024 < self.config['minimumMemoryMiB']):
            self.report['status'] = 'deferred_resources'
            return
        name = 'auto-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
        pending = self.backups / ('.' + name + '.pending')
        pending.mkdir(mode=0o700)
        self.prepare(pending)
        if not self.idle():
            self.report['status'] = 'deferred_busy'
            shutil.rmtree(pending)
            return
        started = time.monotonic()
        if not self.quiesce_and_capture(pending):
            shutil.rmtree(pending)
            return
        self.report['maintenanceSeconds'] = round(time.monotonic() - started, 2)
        self.stage('finalize')
        files = {path.name: {'sha256': sha256(path), 'bytes': path.stat().st_size} for path in pending.iterdir() if path.is_file()}
        manifest = {'kind': KIND, 'complete': True, 'createdAt': self.report['dataCapturedAt'], 'localDate': local.date().isoformat(),
                    'files': files, 'commits': {name: self.command(['git', 'rev-parse', 'HEAD'], cwd=repo) for name, repo in [('browser', self.root), ('librechat', self.checkout)]},
                    'node': self.command(['node', '--version']),
                    'scope': 'No active/queued browser leases or running/paused generations. Public admission gated and both application writers stopped. Mongo TTL/Redis expiry may progress; this is not a cross-service transaction or a full disaster-recovery drill.'}
        write_json(pending / 'manifest.json', manifest)
        completed = self.backups / name
        pending.rename(completed)
        self.report.update(backup=name, dataBackupComplete=True)
        self.verify(completed)
        self.report.update(status='completed', pruned=prune_backups(self.backups, self.config['keep'], completed))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--run', action='store_true')
    modes.add_argument('--scheduled', action='store_true')
    modes.add_argument('--recover', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    job = Backup()
    # systemd owns this directory; never create an alternate production gate.
    for path, private in [(job.runtime, False), (job.private, True), (job.backups, True)]:
        if path.resolve() != path or not path.is_dir() or path.stat().st_uid != os.getuid() or (private and path.stat().st_mode & 0o077):
            raise BackupError('unsafe_directory')
    with (job.runtime / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'already_running'}))
            return 0
        if args.recover:
            job.recover()
            return 0
        def interrupted(_signal, _frame):
            raise BackupError('interrupted')
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        code = 0
        try:
            job.run(scheduled=args.scheduled)
        except BackupError as error:
            job.report.update(status='failed', failureCode=str(error))
            code = 2
        except Exception:
            job.report.update(status='failed', failureCode='unexpected_failure')
            code = 2
        job.report['completedAt'] = now()
        write_json(job.root / 'output/librechat/backup-job-latest.json', job.report)
        print(json.dumps(job.report))
        return code


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except BackupError:
        print(json.dumps({'status': 'failed', 'failureCode': 'backup_preflight_or_recovery'}))
        raise SystemExit(2)
