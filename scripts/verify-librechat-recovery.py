#!/usr/bin/env python3
"""Restore a complete idle backup into a disposable, network-isolated application.

Uses locally installed Node dependencies and pinned images. Never restores into
production. Does not send mail, call an LLM, or open a real website.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tarfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('backup', ROOT / 'scripts/backup-librechat.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def extract_checked(source, destination):
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tarfile.open(source) as archive:
        members = archive.getmembers()
        if len(members) > 100000 or sum(member.size for member in members) > 1024 ** 3:
            raise backup.BackupError('archive_size')
        # Python's data filter rejects path/link escapes, devices and unsafe modes.
        archive.extractall(destination, members=members, filter='data')


def checked_snapshot(path):
    if path.resolve() != path or not backup.NAME.fullmatch(path.name):
        raise backup.BackupError('invalid_backup_path')
    manifest = backup.private_json(path / 'manifest.json')
    if manifest.get('kind') != backup.KIND or manifest.get('complete') is not True:
        raise backup.BackupError('incomplete_backup')
    required = {'browser-source.tar.gz', 'librechat-source.tar.gz', 'librechat-build.tar.gz',
                'configuration-and-files.tar.gz', 'production-mongo.archive.gz',
                'production-redis.rdb', 'browser-ledger.sqlite'}
    if not required.issubset(manifest['files']):
        raise backup.BackupError('missing_backup_files')
    for name, metadata in manifest['files'].items():
        if Path(name).name != name:
            raise backup.BackupError('invalid_backup_member')
        file = path / name
        if file.is_symlink() or not file.is_file() or file.stat().st_mode & 0o077:
            raise backup.BackupError('unsafe_backup_file')
        if file.stat().st_size != metadata['bytes'] or backup.sha256(file) != metadata['sha256']:
            raise backup.BackupError('backup_checksum')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, metavar='AUTO_BACKUP_NAME')
    args = parser.parse_args()
    os.umask(0o077)
    job = backup.Backup()
    source = job.backups / args.run
    manifest = checked_snapshot(source)
    run_id = uuid.uuid4().hex
    work = job.private / 'recovery-drills' / run_id
    work.mkdir(parents=True, mode=0o700)
    label = 'dev.agentic-browser.recovery-drill=' + run_id
    containers = []
    process = None
    log = (work / 'private.log').open('ab')
    report = {'startedAt': backup.now(), 'backup': source.name, 'runId': run_id,
              'passed': False, 'phase': 'extract', 'checks': []}
    stopped = False

    def interrupted(_signal, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)

    def guard():
        memory = re.search(r'MemAvailable:\s+(\d+)', Path('/proc/meminfo').read_text())
        if stopped or not memory or int(memory[1]) < 3072 * 1024:
            raise backup.BackupError('guard_stopped')

    def command(args, timeout=30, input_file=None):
        guard()
        try:
            result = subprocess.run(args, cwd=ROOT, timeout=timeout, check=True,
                                    stdin=input_file, stdout=subprocess.PIPE, stderr=log)
            return result.stdout.decode().strip()
        except (OSError, subprocess.SubprocessError):
            raise backup.BackupError('drill_command_failed') from None

    def wait(command_args):
        for _ in range(40):
            guard()
            try:
                return command(command_args, timeout=3)
            except backup.BackupError:
                time.sleep(.5)
        raise backup.BackupError('database_startup_timeout')

    production_pids = {name: job.command(['systemctl', 'show', name, '--property=MainPID', '--value']) for name in backup.SERVICES}
    try:
        guard()
        if shutil.disk_usage(work).free < 5 * 1024 ** 3:
            raise backup.BackupError('disk_reserve')
        browser = work / 'agentic-browser'
        librechat = work / 'librechat-agent'
        saved = work / 'saved'
        extract_checked(source / 'browser-source.tar.gz', browser)
        extract_checked(source / 'librechat-source.tar.gz', librechat)
        extract_checked(source / 'librechat-build.tar.gz', librechat)
        extract_checked(source / 'configuration-and-files.tar.gz', saved)
        config = browser / '.deployment/librechat'
        config.parent.mkdir(parents=True)
        shutil.copytree(saved / 'configuration', config)
        ledger = browser / '.data/librechat-browser'
        shutil.copytree(saved / 'browser/runtimes', ledger / 'runtimes')
        # An idle backup must have no runtime records that could refer to a host
        # container. Also rotate the clone's controller identity before startup.
        if list((ledger / 'runtimes').glob('*.json')):
            raise backup.BackupError('runtime_records_not_empty')
        (ledger / 'runtimes/instance-id').write_text(str(uuid.uuid4()))
        shutil.copy2(source / 'browser-ledger.sqlite', ledger / 'scheduler.sqlite')
        for relative in ['uploads', 'client/public/images']:
            if (saved / 'librechat' / relative).exists():
                shutil.copytree(saved / 'librechat' / relative, librechat / relative, dirs_exist_ok=True)
        for clone, original in [(browser, ROOT), (librechat, ROOT.parent / 'librechat-agent')]:
            if (clone / 'package-lock.json').read_bytes() != (original / 'package-lock.json').read_bytes():
                raise backup.BackupError('dependency_lock_mismatch')
            (clone / 'node_modules').symlink_to(original / 'node_modules', target_is_directory=True)
        for name in ['api', 'data-schemas', 'data-provider']:
            original = ROOT.parent / 'librechat-agent/packages' / name / 'node_modules'
            if original.exists():
                (librechat / 'packages' / name / 'node_modules').symlink_to(original, target_is_directory=True)
        for name in ['api', 'client']:
            original = ROOT.parent / 'librechat-agent' / name / 'node_modules'
            if original.exists():
                (librechat / name / 'node_modules').symlink_to(original, target_is_directory=True)
        binary = work / 'bin'
        binary.mkdir()
        wrapper = binary / 'docker'
        wrapper.write_text('''#!/usr/bin/python3
import os, sys
if sys.argv[1:3] == ['image', 'inspect']:
    os.execv('/usr/bin/docker', ['/usr/bin/docker', *sys.argv[1:]])
open(os.environ['RESTORE_DOCKER_DENIED'], 'a').write('blocked\\n')
sys.exit(70)
''')
        wrapper.chmod(0o700)
        original = str(ROOT.parent / 'librechat-agent')
        hook = work / 'modules.cjs'
        hook.write_text('''const Module = require('node:module');
const original = Module._resolveFilename;
const source = SOURCE;
const clone = CLONE;
function remap(file) {
  if (typeof file !== 'string') return file;
  if (file.includes('/node_modules/')) return file;
  for (const directory of ['api/', 'config/', 'packages/api/dist/', 'packages/data-schemas/dist/', 'packages/data-provider/dist/', 'client/dist/']) {
    if (file.startsWith(source + '/' + directory)) return clone + file.slice(source.length);
  }
  return file;
}
Module._resolveFilename = function(name, parent, ...args) {
  if (typeof name === 'string' && name.startsWith('~/')) name = clone + '/api/' + name.slice(2);
  return remap(original.call(this, remap(name), parent, ...args));
};
'''.replace('SOURCE', json.dumps(original)).replace('CLONE', json.dumps(str(librechat))))
        report['checks'].extend(['all_backup_hashes_match', 'private_configuration_extracted', 'fresh_clone_runtime_identity', 'existing_dependency_locks_match'])
        compose = (ROOT / 'deploy/librechat/compose.infrastructure.yaml').read_text()
        mongo_image = re.search(r'image: (mongo:[\w.-]+@sha256:[a-f0-9]{64})', compose)[1]
        redis_image = re.search(r'image: (redis:[\w.-]+@sha256:[a-f0-9]{64})', compose)[1]
        mongo = 'librechat-drill-mongo-' + run_id
        redis = 'librechat-drill-redis-' + run_id
        report['phase'] = 'isolated_databases'
        common = ['--detach', '--pull=never', '--label', label, '--read-only', '--user=999:999',
                  '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--log-driver=none']
        containers.append(mongo)
        command(['docker', 'run', *common, '--name', mongo, '--network=none', '--memory=1g', '--memory-swap=1g', '--cpus=0.5',
                 '--tmpfs=/data/db:rw,nosuid,nodev,size=2g,uid=999,gid=999,mode=0700',
                 '--tmpfs=/data/configdb:rw,nosuid,nodev,size=16m,uid=999,gid=999,mode=0700',
                 '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m', mongo_image,
                 'mongod', '--port', '27019', '--bind_ip', '127.0.0.1', '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'ttlMonitorEnabled=false', '--quiet'])
        wait(['docker', 'exec', mongo, 'mongosh', '--port', '27019', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok'])
        with (source / 'production-mongo.archive.gz').open('rb') as archive:
            command(['docker', 'exec', '-i', mongo, 'mongorestore', '--port', '27019', '--archive', '--gzip', '--stopOnError', '--nsInclude=LibreChatBrowserDemo.*'], timeout=60, input_file=archive)
        containers.append(redis)
        command(['docker', 'run', *common, '--name', redis, '--network=container:' + mongo, '--memory=256m', '--memory-swap=256m', '--cpus=0.25',
                 '--tmpfs=/data:rw,nosuid,nodev,size=64m,uid=999,gid=999,mode=0700',
                 '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m', '--entrypoint=/bin/sh', redis_image, '-c', 'exec sleep 600'])
        with (source / 'production-redis.rdb').open('rb') as archive:
            command(['docker', 'exec', '-i', redis, '/bin/sh', '-c', 'cat > /data/dump.rdb'], input_file=archive)
        command(['docker', 'exec', '-d', redis, 'redis-server', '--port', '6381', '--bind', '127.0.0.1', '--dir', '/data', '--dbfilename', 'dump.rdb', '--appendonly', 'no', '--save', '', '--logfile', '/tmp/redis.log'])
        if wait(['docker', 'exec', redis, 'redis-cli', '-p', '6381', 'ping']) != 'PONG':
            raise backup.BackupError('redis_startup')
        # Production uses AOF. Load the RDB first, then generate AOF from that
        # recovered state; an empty/new AOF must not take precedence over RDB.
        command(['docker', 'exec', redis, 'redis-cli', '-p', '6381', 'config', 'set', 'appendonly', 'yes'])
        for _ in range(50):
            info = command(['docker', 'exec', redis, 'redis-cli', '-p', '6381', 'info', 'persistence'])
            values = dict(line.split(':', 1) for line in info.splitlines() if ':' in line)
            if all(values.get(key) == value for key, value in {
                'aof_enabled': '1', 'aof_rewrite_in_progress': '0',
                'aof_rewrite_scheduled': '0', 'aof_last_bgrewrite_status': 'ok',
            }.items()):
                break
            time.sleep(.2)
        else:
            raise backup.BackupError('redis_aof_rewrite')
        command(['docker', 'exec', redis, 'redis-cli', '-p', '6381', 'shutdown', 'nosave'])
        command(['docker', 'exec', '-d', redis, 'redis-server', '--port', '6381', '--bind', '127.0.0.1', '--dir', '/data', '--dbfilename', 'dump.rdb', '--appendonly', 'yes', '--save', '', '--logfile', '/tmp/redis.log'])
        if wait(['docker', 'exec', redis, 'redis-cli', '-p', '6381', 'ping']) != 'PONG':
            raise backup.BackupError('redis_aof_restart')
        report['checks'].append('redis_rdb_to_aof_and_restart')
        for container in containers:
            topology = json.loads(command(['docker', 'inspect', container, '--format', '{{json .HostConfig}}']))
            isolated = topology['NetworkMode'] == 'none' if container == mongo else topology['NetworkMode'].startswith('container:')
            if not isolated or topology.get('PortBindings') or topology.get('Binds'):
                raise backup.BackupError('container_not_isolated')
        mongo_pid = int(command(['docker', 'inspect', mongo, '--format', '{{.State.Pid}}']))
        if mongo_pid <= 1:
            raise backup.BackupError('invalid_namespace_pid')
        routes = command(['sudo', '-n', 'nsenter', '--target', str(mongo_pid), '--net', 'ip', '-j', 'route', 'show'])
        if json.loads(routes):
            raise backup.BackupError('unexpected_network_route')
        settings = {'work': str(work), 'expectedNode': manifest['node'], 'hostNetworkNamespace': os.readlink('/proc/self/ns/net')}
        backup.write_json(work / 'settings.json', settings)
        report['checks'].extend(['mongo_and_redis_restored', 'network_namespace_has_no_external_routes', 'no_published_ports_or_host_data_mounts'])
        report['phase'] = 'application_recovery'
        node = shutil.which('node')
        process = subprocess.Popen(['sudo', '-n', 'nsenter', '--target', str(mongo_pid), '--net',
                                    'runuser', '-u', 'ubuntu', '--', node,
                                    str(ROOT / 'scripts/librechat-recovery-check.mjs'), str(work)],
                                   stdout=log, stderr=log, start_new_session=True)
        deadline = time.monotonic() + 150
        while process.poll() is None:
            guard()
            if time.monotonic() >= deadline:
                raise backup.BackupError('application_recovery_timeout')
            time.sleep(.5)
        if process.returncode != 0:
            raise backup.BackupError('application_recovery_failed')
        checks = backup.private_json(work / 'application-report.json')
        if checks.get('passed') is not True:
            raise backup.BackupError('application_checks_failed')
        report['application'] = checks
        report['passed'] = True
    except backup.BackupError as error:
        report['failureCode'] = str(error)
    except Exception:
        report['failureCode'] = 'unexpected_drill_failure'
    finally:
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                job.command(['sudo', '-n', 'kill', '-TERM', '--', str(-process.pid)])
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                job.command(['sudo', '-n', 'kill', '-KILL', '--', str(-process.pid)])
                process.wait(timeout=5)
        cleaned = True
        for container in reversed(containers):
            try:
                owner = job.command(['docker', 'inspect', container, '--format', '{{index .Config.Labels "dev.agentic-browser.recovery-drill"}}'])
                if owner != run_id:
                    raise backup.BackupError('cleanup_owner')
                job.command(['docker', 'rm', '--force', '--volumes', container], timeout=20)
            except Exception:
                cleaned = False
        try:
            remaining = job.command(['docker', 'ps', '-aq', '--filter', 'label=' + label])
            report['cleanup'] = {'passed': cleaned and not remaining, 'remainingContainers': len(remaining.splitlines())}
        except backup.BackupError:
            report['cleanup'] = {'passed': False, 'remainingContainers': -1}
        report['passed'] = report['passed'] and report['cleanup']['passed']
        try:
            current_pids = {name: job.command(['systemctl', 'show', name, '--property=MainPID', '--value']) for name in backup.SERVICES}
            report['productionServicesUnchanged'] = current_pids == production_pids
        except backup.BackupError:
            report['productionServicesUnchanged'] = False
        report['completedAt'] = backup.now()
        report['scope'] = 'Full application cold-start from this idle backup in an offline network namespace, using existing matching Node dependencies and pinned local images. No live Chrome, LLM or mail calls; no bare-host provisioning or off-host copy verification.'
        log.close()
        if report['passed']:
            shutil.rmtree(work)
        else:
            report['privateDiagnosticDirectory'] = str(work)
        backup.write_json(ROOT / 'output/librechat' / ('recovery-' + run_id + '.json'), report)
        backup.write_json(ROOT / 'output/librechat/recovery-latest.json', report)
    print(json.dumps(report))
    return 0 if report['passed'] else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'passed': False, 'failureCode': 'recovery_preflight_or_cleanup'}))
        raise SystemExit(2)
