import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as ctl from '../../deploy/agent/agentctl.mjs';
import { sleep } from '../../deploy/agent/lib/system.mjs';
import { temporary, backupFixture, fakeInstall } from './fixtures.mjs';
test('separate configuration refuses symlinks, installation overlap and existing initialization targets', () => temporary(async root => {
  const install = path.join(root, 'install'), config = path.join(root, 'config/local');
  assert.equal(ctl.configurationDirectory(install, config), config);
  assert.equal(ctl.configurationDirectory(install), path.join(install, 'config'));
  for (const bad of [root, install, path.join(install, 'data'), path.join(install, 'state'), 'relative', config + ':ro']) assert.throws(() => ctl.configurationDirectory(install, bad));
  fs.mkdirSync(config, { recursive: true, mode: 0o700 }); ctl.atomic(path.join(config, 'keep'), 'untouched');
  fs.symlinkSync(path.join(root, 'config'), path.join(root, 'linked'));
  assert.throws(() => ctl.configurationDirectory(install, path.join(root, 'linked/local')), /symlinks/);
  await assert.rejects(ctl.initialize(install, 'unused-release', 3333, true, config), /configuration_directory_already_exists/);
  assert.equal(fs.readFileSync(path.join(config, 'keep'), 'utf8'), 'untouched'); assert.ok(!fs.existsSync(install));
}));
test('configuration fingerprint reads only the selected private directory', () => temporary(async root => {
  const installRoot = path.join(root, 'install'), fixture = fakeInstall(installRoot), config = path.join(root, 'config');
  fs.mkdirSync(config, { mode: 0o700 });
  const job = Object.assign(Object.create(ctl.Installation.prototype), fixture, { configDirectory: config });
  ctl.atomic(path.join(config, 'settings.json'), { name: 'selected' });
  const first = await job.fingerprint();
  ctl.atomic(path.join(installRoot, 'config/settings.json'), { name: 'unused' }); assert.deepEqual(await job.fingerprint(), first);
  ctl.atomic(path.join(config, 'settings.json'), { name: 'changed' }); assert.notDeepEqual(await job.fingerprint(), first);
  fs.rmSync(config, { recursive: true });
  ctl.atomic(path.join(installRoot, 'installation.json'), { kind: ctl.KIND, project: 'agent-0123456789ab', uid: process.getuid(), gid: process.getgid(), configDirectory: config });
  assert.throws(() => new ctl.Installation(installRoot));
}));
test('storage is isolated and missing/symlinked data never starts an empty database', () => temporary(async root => {
  for (const n of ['first', 'restored']) fs.mkdirSync(path.join(root, n), { mode: 0o700 });
  const first = ctl.storageDirectory(path.join(root, 'first'), true), second = ctl.storageDirectory(path.join(root, 'restored'), true);
  ctl.atomic(path.join(first, 'mongo-data/keep'), 'keep'); assert.ok(!ctl.exists(path.join(second, 'mongo-data/keep')));
  fs.rmdirSync(path.join(second, 'mongo-data')); assert.throws(() => ctl.storageDirectory(path.join(root, 'restored')));
  fs.symlinkSync(path.join(first, 'mongo-data'), path.join(second, 'mongo-data')); assert.throws(() => ctl.storageDirectory(path.join(root, 'restored')));
  assert.equal(fs.readFileSync(path.join(first, 'mongo-data/keep'), 'utf8'), 'keep');
}));
test('volume transfer timeout removes only its own helper', () => temporary(async root => {
  const calls = []; const command = async args => { calls.push(args); if (args.includes('run')) throw new ctl.Failure('timeout'); return ''; };
  await assert.rejects(ctl.transferVolume('image', 'volume', 'agent-0123456789ab', path.join(root, 'archive'), false, command));
  assert.deepEqual(calls[1].slice(0, -1), [...ctl.DOCKER, 'rm', '-f']); assert.match(calls[1].at(-1), /^agent-0123456789ab-archive-/); assert.equal(calls[0][calls[0].indexOf('--name') + 1], calls[1].at(-1));
}));
test('changed configuration requires apply before any container action', () => temporary(async root => {
  const job = Object.assign(Object.create(ctl.Installation.prototype), fakeInstall(root));
  ctl.atomic(path.join(root, 'config/settings.json'), { name: 'before' }); ctl.atomic(path.join(root, 'state/applied.json'), await job.fingerprint());
  ctl.atomic(path.join(root, 'config/settings.json'), { name: 'after' }); job.render = () => assert.fail('render called');
  await assert.rejects(job.up(), /use apply/);
}));
test('release rejects mutable tags, missing services and implicit local image IDs', () => temporary(async root => {
  const file = path.join(root, 'release.json'), value = { version: 'preview', images: Object.fromEntries(['agent','browser','runtime','gateway','mongo','redis'].map(n => [n, 'sha256:' + 'a'.repeat(64)])) };
  ctl.atomic(file, value); assert.throws(() => ctl.releaseFile(file)); assert.deepEqual(ctl.releaseFile(file, true), value);
  for (const name of ['mongo','redis']) { const copy = structuredClone(value); delete copy.images[name]; ctl.atomic(file, copy); assert.throws(() => ctl.releaseFile(file, true), /invalid_release_images/); }
  value.images.agent = 'agent:latest'; ctl.atomic(file, value); assert.throws(() => ctl.releaseFile(file, true));
}));
test('backup validates checksums and rejects traversal, links and live runtime records', () => temporary(async root => {
  const safe = await backupFixture(path.join(root, 'safe')); assert.equal((await ctl.verifyBackup(safe)).kind, ctl.KIND);
  ctl.atomic(path.join(safe, 'secrets.env'), 'tampered'); await assert.rejects(ctl.verifyBackup(safe), /checksum/);
  for (const [i, bad] of ['../outside', '/outside', 'link', 'runtimes/live.json', './runtimes/live.json'].entries()) await assert.rejects(ctl.verifyBackup(await backupFixture(path.join(root, 'bad-' + i), bad)));
}));
test('atomic writes never follow private symlinks', () => temporary(async root => {
  ctl.atomic(path.join(root, 'original'), 'keep'); fs.symlinkSync(path.join(root, 'original'), path.join(root, 'link'));
  assert.throws(() => ctl.atomic(path.join(root, 'link'), 'replace')); assert.equal(fs.readFileSync(path.join(root, 'original'), 'utf8'), 'keep');
}));
test('failed pre-upgrade archive still restores stopped writers', () => temporary(async root => {
  const job = Object.assign(Object.create(ctl.Installation.prototype), fakeInstall(root)); let recovered = 0;
  job.enter = async () => ctl.atomic(job.intent, 'intent'); job.archive = async () => { throw new ctl.Failure('archive_failed'); }; job.recover = async () => { recovered++; };
  await assert.rejects(job.backup(true), /archive_failed/); assert.equal(recovered, 1);
}));
test('incomplete restore or upgrade never restarts services', () => temporary(async root => {
  const job = Object.assign(Object.create(ctl.Installation.prototype), fakeInstall(root)); job.compose = () => assert.fail('compose called');
  for (const phase of ['upgrading','upgrade_failed','restoring','restore_failed']) { ctl.atomic(job.intent, { kind: ctl.KIND, phase }); await assert.rejects(job.recover()); }
}));
test('operation lock excludes concurrent maintenance and is released normally', { skip: process.platform !== 'linux' && 'Linux deployment lock' }, () => temporary(async root => {
  const lock = path.join(root, 'lock'), unlock = await ctl.operationLock(lock);
  await assert.rejects(ctl.operationLock(lock), /operation_in_progress/); await unlock(); await (await ctl.operationLock(lock))();
}));
test('killing an operator releases its kernel lock without deleting a lock file', { skip: process.platform !== 'linux' && 'Linux deployment lock' }, () => temporary(async root => {
  const module = pathToFileURL(path.resolve('deploy/agent/lib/system.mjs')).href, lock = path.join(root, 'lock');
  const child = spawn(process.execPath, ['--input-type=module','-e',`import {operationLock} from ${JSON.stringify(module)}; await operationLock(${JSON.stringify(lock)}); console.log('ready'); await new Promise(r=>setTimeout(r,60000));`], { stdio: ['ignore','pipe','pipe'] }); child.stderr.resume();
  const done = new Promise(r => child.once('close', r));
  try { await new Promise((r,j) => { child.stdout.once('data', r); child.once('error',j); }); await assert.rejects(ctl.operationLock(lock)); child.kill('SIGKILL'); await done; await sleep(100); await (await ctl.operationLock(lock))(); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; }
}));
