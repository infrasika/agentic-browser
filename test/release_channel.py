"""Release-channel guard tests; no registry or GitHub mutation is performed."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_manifest', Path(__file__).resolve().parents[1] / 'scripts/release-manifest.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class LatestChannel(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.version = 'v0.1.0'
        self.images = {kind: repo + '@sha256:' + char * 64 for (kind, repo), char in zip(release.REPOS.items(), 'ab')}
        (self.root / 'RELEASE.json').write_text(json.dumps({'version': self.version, 'revision': 'verified-source', 'images': self.images}))
        self.releases = [{'tag_name': self.version, 'draft': False, 'prerelease': False}]
        self.bad_runtime = False
        self.calls = []

    def command(self, *args):
        if args[0] == 'gh':
            return json.dumps([self.releases[:1], self.releases[1:]])
        ref = args[4]
        kind = 'controller' if 'controller:' in ref else 'runtime'
        digest = self.images[kind].split('@')[1]
        if self.bad_runtime and kind == 'runtime':
            digest = 'sha256:' + 'c' * 64
        return json.dumps({'digest': digest, 'manifests': [{'platform': {'os': 'linux', 'architecture': arch}} for arch in ['amd64', 'arm64']]})

    def run_latest(self, version=None, mutation=None):
        with patch.dict(os.environ, {'GITHUB_SHA': 'verified-source'}), patch.object(release, 'command', self.command), patch.object(release.subprocess, 'run', side_effect=mutation or (lambda args, **kwargs: self.calls.append(args))):
            release.promote_latest(version or self.version, self.root)

    def test_prerelease_never_reads_or_mutates_registry(self):
        with patch.object(release, 'command', side_effect=AssertionError('Unexpected registry/API access')), patch.object(release.subprocess, 'run', side_effect=AssertionError('Unexpected mutation')):
            release.promote_latest('v9.0.0-preview.1', self.root / 'missing')

    def test_both_latest_tags_reuse_exact_indexes_then_mark_github_latest(self):
        self.run_latest()
        self.assertEqual([call[5] for call in self.calls[:2]], [repo + ':latest' for repo in release.REPOS.values()])
        self.assertEqual([call[6] for call in self.calls[:2]], list(self.images.values()))
        self.assertEqual(self.calls[-1], ['gh', 'release', 'edit', self.version, '--latest'])
        self.assertTrue(json.loads((self.root / 'LATEST.json').read_text())['verified'])

    def test_numeric_version_order_prevents_downgrade_across_pages(self):
        self.releases += [{'tag_name': 'v0.10.0', 'draft': False, 'prerelease': False}, {'tag_name': 'v99.0.0-preview.1', 'draft': False, 'prerelease': True}]
        self.run_latest()
        self.assertEqual(self.calls, [])

    def test_unpublished_or_draft_stable_is_rejected(self):
        self.releases[0]['draft'] = True
        with self.assertRaisesRegex(SystemExit, 'non-draft'):
            self.run_latest()
        self.assertEqual(self.calls, [])

    def test_both_tags_are_checked_before_first_mutation(self):
        self.bad_runtime = True
        with self.assertRaisesRegex(SystemExit, 'mismatch'):
            self.run_latest()
        self.assertEqual(self.calls, [])

    def test_failed_alias_update_never_marks_github_latest_and_can_retry(self):
        def fail_second(args, **kwargs):
            self.calls.append(args)
            if len(self.calls) == 2:
                raise subprocess.CalledProcessError(1, args)
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_latest(mutation=fail_second)
        self.assertFalse(any(call[0] == 'gh' for call in self.calls))
        self.assertFalse((self.root / 'LATEST.json').exists())
        self.calls = []
        self.run_latest()
        self.assertTrue((self.root / 'LATEST.json').exists())


if __name__ == '__main__':
    unittest.main()
