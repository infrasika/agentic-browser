import importlib.util
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('builder', Path(__file__).resolve().parents[1] / 'scripts/build/build-agent-images.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class BuildContext(unittest.TestCase):
    def test_platforms_are_explicit_and_cannot_be_duplicated(self):
        self.assertEqual(builder.platforms('linux/amd64,linux/arm64'), ['linux/amd64', 'linux/arm64'])
        for value in ['darwin/arm64', '', 'linux/amd64,linux/amd64', 'linux/386']:
            with self.assertRaises(argparse.ArgumentTypeError): builder.platforms(value)

    def test_bad_source_patch_is_rejected_before_network_or_checkout(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root/'repo'; integration = source/'integrations/librechat'
            integration.mkdir(parents=True)
            lock = {'format': 1, 'repository': 'https://github.com/LibreChat-AI/LibreChat.git',
                'commit': 'a'*40, 'tree': 'b'*40, 'patchSha256': hashlib.sha256(b'accepted').hexdigest()}
            (integration/'source.lock.json').write_text(json.dumps(lock))
            (integration/'customizations.patch').write_bytes(b'tampered')
            with patch.object(builder.librechat.subprocess, 'check_output') as git:
                with self.assertRaisesRegex(ValueError, 'checksum'): builder.librechat.prepare(source, root/'checkout')
                git.assert_not_called()
            self.assertFalse((root/'checkout').exists())

    def test_arm_runtime_uses_arm_lock_and_excludes_amd64_asset(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'context/runtime').mkdir(parents=True)
            cache = root/'output/runtime/packages'; cache.mkdir(parents=True)
            data = b'arm64 fixture'
            (cache/'chrome-arm64.deb').write_bytes(data)
            (cache/'chrome-amd64.deb').write_bytes(b'unrelated')
            (root/'context/runtime/assets.lock.json').write_text(json.dumps({'chromeArm64': {'sha256': hashlib.sha256(data).hexdigest()}, 'extensions': []}))
            result = builder.runtime_assets(root, root/'context', 'arm64')
            self.assertEqual(list(result), ['chrome-arm64.deb'])
            self.assertFalse((root/'context/output/runtime/packages/chrome-amd64.deb').exists())

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
