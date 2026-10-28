from datetime import datetime, timedelta, timezone
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/agent'))
import agentctl as ctl
import maintenance as job


class Maintenance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for name in ['config', 'state', 'state/maintenance', 'backups']:
            (self.root / name).mkdir(mode=0o700)
        self.install = object.__new__(ctl.Installation)
        self.install.root = self.root
        self.install.meta = {'project': 'agent-0123456789ab'}
        self.install.intent = self.root / 'state/operation.json'
        self.install.gate = self.root / 'state/maintenance/active'
        self.policy = {'kind': job.POLICY, 'timeZone': 'Asia/Shanghai', 'hour': 4,
                       'keep': 2, 'retryMinutes': 60, 'copyTo': None}
        ctl.atomic(self.root / 'config/backup.json', self.policy)
        self.now = datetime(2026, 10, 28, 0, tzinfo=timezone.utc)

    def tearDown(self):
        self.tmp.cleanup()

    def state(self):
        return ctl.read_json(self.root / 'state/backup-status.json')

    def test_busy_retry_and_local_day_prevent_repeated_interruptions(self):
        with patch.object(self.install, 'idle', return_value=False), patch.object(self.install, 'backup') as backup:
            self.assertEqual(job.tick(self.install, self.now)['status'], 'deferred_busy')
            self.assertEqual(job.tick(self.install, self.now + timedelta(minutes=59))['status'], 'retry_not_due')
            backup.assert_not_called()
        folder = self.root / 'backups/20261028T010000Z-abcdef01'; folder.mkdir()
        with patch.object(self.install, 'idle', return_value=True), patch.object(self.install, 'backup', return_value=folder) as backup:
            self.assertEqual(job.tick(self.install, self.now + timedelta(hours=1))['status'], 'completed')
            self.assertEqual(job.tick(self.install, self.now + timedelta(hours=2))['status'], 'not_due')
            backup.assert_called_once()
        # 03:00 Shanghai on the next date is still before the configured hour.
        self.assertEqual(job.tick(self.install, self.now + timedelta(hours=19))['status'], 'not_due')

    def test_copy_failure_retries_existing_snapshot_without_stopping_services(self):
        folder = self.root / 'backups/20261028T010000Z-abcdef01'; folder.mkdir()
        with patch.object(self.install, 'idle', return_value=True), patch.object(self.install, 'backup', return_value=folder):
            with patch.object(job, 'mirror', side_effect=OSError('private details')):
                with self.assertRaisesRegex(ctl.Failure, '^maintenance_failed;'):
                    job.tick(self.install, self.now)
        self.assertEqual(self.state()['copyPending'], folder.name)
        with patch.object(ctl, 'verify_backup'), patch.object(job, 'mirror') as mirror, patch.object(self.install, 'backup') as backup:
            self.assertEqual(job.tick(self.install, self.now + timedelta(hours=1))['status'], 'completed')
            mirror.assert_called_once(); backup.assert_not_called()
        self.assertIsNone(self.state()['copyPending'])

    def test_rotation_only_removes_verified_scheduler_backups(self):
        names = ['20261028T010000Z-abcdef01', '20261028T020000Z-abcdef02', '20261028T030000Z-abcdef03']
        for name in [*names, 'manual', '.pending-incomplete']:
            (self.root / 'backups' / name).mkdir()
        state = {'managedBackups': names}
        with patch.object(ctl, 'verify_backup') as verify:
            job.prune(self.install, self.policy, state)
            verify.assert_called_once_with(self.root / 'backups' / names[0])
        self.assertEqual(state['managedBackups'], names[1:])
        self.assertTrue((self.root / 'backups/manual').exists())
        self.assertTrue((self.root / 'backups/.pending-incomplete').exists())

    def test_interrupted_backup_recovers_even_before_schedule_and_during_retry(self):
        ctl.atomic(self.install.intent, {'kind': ctl.KIND, 'operation': 'backup', 'phase': 'stopping'})
        ctl.atomic(self.root / 'state/backup-status.json', {'lastAttemptAt': self.now.isoformat()})
        with patch.object(self.install, 'recover') as recover:
            self.assertEqual(job.tick(self.install, self.now)['status'], 'recovered_interrupted_backup')
            recover.assert_called_once()

    def test_upgrade_restore_unknown_and_orphan_states_never_auto_resume(self):
        for operation, phase in [('upgrade', 'drain'), ('upgrade', 'upgrading'), ('upgrade', 'upgrade_failed'),
                                 ('restore', 'ready'), ('restore', 'restoring'), ('backup', 'unknown')]:
            ctl.atomic(self.install.intent, {'kind': ctl.KIND, 'operation': operation, 'phase': phase})
            with patch.object(self.install, 'recover') as recover:
                self.assertEqual(job.tick(self.install, self.now)['status'], 'operator_required')
                recover.assert_not_called()
        self.install.intent.unlink(); ctl.atomic(self.install.gate, 'maintenance')
        self.assertEqual(job.tick(self.install, self.now)['status'], 'operator_required')

    def test_corrupt_or_traversing_retention_state_cannot_delete_files(self):
        with patch.object(job.shutil, 'rmtree') as remove:
            for name in ['../config', '/tmp/elsewhere', '.pending-20261028T010000Z-abcdef01']:
                with self.assertRaises(ctl.Failure): job.prune(self.install, self.policy, {'managedBackups': [name] * 3})
            remove.assert_not_called()

    def test_schedule_generates_private_units_and_does_not_enable_them(self):
        args = SimpleNamespace(timezone='Asia/Shanghai', hour=4, keep=7, retry_minutes=60, copy_to=None)
        result = job.configure(self.install, args)
        unit = Path(result['unitDirectory']) / result['timer']
        self.assertIn('Persistent=true', unit.read_text())
        self.assertEqual(unit.stat().st_mode & 0o777, 0o600)
        self.assertTrue((self.root / 'maintenance.py').is_file())
        self.assertNotIn('sudo', unit.read_text())

    def test_invalid_policy_and_nested_copy_destinations_are_rejected(self):
        for changes in [{'hour': 24}, {'keep': 0}, {'retryMinutes': True}, {'timeZone': '../UTC'},
                        {'copyTo': str(self.root / 'replica')}, {'copyTo': str(self.root.parent)}]:
            with self.assertRaises(ctl.Failure): job.validate({**self.policy, **changes}, self.root)

    def test_archive_with_backup_policy_is_valid_and_can_be_mirrored(self):
        import json
        backup = self.root / 'backups/20261028T010000Z-abcdef01'; backup.mkdir(mode=0o700)
        for key in ctl.VOLUMES:
            path = backup / (key + '.tar.gz')
            with tarfile.open(path, 'w:gz') as archive:
                entry = tarfile.TarInfo('safe'); archive.addfile(entry, io.BytesIO())
            path.chmod(0o600)
        for name in ['settings.json', 'secrets.env', 'browser-token', 'release.json', 'compose.yaml', 'backup.json']:
            ctl.atomic(backup / name, '{}')
        ctl.atomic(backup / 'manifest.json', {'kind': ctl.KIND, 'files': {p.name: ctl.digest(p) for p in backup.iterdir()}})
        with tempfile.TemporaryDirectory() as dest:
            policy = {**self.policy, 'copyTo': dest}
            job.mirror(self.install, policy, backup)
            copied = Path(dest) / self.install.meta['project'] / backup.name
            self.assertEqual(ctl.verify_backup(copied), ctl.verify_backup(backup))
            job.mirror(self.install, policy, backup)
            # Unknown metadata is still rejected instead of broadening the format.
            manifest = ctl.read_json(backup / 'manifest.json')
            manifest['files']['unexpected.json'] = 'a' * 64
            ctl.atomic(backup / 'manifest.json', manifest)
            with self.assertRaisesRegex(ctl.Failure, 'invalid_backup_manifest'): ctl.verify_backup(backup)


if __name__ == '__main__': unittest.main()
