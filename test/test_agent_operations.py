import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import subprocess
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('agentctl',Path(__file__).resolve().parents[1]/'deploy/agent/agentctl.py')
cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)

class Operations(unittest.TestCase):
    def test_storage_is_owned_by_each_installation_and_missing_paths_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            first=Path(folder)/'first';second=Path(folder)/'restore'
            first.mkdir();second.mkdir()
            a=cli.storage_directory(first,create=True);b=cli.storage_directory(second,create=True)
            (a/'mongo-data/keep').write_text('original')
            self.assertNotEqual(a,b)
            self.assertFalse((b/'mongo-data/keep').exists())
            (b/'mongo-data').rmdir()
            with self.assertRaises(cli.Failure):cli.storage_directory(second)
            (b/'mongo-data').symlink_to(a/'mongo-data',target_is_directory=True)
            with self.assertRaises(cli.Failure):cli.storage_directory(second)
            self.assertEqual((a/'mongo-data/keep').read_text(),'original')

    def test_timed_out_volume_helper_is_removed_by_its_exact_name(self):
        with patch.object(cli.subprocess,'run',side_effect=subprocess.TimeoutExpired('docker',300)),patch.object(cli,'run') as cleanup:
            with self.assertRaises(cli.Failure):cli.transfer_volume('image','volume','agent-0123456789ab',io.BytesIO())
            args=cleanup.call_args.args[0]
            self.assertEqual(args[:-1],cli.DOCKER+['rm','-f'])
            self.assertTrue(args[-1].startswith('agent-0123456789ab-archive-'))

    def test_changed_running_configuration_requires_apply(self):
        with tempfile.TemporaryDirectory() as folder:
            job=object.__new__(cli.Installation);job.root=Path(folder)
            (job.root/'config').mkdir();(job.root/'state').mkdir()
            job.gate=job.root/'gate';job.intent=job.root/'intent'
            cli.atomic(job.root/'config/settings.json',{'name':'before'})
            cli.atomic(job.root/'state/applied.json',job.fingerprint())
            cli.atomic(job.root/'config/settings.json',{'name':'after'})
            with patch.object(job,'render') as render:
                with self.assertRaisesRegex(cli.Failure,'use apply'):job.up()
                render.assert_not_called()

    def test_releases_reject_mutable_tags_and_development_requires_explicit_flag(self):
        with tempfile.TemporaryDirectory() as folder:
            file=Path(folder)/'release.json'
            value={'version':'preview','images':dict.fromkeys(['agent','browser','runtime','gateway','mongo','redis'],'sha256:'+'a'*64)}
            file.write_text(json.dumps(value))
            with self.assertRaises(cli.Failure): cli.release_file(file)
            self.assertEqual(cli.release_file(file,True),value)
            for missing in ['mongo','redis']:
                incomplete={**value,'images':{k:v for k,v in value['images'].items() if k!=missing}}
                file.write_text(json.dumps(incomplete))
                with self.assertRaisesRegex(cli.Failure,'invalid_release_images'):cli.release_file(file,True)
            value['images']['agent']='agent:latest';file.write_text(json.dumps(value))
            with self.assertRaises(cli.Failure): cli.release_file(file,True)

    def test_backup_rejects_tampering_traversal_links_and_live_runtime_records(self):
        for bad in ['../outside','/outside','link','runtimes/live.json']:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as folder:
                directory=Path(folder)
                required={key+'.tar.gz' for key in cli.VOLUMES}|{'settings.json','secrets.env','browser-token','release.json','compose.yaml'}
                for name in required:
                    p=directory/name
                    if name.endswith('.tar.gz'):
                        with tarfile.open(p,'w:gz') as archive:
                            entry=tarfile.TarInfo(bad if name=='browser-data.tar.gz' else 'safe')
                            if bad=='link' and name=='browser-data.tar.gz': entry.type=tarfile.SYMTYPE;entry.linkname='/outside'
                            archive.addfile(entry,io.BytesIO())
                    else:p.write_text('{}')
                    p.chmod(0o600)
                cli.atomic(directory/'manifest.json',{'kind':cli.KIND,'files':{n:cli.digest(directory/n) for n in required}})
                with self.assertRaises(cli.Failure):cli.verify_backup(directory)

    def test_private_files_and_atomic_writes_refuse_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder);target=path/'original';target.write_text('keep');target.chmod(0o600)
            link=path/'link';link.symlink_to(target)
            with self.assertRaises(cli.Failure):cli.atomic(link,'replace')
            self.assertEqual(target.read_text(),'keep')

    def test_backup_recovers_after_archive_failure_even_when_preparing_upgrade(self):
        with tempfile.TemporaryDirectory() as folder:
            job=object.__new__(cli.Installation);job.root=Path(folder);job.intent=job.root/'intent'
            def enter(_):job.intent.write_text('intent')
            with patch.object(job,'enter',side_effect=enter),patch.object(job,'archive',side_effect=cli.Failure('archive_failed')),patch.object(job,'recover') as recover:
                with self.assertRaises(cli.Failure):job.backup(stay=True)
                recover.assert_called_once()

    def test_incomplete_upgrade_and_restore_never_start_services(self):
        for phase in ['upgrading','upgrade_failed','restoring','restore_failed']:
            with self.subTest(phase=phase),tempfile.TemporaryDirectory() as folder:
                job=object.__new__(cli.Installation);job.root=Path(folder);job.intent=job.root/'intent';job.gate=job.root/'gate'
                cli.atomic(job.intent,{'kind':cli.KIND,'phase':phase})
                with patch.object(job,'compose') as compose:
                    with self.assertRaises(cli.Failure):job.recover()
                    compose.assert_not_called()

if __name__=='__main__':unittest.main()
