import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


bundle = module('bundle', 'deploy/agent/bundle.py')
package = module('package_agent', 'scripts/build/package-agent.py')
builder = module('build_agent', 'scripts/build/build-agent-images.py')
cli = module('agentctl', 'deploy/agent/agentctl.py')


class Bundle(unittest.TestCase):
    def fixture(self, directory):
        for name in [*package.FILES, 'LICENSES/LibreChat.txt']:
            file = directory / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_text('fixture')
        images = dict.fromkeys(['agent', 'browser', 'runtime', 'gateway', 'mongo', 'redis'], 'sha256:' + 'a' * 64)
        (directory / 'release.json').write_text(json.dumps({'version': 'v0.2.0-rc.1', 'images': images}))
        (directory / 'BUILD.json').write_text(json.dumps({'distribution': 'offline-candidate', 'images': {key: {'id': value, 'platform': 'linux/amd64'} for key, value in images.items()}}))
        self.sums(directory)

    def sums(self, directory):
        (directory / 'SHA256SUMS').write_text(''.join(f'{bundle.digest(file)}  {file.relative_to(directory).as_posix()}\n' for file in sorted(directory.rglob('*')) if file.is_file() and file.name != 'SHA256SUMS'))

    def test_tampered_missing_and_unexpected_files_are_rejected(self):
        for operation in ['tamper', 'missing', 'extra']:
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); self.fixture(root); bundle.verify(root)
                if operation == 'tamper': (root / 'compose.yaml').write_text('changed')
                if operation == 'missing': (root / 'agentctl.py').unlink()
                if operation == 'extra': (root / 'secrets.env').write_text('not distributable')
                with self.assertRaises(ValueError): bundle.verify(root)

    def test_symlink_escape_duplicate_and_parent_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'bundle'; root.mkdir(); self.fixture(root)
            outside = Path(folder) / 'outside'; outside.write_text('fixture')
            target = root / 'README.md'; target.unlink(); target.symlink_to(outside)
            with self.assertRaises(ValueError): bundle.verify(root)
            target.unlink(); target.write_text('fixture'); self.sums(root)
            sums = (root / 'SHA256SUMS').read_text()
            for extra in [sums.splitlines()[0], bundle.digest(outside) + '  ../outside']:
                (root / 'SHA256SUMS').write_text(sums + extra + '\n')
                with self.assertRaises(ValueError): bundle.verify(root)

    def test_image_inventory_must_match_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); self.fixture(root)
            data = json.loads((root / 'release.json').read_text()); data['images']['agent'] = 'sha256:' + 'b' * 64
            (root / 'release.json').write_text(json.dumps(data)); self.sums(root)
            with self.assertRaisesRegex(ValueError, 'exact image'): bundle.verify(root)

    def test_maintenance_module_is_required_even_with_valid_checksums(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); self.fixture(root)
            (root / 'maintenance.py').unlink(); self.sums(root)
            with self.assertRaisesRegex(ValueError, 'incomplete bundle'): bundle.verify(root)

    def test_configuration_guide_is_in_the_distribution(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); self.fixture(root)
            (root / 'CONFIGURATION.md').unlink(); self.sums(root)
            with self.assertRaisesRegex(ValueError, 'incomplete bundle'): bundle.verify(root)

    def test_preview_overlay_and_partial_builds_cannot_be_packaged(self):
        for value in [{}, {'passed': True, 'sourceMode': 'working-tree'}, {'passed': True, 'sourceMode': 'committed', 'images': {'agent': {}}}]:
            with self.assertRaises(ValueError): package.validate_report(value)

    def test_packager_only_fetches_missing_pinned_official_dependencies(self):
        error = subprocess.CalledProcessError(1, ['docker', 'inspect'])
        ref = package.INFRA['mongo']
        with patch.object(package.subprocess, 'check_output', side_effect=[error, b'[{"Id":"fixture"}]']), patch.object(package.subprocess, 'run') as run:
            self.assertEqual(package.inspect_image('mongo', ref)['Id'], 'fixture')
            run.assert_called_once_with(['docker', 'pull', '--platform', 'linux/amd64', ref], check=True)
        with patch.object(package.subprocess, 'check_output', side_effect=error), patch.object(package.subprocess, 'run') as run:
            with self.assertRaises(subprocess.CalledProcessError): package.inspect_image('agent', 'untrusted/image:latest')
            run.assert_not_called()

    def test_git_snapshot_excludes_untracked_secrets_and_working_edits(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / 'repo'; source.mkdir()
            def git(*args): return subprocess.check_output(['git', '-C', str(source), *args], stderr=subprocess.DEVNULL).decode().strip()
            git('init'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test')
            (source / 'tracked').write_text('committed')
            (source / 'nested').mkdir(); (source / 'nested/child').write_text('nested module')
            git('add', 'tracked', 'nested'); git('commit', '-m', 'fixture')
            revision = git('rev-parse', 'HEAD')
            (source / 'tracked').write_text('working change'); (source / 'private.env').write_text('secret')
            previous = os.umask(0o077)
            try: builder.committed_checkout(source, root / 'context', revision)
            finally: os.umask(previous)
            self.assertEqual((root / 'context/tracked').read_text(), 'committed')
            self.assertFalse((root / 'context/private.env').exists())
            self.assertEqual((root / 'context').stat().st_mode & 0o777, 0o755)
            self.assertEqual((root / 'context/nested').stat().st_mode & 0o777, 0o755)
            self.assertEqual((root / 'context/tracked').stat().st_mode & 0o777, 0o644)

    def test_runtime_assets_require_locked_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root / 'context/runtime').mkdir(parents=True); (root / 'output/runtime/packages').mkdir(parents=True)
            (root / 'context/runtime/assets.lock.json').write_text(json.dumps({'chrome': {'sha256': 'a'*64}, 'extensions': []}))
            (root / 'output/runtime/packages/chrome-amd64.deb').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'mismatch'): builder.runtime_assets(root, root / 'context')

    def test_six_image_manifest_is_supported_but_partial_database_override_is_not(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'release.json'
            value = {'version': 'v0.2.0-rc.1', 'images': dict.fromkeys(['agent','browser','runtime','gateway','mongo','redis'], 'sha256:'+'a'*64)}
            path.write_text(json.dumps(value)); self.assertEqual(cli.release_file(path, True), value)
            del value['images']['redis']; path.write_text(json.dumps(value))
            with self.assertRaises(cli.Failure): cli.release_file(path, True)


if __name__ == '__main__': unittest.main()
