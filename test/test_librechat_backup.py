import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('backup', ROOT / 'scripts/backup-librechat.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class FakeBackup(backup.Backup):
    def __init__(self, root, runtime):
        super().__init__(root, runtime)
        self.calls = []
        self.services = {name: True for name in backup.SERVICES}
        self.busy = False
        self.fail_capture = False
        self.gate_works = True

    def command(self, args, **_kwargs):
        self.calls.append(args)
        if args[:4] == ['sudo', '-n', 'systemctl', 'stop']:
            self.services[args[4]] = False
        if args[:4] == ['sudo', '-n', 'systemctl', 'start']:
            self.services[args[4]] = True
        return ''

    def active(self, name):
        return self.services[name]

    def stopped_cleanly(self, name):
        return not self.services[name]

    def readiness(self):
        return all(self.services.values())

    def idle(self):
        return not self.busy

    def maintenance_response(self):
        return self.gate_works

    def drain_requests(self):
        return not self.busy

    def capture(self, pending):
        self.calls.append(['capture'])
        if self.fail_capture:
            raise backup.BackupError('fixture_failure')


class Backups(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lc-backup-test-')
        self.root = Path(self.temp.name)
        (self.root / 'deploy/librechat').mkdir(parents=True)
        (self.root / 'deploy/librechat/backup.json').write_bytes((ROOT / 'deploy/librechat/backup.json').read_bytes())
        self.runtime = self.root / 'run'
        self.runtime.mkdir()
        self.pending = self.root / 'pending'
        self.pending.mkdir()
        self.sleep = patch.object(backup.time, 'sleep')
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        self.temp.cleanup()

    def test_capture_failure_recovers_in_dependency_order_and_opens_gate(self):
        job = FakeBackup(self.root, self.runtime)
        job.fail_capture = True
        with self.assertRaises(backup.BackupError):
            job.quiesce_and_capture(self.pending)
        self.assertEqual(job.calls, [
            ['sudo', '-n', 'systemctl', 'stop', 'librechat-browser-demo'],
            ['sudo', '-n', 'systemctl', 'stop', 'agentic-browser-service'],
            ['capture'],
            ['sudo', '-n', 'systemctl', 'start', 'agentic-browser-service'],
            ['sudo', '-n', 'systemctl', 'start', 'librechat-browser-demo'],
        ])
        self.assertFalse(job.gate.exists())
        self.assertFalse(job.state_path.exists())

    def test_task_arriving_before_gate_check_defers_without_stopping_services(self):
        job = FakeBackup(self.root, self.runtime)
        job.busy = True
        self.assertFalse(job.quiesce_and_capture(self.pending))
        self.assertEqual(job.report['status'], 'deferred_busy')
        self.assertEqual(job.calls, [])
        self.assertFalse(job.gate.exists())

    def test_uninstalled_nginx_gate_cannot_stop_production(self):
        job = FakeBackup(self.root, self.runtime)
        job.gate_works = False
        with self.assertRaisesRegex(backup.BackupError, 'maintenance_not_effective'):
            job.quiesce_and_capture(self.pending)
        self.assertEqual(job.calls, [])
        self.assertFalse(job.gate.exists())

    def test_pending_http_request_cannot_be_mistaken_for_an_idle_server(self):
        job = FakeBackup(self.root, self.runtime)
        with patch.object(job, 'command', return_value='ESTAB pending-request'), patch.object(backup.time, 'monotonic', side_effect=[0, 11]):
            self.assertFalse(backup.Backup.drain_requests(job))
        self.assertTrue(all(job.services.values()))

    def test_busy_preflight_does_not_prepare_or_enter_maintenance(self):
        job = FakeBackup(self.root, self.runtime)
        job.backups.mkdir(parents=True)
        job.busy = True
        with patch.object(job, 'prepare') as prepare:
            job.run()
        self.assertEqual(job.report['status'], 'deferred_busy')
        prepare.assert_not_called()
        self.assertFalse(job.gate.exists())

    def test_exec_stop_post_can_recover_persisted_stop_intent_after_a_kill(self):
        job = FakeBackup(self.root, self.runtime)
        run = 'a' * 32
        backup.write_json(job.state_path, {'kind': backup.KIND, 'id': run, 'librechat-browser-demo': True, 'agentic-browser-service': False})
        job.gate.write_text(run)
        job.services['librechat-browser-demo'] = False
        job.recover()
        self.assertEqual(job.calls, [['sudo', '-n', 'systemctl', 'start', 'librechat-browser-demo']])
        job.recover()
        self.assertEqual(len(job.calls), 1)

    def test_mismatched_recovery_owner_leaves_gate_and_services_untouched(self):
        job = FakeBackup(self.root, self.runtime)
        backup.write_json(job.state_path, {'kind': backup.KIND, 'id': 'b' * 32})
        job.gate.write_text('another-operation')
        with self.assertRaisesRegex(backup.BackupError, 'maintenance_owner_mismatch'):
            job.recover()
        self.assertTrue(job.gate.exists())
        self.assertEqual(job.calls, [])

    def test_unhealthy_recovery_does_not_remove_maintenance_or_recovery_state(self):
        job = FakeBackup(self.root, self.runtime)
        run = 'c' * 32
        backup.write_json(job.state_path, {'kind': backup.KIND, 'id': run, 'librechat-browser-demo': True})
        job.gate.write_text(run)
        with patch.object(job, 'readiness', return_value=False), patch.object(backup.time, 'monotonic', side_effect=[0, 46]):
            with self.assertRaisesRegex(backup.BackupError, 'service_recovery_failed'):
                job.recover()
        self.assertTrue(job.gate.exists() and job.state_path.exists())

    def test_rescue_does_not_depend_on_backup_policy_or_storage(self):
        (self.root / 'deploy/librechat/backup.json').unlink()
        job = backup.Backup(self.root, self.runtime, recover_only=True)
        job.recover()
        self.assertFalse(job.gate.exists())

    def test_retention_only_removes_old_complete_automatic_backups(self):
        directory = self.root / 'backups'
        directory.mkdir()
        for day in range(1, 11):
            path = directory / f'auto-202601{day:02}T040000Z-aaaaaaaa'
            path.mkdir()
            backup.write_json(path / 'manifest.json', {'kind': backup.KIND, 'complete': True, 'createdAt': f'2026-01-{day:02}T04:00:00+00:00'})
        manual = directory / 'controls-manual'
        manual.mkdir()
        (manual / 'user-file').write_text('must survive')
        pending = directory / '.auto-20260101T000000Z-aaaaaaaa.pending'
        pending.mkdir()
        symlink = directory / 'auto-20250101T000000Z-bbbbbbbb'
        symlink.symlink_to(manual, target_is_directory=True)
        public = directory / 'auto-20250101T000000Z-cccccccc'
        public.mkdir()
        (public / 'manifest.json').write_text('{"kind":"librechat-scheduled-backup-v1","complete":true,"createdAt":"2025-01-01"}')
        os.chmod(public / 'manifest.json', 0o644)
        protected = directory / 'auto-20260110T040000Z-aaaaaaaa'
        self.assertEqual(backup.prune_backups(directory, 7, protected), 3)
        self.assertEqual(len(backup.completed_backups(directory)), 7)
        self.assertTrue(manual.exists() and pending.exists() and public.exists() and symlink.is_symlink())


class NginxGate(unittest.TestCase):
    def test_real_nginx_maintenance_response_and_retired_paths(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'fixture')

            def log_message(self, *_args):
                pass

        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        with tempfile.TemporaryDirectory(prefix='lc-backup-nginx-') as temp:
            directory = Path(temp)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            config = (ROOT / 'deploy/librechat/nginx.conf').read_text()
            config = config.replace('listen 80;', f'listen 127.0.0.1:{port};')
            config = config.replace('127.0.0.1:3080', f'127.0.0.1:{server.server_port}').replace('127.0.0.1:8082', f'127.0.0.1:{server.server_port}')
            config = config.replace('/run/librechat-backup/maintenance', str(directory / 'maintenance'))
            path = directory / 'nginx.conf'
            path.write_text(f'daemon off; pid {directory}/pid; error_log {directory}/error.log; events {{}} http {{ access_log off; {config} }}')
            process = subprocess.Popen(['nginx', '-p', temp, '-c', str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                base = f'http://127.0.0.1:{port}'
                for _ in range(50):
                    try:
                        with urlopen(base + '/api/config', timeout=1) as response:
                            self.assertEqual(response.status, 200)
                        break
                    except OSError:
                        time.sleep(0.1)
                else:
                    self.fail('isolated nginx did not start')
                (directory / 'maintenance').write_text('fixture')
                for path in ['/', '/api/config', '/api/agents/chat']:
                    with self.assertRaises(HTTPError) as raised:
                        urlopen(base + path, timeout=1)
                    self.assertEqual(raised.exception.code, 503)
                    self.assertEqual(raised.exception.headers['Retry-After'], '60')
                    self.assertEqual(raised.exception.headers['Cache-Control'], 'no-store')
                    self.assertEqual(raised.exception.headers['X-Browser-Demo-Maintenance'], '1')
                with self.assertRaises(HTTPError) as raised:
                    urlopen(base + '/mcp', timeout=1)
                self.assertEqual(raised.exception.code, 404)
                (directory / 'maintenance').unlink()
                with urlopen(base + '/', timeout=1) as response:
                    self.assertEqual(response.status, 200)
            finally:
                process.terminate()
                process.wait(timeout=5)
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    unittest.main()
