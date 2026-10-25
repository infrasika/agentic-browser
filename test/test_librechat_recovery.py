import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('recovery', ROOT / 'scripts/verify-librechat-recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class Recovery(unittest.TestCase):
    def test_extraction_rejects_path_and_link_escapes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, link in [('../outside', None), ('link', '../../outside')]:
                archive = root / 'bad.tar.gz'
                with tarfile.open(archive, 'w:gz') as target:
                    member = tarfile.TarInfo(name)
                    if link:
                        member.type = tarfile.SYMTYPE
                        member.linkname = link
                    else:
                        member.size = 4
                    target.addfile(member, None if link else io.BytesIO(b'data'))
                with self.assertRaises(tarfile.FilterError):
                    recovery.extract_checked(archive, root / 'restored')
                self.assertFalse((root / 'outside').exists())

    def test_incomplete_or_modified_backups_are_rejected_before_any_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'auto-20261025T010000Z-aaaaaaaa'
            root.mkdir()
            manifest = {'kind': recovery.backup.KIND, 'complete': False}
            recovery.backup.write_json(root / 'manifest.json', manifest)
            with self.assertRaisesRegex(recovery.backup.BackupError, 'incomplete_backup'):
                recovery.checked_snapshot(root)
            names = ['browser-source.tar.gz', 'librechat-source.tar.gz', 'librechat-build.tar.gz',
                     'configuration-and-files.tar.gz', 'production-mongo.archive.gz', 'production-redis.rdb', 'browser-ledger.sqlite']
            files = {}
            for name in names:
                path = root / name
                path.write_bytes(b'fixture')
                path.chmod(0o600)
                files[name] = {'bytes': 7, 'sha256': recovery.backup.sha256(path)}
            manifest.update(complete=True, files=files)
            recovery.backup.write_json(root / 'manifest.json', manifest)
            self.assertEqual(recovery.checked_snapshot(root)['files'], files)
            (root / names[0]).write_bytes(b'changed')
            with self.assertRaisesRegex(recovery.backup.BackupError, 'backup_checksum'):
                recovery.checked_snapshot(root)


if __name__ == '__main__':
    unittest.main()
