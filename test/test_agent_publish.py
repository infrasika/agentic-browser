import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


publisher = load('publisher', 'scripts/build/publish-agent-images.py')
assets = load('assets', 'scripts/build/fetch-runtime-assets.py')


class Publishing(unittest.TestCase):
    def fixture(self):
        prepared = {'version': 'v0.2.0-rc.6', 'platforms': ['linux/amd64', 'linux/arm64'], 'images': {}, 'infrastructure': dict(publisher.package.INFRA)}
        images, remote, commands = {}, {}, []
        for name, character in zip(publisher.NAMES, 'abc'):
            target = 'ghcr.io/example/' + publisher.NAMES[name] + ':v0.2.0-rc.6'
            prepared['images'][name] = {'target': target, 'platforms': {}}
            for i, platform in enumerate(prepared['platforms']):
                image_id = 'sha256:' + character * 63 + str(i)
                prepared['images'][name]['platforms'][platform] = {'id': image_id, 'target': target + '-' + platform.split('/')[1]}
                images[image_id] = {'Id': image_id, 'RepoDigests': []}
        class Registry:
            def manifest(self, repository, ref): return remote.get((repository, ref))
        def docker(args, **kwargs):
            commands.append(args)
            if args[1] == 'push':
                target = args[2]
                item = next(i for image in prepared['images'].values() for i in image['platforms'].values() if i['target'] == target)
                repo, tag = target.removeprefix('ghcr.io/').split(':')
                digest = item['id']
                remote[repo, tag] = remote[repo, digest] = (digest, {'config': {'digest': item['id']}})
                images['ghcr.io/' + repo + '@' + digest] = images[item['id']]
            if args[1:4] == ['buildx', 'imagetools', 'create']:
                target = args[5]; repo, tag = target.removeprefix('ghcr.io/').split(':')
                descriptors = [{'digest': ref.split('@')[1], 'platform': {'os': 'linux', 'architecture': p.split('/')[1]}}
                    for ref, p in zip(args[6:], prepared['platforms'])]
                remote[repo, tag] = ('sha256:' + 'd' * 64, {'manifests': descriptors})
        return prepared, images, remote, commands, Registry(), docker

    def test_conflicting_tag_aborts_before_any_push(self):
        prepared, images, remote, calls, registry, docker = self.fixture()
        remote['example/agentic-browser-runtime', prepared['version']] = ('sha256:' + 'e' * 64, {'config': {'digest': 'sha256:' + 'f' * 64}})
        with self.assertRaisesRegex(ValueError, 'another image'):
            publisher.publish(prepared, registry, docker, images.__getitem__)
        self.assertEqual(calls, [])

    def test_publish_combines_six_exact_images_and_resumes_without_repush(self):
        prepared, images, remote, calls, registry, docker = self.fixture()
        release, receipt = publisher.publish(prepared, registry, docker, images.__getitem__)
        self.assertEqual(set(release['images']), {'agent', 'browser', 'runtime', 'gateway', 'mongo', 'redis'})
        self.assertEqual(len([c for c in calls if c[1] == 'push']), 6)
        self.assertEqual(len([c for c in calls if c[1:4] == ['buildx', 'imagetools', 'create']]), 3)
        self.assertEqual(release['platforms'], ['linux/amd64', 'linux/arm64'])
        self.assertTrue(receipt['published']); self.assertFalse(receipt['anonymousPullVerified'])
        calls.clear()
        second, _ = publisher.publish(prepared, registry, docker, images.__getitem__)
        self.assertEqual(second, release)
        self.assertFalse(any(c[1] in ('push', 'tag') for c in calls))

    def test_missing_arm_or_conflicting_architecture_is_not_a_valid_release(self):
        prepared, images, remote, calls, registry, docker = self.fixture()
        publisher.publish(prepared, registry, docker, images.__getitem__)
        remote['example/agentic-browser-agent', prepared['version']][1]['manifests'].pop()
        calls.clear()
        with self.assertRaisesRegex(ValueError, 'another image'):
            publisher.publish(prepared, registry, docker, images.__getitem__)
        self.assertEqual(calls, [])

    def test_architecture_conflict_is_checked_before_any_upload(self):
        prepared, images, remote, calls, registry, docker = self.fixture()
        remote['example/agentic-browser-runtime', prepared['version'] + '-arm64'] = ('sha256:' + 'e'*64, {'config': {'digest': 'sha256:'+'f'*64}})
        with self.assertRaisesRegex(ValueError, 'Architecture tag'):
            publisher.publish(prepared, registry, docker, images.__getitem__)
        self.assertEqual(calls, [])

    def test_changed_pulled_image_fails_publication(self):
        prepared, images, _, calls, registry, docker = self.fixture()
        def inspect(ref): return {'Id': 'sha256:' + 'f' * 64} if '@' in ref else images[ref]
        with self.assertRaisesRegex(ValueError, 'Pulled image'):
            publisher.publish(prepared, registry, docker, inspect)
        self.assertEqual(len([c for c in calls if c[1] == 'push']), 1)

    def test_auth_failure_is_never_interpreted_as_unused_tag(self):
        for status in (401, 403, 404, 500):
            error = urllib.error.HTTPError('https://ghcr.io/token', status, 'fixture', {}, None)
            with patch.object(publisher.urllib.request, 'urlopen', side_effect=error), self.assertRaisesRegex(ValueError, 'unknown'):
                publisher.Registry(('example', 'fixture-secret')).manifest('example/image', 'v1')

    def test_existing_keychain_helper_is_used_without_storing_token(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'config.json'
            original = json.dumps({'credsStore': 'desktop', 'credHelpers': {'ghcr.io': 'osxkeychain'}})
            path.write_text(original)
            with patch.dict(os.environ, {'DOCKER_CONFIG': folder}), patch.object(publisher, 'command', return_value=json.dumps({'Username': 'example', 'Secret': 'fixture-secret'})) as command:
                self.assertEqual(publisher.credentials(), ('example', 'fixture-secret'))
                command.assert_called_once_with(['docker-credential-osxkeychain', 'get'], data='ghcr.io\n')
            self.assertEqual(path.read_text(), original)
            self.assertEqual(list(Path(folder).iterdir()), [path])

    def test_dry_run_never_loads_credentials_or_publishes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'report.json'; path.write_text('{}')
            args = ['publish-agent-images.py', '--build-report', str(path), '--version', 'v0.2.0-rc.6', '--namespace', 'example']
            with patch.object(publisher.sys, 'argv', args), patch.object(publisher, 'plan', return_value={'published': False}), patch.object(publisher, 'credentials') as credentials, patch.object(publisher, 'publish') as publish, patch('sys.stdout', new_callable=io.StringIO) as output:
                publisher.main()
                self.assertTrue(json.loads(output.getvalue())['dryRun'])
                credentials.assert_not_called(); publish.assert_not_called()

    def test_command_errors_never_echo_helper_secrets(self):
        result = subprocess.CompletedProcess([], 1, 'fixture-secret', 'fixture-secret')
        with patch.object(publisher.subprocess, 'run', return_value=result):
            with self.assertRaises(ValueError) as error: publisher.command(['docker-credential-osxkeychain', 'get'])
            self.assertNotIn('fixture-secret', str(error.exception))

    def test_public_verification_rejects_extra_or_replaced_dependencies(self):
        refs = {**dict.fromkeys(publisher.NAMES, 'ghcr.io/example/image@sha256:' + 'a' * 64), **publisher.package.INFRA}
        for images in [{**refs, 'extra': 'untrusted/image:latest'}, {**refs, 'mongo': 'untrusted/image:latest'}]:
            with patch.object(publisher, 'Registry') as registry, self.assertRaises(ValueError):
                publisher.verify_public({'images': images})
            registry.assert_not_called()


class DebianMetadata(unittest.TestCase):
    def package(self, path, control):
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode='w:xz') as archive:
            entry = tarfile.TarInfo('./control'); entry.size = len(control)
            archive.addfile(entry, io.BytesIO(control))
        member = content.getvalue()
        header = f'{"control.tar.xz/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(member):<10}`\n'.encode()
        path.write_bytes(b'!<arch>\n' + header + member)

    def test_reads_package_on_hosts_without_dpkg(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'chrome.deb'
            self.package(path, b'Package: chrome\nVersion: 155.0-1\nArchitecture: amd64\nDescription: browser\n continued\n')
            self.assertEqual(assets.deb_metadata(path), {'Version': '155.0-1', 'Architecture': 'amd64'})

    def test_missing_duplicate_and_non_archive_metadata_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'chrome.deb'
            for control in [b'Package: chrome\n', b'Version: 1\nVersion: 2\nArchitecture: amd64\n']:
                self.package(path, control)
                with self.assertRaises(ValueError): assets.deb_metadata(path)
            path.write_bytes(b'invalid')
            with self.assertRaises(ValueError): assets.deb_metadata(path)


if __name__ == '__main__': unittest.main()
