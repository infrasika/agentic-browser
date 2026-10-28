import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('builder', Path(__file__).resolve().parents[1] / 'scripts/build/build-agent-images.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class BuildContext(unittest.TestCase):
    def test_private_staging_does_not_make_packaged_source_unreadable_or_include_secrets(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            repo = root / 'repo'
            repo.mkdir()
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            (repo / 'src/api').mkdir(parents=True)
            (repo / 'src/api/actions.ts').write_text('export const ready = true;\n')
            (repo / 'run.sh').write_text('#!/bin/sh\nexit 0\n')
            (repo / 'run.sh').chmod(0o755)
            (repo / 'private.env').write_text('must-not-be-copied')
            subprocess.run(['git', 'add', 'src', 'run.sh'], cwd=repo, check=True)
            old = os.umask(0o077)
            try:
                builder.checkout(repo, root / 'context')
            finally:
                os.umask(old)
            self.assertEqual((root / 'context/src/api').stat().st_mode & 0o777, 0o755)
            self.assertEqual((root / 'context/src/api/actions.ts').stat().st_mode & 0o777, 0o644)
            self.assertEqual((root / 'context/run.sh').stat().st_mode & 0o777, 0o755)
            self.assertFalse((root / 'context/private.env').exists())

if __name__ == '__main__': unittest.main()
