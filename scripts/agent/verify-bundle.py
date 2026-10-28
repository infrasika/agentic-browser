#!/usr/bin/env python3
"""Exercise an extracted Agent bundle with Python and Docker only; creates disposable installations."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.dont_write_bytecode = True
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']


def run(args, timeout=360):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=timeout, text=True).strip()


def write(path, value):
    path.write_text(json.dumps(value) if not isinstance(value, str) else value)
    path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--work', type=Path, required=True, help='New private directory, never an existing installation')
    parser.add_argument('--port', type=int, default=3340)
    args = parser.parse_args()
    if args.work.exists() or args.work.absolute() != args.work.resolve(): raise ValueError('new non-symlink work directory required')
    if not 1024 <= args.port <= 65533: raise ValueError('three consecutive loopback ports required')
    bundle = args.bundle.resolve(); work = args.work.resolve()
    run(['python3', str(bundle / 'bundle.py'), 'verify'])
    build = json.loads((bundle / 'BUILD.json').read_text())
    development = ['--development'] if build['distribution'] == 'offline-candidate' else []
    for info in build['images'].values():
        actual = json.loads(run(DOCKER + ['image', 'inspect', info['id']]))[0]
        if actual['Id'] != info['id']: raise ValueError('load the bundle images first')
    work.mkdir(mode=0o700, parents=True)
    source, restored, rollback = work / 'installation', work / 'restored', work / 'rollback'
    projects, instances = {}, set()
    fixture = None
    report = {'passed': False, 'stage': 'init', 'checks': [], 'hostApplicationDependencies': ['Python 3', 'Docker Engine', 'Docker Compose'],
              'hostNodeAvailable': bool(shutil.which('node')),
              'hostTools': {'python': sys.version.split()[0], 'docker': run(DOCKER + ['version', '--format', '{{.Server.Version}}']),
                            'compose': run(DOCKER + ['compose', 'version', '--short'])},
              'scope': 'bundle-only disposable projects on the selected Docker host; independent-host status requires external host evidence',
              'callsPaidModel': False, 'bundleVersion': build['version'], 'imageSources': build['sourceCommits'],
              'packageCommit': build['packageCommit'], 'images': build['images']}

    def cli(directory, *arguments):
        return json.loads(run(['python3', str(bundle / 'agentctl.py'), '--directory', str(directory), *arguments]))

    def compose(directory, *arguments):
        return run(DOCKER + ['compose', '--project-directory', str(directory), '--env-file', str(directory / '.env'), '-f', str(directory / 'compose.yaml'), *arguments])

    def render(directory):
        spec = importlib.util.spec_from_file_location('agentctl_bundle', bundle / 'agentctl.py')
        ctl = importlib.util.module_from_spec(spec); spec.loader.exec_module(ctl)
        ctl.Installation(directory).render()

    def request(path, token=None, body=None, port=None, expected=200):
        base = 'http://127.0.0.1:' + str(port or args.port)
        headers = {'origin': base, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-librechat-generation-protocol': '2'}
        if token: headers['authorization'] = 'Bearer ' + token
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as response: status, raw = response.status, response.read()
        except urllib.error.HTTPError as error: status, raw = error.code, error.read()
        if status != expected: raise AssertionError('Unexpected HTTP status in ' + report['stage'] + ': ' + str(status))
        return json.loads(raw) if status == 200 and raw else None

    def login(email, password, port=None):
        return request('/api/auth/login', body={'email': email, 'password': password}, port=port)['token']

    def snapshot(directory):
        script = "JSON.stringify(['users','balances','sitebudgets','transactions','conversations','messages'].map(name=>({name,rows:db.getSiblingDB('AgenticBrowser').getCollection(name).find({},{updatedAt:0}).sort({_id:1}).toArray()})))"
        return json.loads(compose(directory, 'exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', script))

    def expect_failure(action):
        try: action()
        except subprocess.CalledProcessError: return
        raise AssertionError('Expected operation to refuse in ' + report['stage'])

    def interrupted_backup(directory):
        # Kill a real operator only after it has stopped all four writers. Its
        # helper is deliberately left alive to verify bounded orphan cleanup.
        script = '''import fcntl,json,sys,time
sys.path.insert(0,sys.argv[1])
from pathlib import Path
import agentctl as ctl
root=Path(sys.argv[2]); job=ctl.Installation(root)
with (root/'state/lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    job.enter('backup')
    ctl.run(ctl.DOCKER+['run','-d','--name',job.meta['project']+'-fault-helper','--label','dev.agentic-browser.operation='+job.meta['project'],'--network=none','--read-only','--cap-drop=ALL','--memory=64m','--entrypoint=node',job.release['images']['agent'],'-e','setTimeout(()=>{},600000)'])
    print('writers_stopped',flush=True)
    time.sleep(600)
'''
        process = subprocess.Popen(['python3', '-c', script, str(bundle), str(directory)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=180) or process.stdout.readline().strip() != 'writers_stopped':
                    raise AssertionError('backup interruption fixture did not reach stopped writers')
            process.kill(); process.communicate(timeout=10)
            request('/api/config', port=args.port + 1, expected=503)
            assert cli(directory, 'maintain')['status'] == 'recovered_interrupted_backup'
            cli(directory, 'doctor')
            assert not run(DOCKER + ['ps', '-aq', '--filter', 'label=dev.agentic-browser.operation=' + projects[directory]])
        finally:
            if process.poll() is None: process.kill(); process.communicate(timeout=10)

    def browser_task(token, port):
        mid = str(uuid.uuid4())
        start = request('/api/agents/chat', token, {'text': 'Open https://httpbin.org/anything/agentic-browser-acceptance, let me take control, then read the page and close the browser.', 'sender': 'User', 'isCreatedByUser': True, 'parentMessageId': '00000000-0000-0000-0000-000000000000', 'conversationId': 'new', 'messageId': mid, 'responseMessageId': mid + '_', 'endpoint': 'agents', 'agent_id': 'agent_browser_demo', 'spec': 'browser-demo', 'isTemporary': False, 'isRegenerate': False}, port)
        cid = start['conversationId']; path = '/api/agentic-browser/' + cid
        for _ in range(120):
            lease = request(path, token, port=port).get('lease')
            if lease and lease.get('control') == 'human': break
            time.sleep(1)
        else: raise AssertionError('handoff timeout')
        if port == args.port:
            expect_failure(lambda: cli(source, 'backup'))
            assert cli(source, 'maintain')['status'] == 'deferred_busy'
            request('/api/config', port=port)
        request(path + '/control', token, {'revision': lease['revision'], 'target': 'agent', 'operationId': str(uuid.uuid4())}, port)
        for _ in range(120):
            status = request('/api/agents/chat/status/' + cid, token, port=port)
            if not status.get('active'):
                result = request('/api/messages/' + cid, token, port=port)
                messages = result if isinstance(result, list) else result['messages']
                calls = [part['tool_call'] for msg in messages for part in msg.get('content', []) if part.get('type') == 'tool_call']
                snapshots = [call for call in calls if call.get('name') == 'browser_snapshot' and call.get('output') and 'agentic-browser-acceptance' in json.loads(call['output']).get('value', {}).get('result', {}).get('text', '')]
                closed = [json.loads(call['output']) for call in calls if call.get('name') == 'browser_close' and call.get('output')]
                if snapshots and any(c.get('ok') and c['value']['state'] == 'completed' for c in closed):
                    return
            time.sleep(1)
        raise AssertionError('real snapshot and automatic completion timeout')

    try:
        cli(source, 'init', '--release', str(bundle / 'release.json'), '--port', str(args.port), *development)
        projects[source] = json.loads((source / 'installation.json').read_text())['project']
        expect_failure(lambda: cli(source, 'up'))
        expect_failure(lambda: cli(source, 'init', '--release', str(bundle / 'release.json'), *development))
        settings = json.loads((source / 'config/settings.json').read_text())
        settings.update({'adminEmail': 'bundle-admin@example.test', 'model': {'name': 'selfhost-fixture', 'baseURL': 'http://fixture:9000/v1', 'promptRate': 1, 'completionRate': 1}})
        write(source / 'config/settings.json', settings)
        secrets_file = source / 'config/secrets.env'
        secrets = secrets_file.read_text().replace('QWEN_API_KEY=', 'QWEN_API_KEY=synthetic-bundle-key')
        write(secrets_file, secrets)
        render(source); compose(source, 'create')
        fixture = projects[source] + '-fixture'
        run(DOCKER + ['run', '-d', '--name', fixture, '--network', projects[source] + '_front', '--network-alias', 'fixture', '--read-only', '--user', f'{os.getuid()}:{os.getgid()}', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=192m', '--cpus=.5', '--mount', 'type=bind,src=' + str(bundle / 'acceptance/model-fixture.mjs') + ',dst=/fixture.mjs,readonly', '--entrypoint=node', build['images']['agent']['id'], '/fixture.mjs'])
        cli(source, 'up'); cli(source, 'doctor')
        replica = work / 'replica'; replica.mkdir(mode=0o700)
        cli(source, 'schedule', '--timezone', 'Asia/Shanghai', '--hour', '0', '--retry-minutes', '1', '--copy-to', str(replica))
        identity = compose(source, 'exec', '-T', 'browser', 'cat', '/data/runtimes/instance-id'); instances.add(identity)
        request('/mcp', expected=404)
        report['checks'].append('configuration_required_and_existing_installation_preserved; private_gateway_healthy_mcp_closed')
        report['stage'] = 'accounts_and_real_browser'
        user = {'email': 'bundle-user@example.test', 'name': 'Bundle User', 'username': 'bundle-user', 'password': 'Synthetic-Bundle-Password-2026!'}
        input_file = work / 'user.json'; write(input_file, user)
        assert cli(source, 'user-create', '--input-file', str(input_file))['status'] == 'created'
        token = login(user['email'], user['password']); balance = request('/api/balance', token)
        assert balance['tokenCredits'] == settings['credits']['initial']
        assert cli(source, 'user-create', '--input-file', str(input_file))['status'] == 'already_exists'
        assert request('/api/balance', token) == balance
        request('/api/demo-admin', token, expected=403)
        browser_task(token, args.port)
        report['checks'].extend(['ordinary_account_isolation_and_credits_once', 'real_chrome_snapshot_handoff_and_automatic_resume', 'active_task_defers_backup'])
        report['stage'] = 'backup_restore'
        time.sleep(2)
        before = snapshot(source)
        # Advance only the recorded retry timestamp, without waiting a minute.
        state_file = source / 'state/backup-status.json'
        state = json.loads(state_file.read_text()); state['lastAttemptAt'] = '2000-01-01T00:00:00+00:00'; write(state_file, state)
        assert cli(source, 'maintain')['status'] == 'completed'
        state = cli(source, 'maintenance-status')['state']
        assert cli(source, 'verify-backup', str(replica / projects[source] / state['lastBackup']))['verified']
        assert cli(source, 'maintain')['status'] in ['retry_not_due', 'not_due']
        assert snapshot(source) == before
        report['checks'].append('scheduled_idle_backup_busy_retry_verified_copy_and_daily_deduplication; copy_is_same_host_fixture')
        backup = cli(source, 'backup')['backup']; assert cli(source, 'verify-backup', backup)['verified']
        compose(source, 'stop')
        cli(restored, 'restore', backup, '--port', str(args.port + 1), *development)
        projects[restored] = json.loads((restored / 'installation.json').read_text())['project']
        run(DOCKER + ['network', 'connect', '--alias', 'fixture', projects[restored] + '_front', fixture])
        cli(restored, 'recover'); cli(restored, 'doctor')
        new_identity = compose(restored, 'exec', '-T', 'browser', 'cat', '/data/runtimes/instance-id'); instances.add(new_identity)
        assert identity != new_identity
        assert snapshot(restored) == before
        expect_failure(lambda: cli(restored, 'restore', backup, '--port', str(args.port + 1), *development))
        token = login(user['email'], user['password'], args.port + 1)
        browser_task(token, args.port + 1)
        report['checks'].append('new_project_restore_preserves_accounts_chats_credits_budget_and_runs_new_real_browser')
        report['stage'] = 'upgrade_rehearsal'
        time.sleep(2)
        before = snapshot(restored)
        next_release = json.loads((bundle / 'release.json').read_text()); next_release['version'] += '-rehearsal'
        next_file = work / 'next-release.json'; write(next_file, next_release)
        assert cli(restored, 'upgrade', '--release', str(next_file), *development)['status'] == 'upgraded'
        assert snapshot(restored) == before
        report['checks'].append('same_build_upgrade_procedure_takes_backup_and_preserves_data; not_a_cross_version_migration_test')
        report['stage'] = 'interrupted_backup'
        before = snapshot(restored)
        interrupted_backup(restored)
        assert snapshot(restored) == before
        report['checks'].append('SIGKILL_after_stopping_writers_recovers_health_data_and_owned_orphan_helper')
        report['stage'] = 'failed_upgrade_and_rollback'
        broken = {**next_release, 'version': 'injected-invalid-agent', 'images': {**next_release['images'], 'agent': next_release['images']['runtime']}}
        broken_file = work / 'broken-release.json'; write(broken_file, broken)
        expect_failure(lambda: cli(restored, 'upgrade', '--release', str(broken_file), *development))
        assert cli(restored, 'maintain')['status'] == 'operator_required'
        request('/api/config', port=args.port + 1, expected=503)
        operation = json.loads((restored / 'state/operation.json').read_text())
        assert operation['phase'] == 'upgrade_failed'
        cli(rollback, 'restore', operation['backup'], '--port', str(args.port + 2), *development)
        projects[rollback] = json.loads((rollback / 'installation.json').read_text())['project']
        run(DOCKER + ['network', 'connect', '--alias', 'fixture', projects[rollback] + '_front', fixture])
        cli(rollback, 'recover'); cli(rollback, 'doctor')
        instances.add(compose(rollback, 'exec', '-T', 'browser', 'cat', '/data/runtimes/instance-id'))
        assert snapshot(rollback) == before
        token = login(user['email'], user['password'], args.port + 2)
        browser_task(token, args.port + 2)
        report['checks'].append('invalid_image_upgrade_retains_maintenance_and_pre_upgrade_backup_restores_data_and_real_task')
        report['passed'] = True
    except Exception as error:
        # Keep all details local; stdout contains only stage/status, never tokens or passwords.
        write(work / 'private-error.txt', type(error).__name__ + ': ' + str(error))
    finally:
        # An init/restore may fail after allocating its project. Discover only our
        # newly-created directories, so partial failure still has bounded cleanup.
        for directory in [source, restored, rollback]:
            meta = directory / 'installation.json'
            if meta.is_file(): projects[directory] = json.loads(meta.read_text())['project']
        if fixture:
            try: run(DOCKER + ['rm', '-f', fixture])
            except subprocess.SubprocessError: pass
        cleanup_errors = []
        for directory, project in projects.items():
            try:
                helpers = run(DOCKER + ['ps', '-aq', '--filter', 'label=dev.agentic-browser.operation=' + project]).split()
                if helpers: run(DOCKER + ['rm', '-f', *helpers])
                if (directory / '.env').is_file():
                    write(work / (project + '-logs.txt'), compose(directory, 'logs', '--no-color', '--tail', '80'))
                    compose(directory, 'down', '--volumes', '--remove-orphans')
                for command, label in [('ps', 'com.docker.compose.project='), ('volume', 'com.docker.compose.project='), ('network', 'com.docker.compose.project=')]:
                    check = DOCKER + ([command, '-aq'] if command == 'ps' else [command, 'ls', '-q']) + ['--filter', 'label=' + label + project]
                    if run(check): cleanup_errors.append(project + ':' + command)
                if run(DOCKER + ['ps', '-aq', '--filter', 'label=dev.agentic-browser.operation=' + project]): cleanup_errors.append(project + ':helpers')
            except subprocess.SubprocessError: cleanup_errors.append(project)
        for instance in instances:
            if run(DOCKER + ['ps', '-aq', '--filter', 'label=dev.agentic-browser.instance=' + instance]): cleanup_errors.append('runtime')
        if fixture and run(DOCKER + ['ps', '-aq', '--filter', 'name=^/' + fixture + '$']): cleanup_errors.append('fixture')
        report['cleanup'] = {'passed': not cleanup_errors, 'remaining': len(cleanup_errors)}
        report['passed'] = report['passed'] and not cleanup_errors
        write(work / 'report.json', report)
        if report['passed']:
            for path in work.iterdir():
                if path.name != 'report.json':
                    if path.is_dir(): shutil.rmtree(path)
                    else: path.unlink()
        print(json.dumps(report))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(main())
