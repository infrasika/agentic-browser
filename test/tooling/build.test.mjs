import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { platforms, checkout, committedCheckout, runtimeAssets } from '../../scripts/build/build-agent-images.mjs';
import { prepare } from '../../scripts/build/prepare-librechat.mjs';
import { debMetadata, download, inspectCrx } from '../../scripts/build/fetch-runtime-assets.mjs';
import { run, sha } from '../../deploy/agent/lib/system.mjs';
import { temporary } from './fixtures.mjs';
import * as tar from 'tar';
test('platform selection is explicit and duplicate-free', () => {
  assert.deepEqual(platforms('linux/amd64,linux/arm64'), ['linux/amd64','linux/arm64']);
  for (const value of ['darwin/arm64','','linux/amd64,linux/amd64','linux/386']) assert.throws(() => platforms(value));
});
test('tampered source patch fails before network or checkout', () => temporary(async root => {
  const integration = path.join(root,'repo/integrations/librechat'); fs.mkdirSync(integration,{recursive:true});
  fs.writeFileSync(path.join(integration,'source.lock.json'),JSON.stringify({format:1,repository:'https://github.com/LibreChat-AI/LibreChat.git',commit:'a'.repeat(40),tree:'b'.repeat(40),patchSha256:sha('accepted')}));
  fs.writeFileSync(path.join(integration,'customizations.patch'),'tampered');
  await assert.rejects(prepare(path.join(root,'repo'),path.join(root,'checkout')),/checksum/); assert.ok(!fs.existsSync(path.join(root,'checkout')));
}));
test('ARM context copies only ARM locked browser assets', () => temporary(async root => {
  const context = path.join(root,'context'); fs.mkdirSync(path.join(context,'runtime'),{recursive:true});
  const cache = path.join(root,'output/runtime/packages'); fs.mkdirSync(cache,{recursive:true});
  fs.writeFileSync(path.join(cache,'chrome-arm64.deb'),'arm fixture'); fs.writeFileSync(path.join(cache,'chrome-amd64.deb'),'unrelated');
  fs.writeFileSync(path.join(context,'runtime/assets.lock.json'),JSON.stringify({chromeArm64:{sha256:sha('arm fixture')},extensions:[]}));
  assert.deepEqual(Object.keys(await runtimeAssets(root,context,'arm64')),['chrome-arm64.deb']); assert.ok(!fs.existsSync(path.join(context,'output/runtime/packages/chrome-amd64.deb')));
  fs.writeFileSync(path.join(cache,'chrome-arm64.deb'),'changed'); await assert.rejects(runtimeAssets(root,path.join(root,'context'),'arm64'),/mismatch/);
}));
test('working and committed contexts exclude untracked secrets and preserve readability', () => temporary(async root => {
  const repo = path.join(root,'repo'); fs.mkdirSync(repo); await run(['git','init','-q',repo]);
  fs.mkdirSync(path.join(repo,'src/api'),{recursive:true}); fs.writeFileSync(path.join(repo,'src/api/actions.ts'),'committed'); fs.writeFileSync(path.join(repo,'run.sh'),'#!/bin/sh\nexit 0\n',{mode:0o755}); fs.writeFileSync(path.join(repo,'private.env'),'secret');
  await run(['git','add','src','run.sh'],{cwd:repo}); await run(['git','-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture'],{cwd:repo});
  fs.writeFileSync(path.join(repo,'src/api/actions.ts'),'working edit');
  const old = process.umask(0o077);
  try { await checkout(repo,path.join(root,'working')); await committedCheckout(repo,path.join(root,'committed'),'HEAD'); } finally {process.umask(old);}
  assert.equal(fs.readFileSync(path.join(root,'working/src/api/actions.ts'),'utf8'),'working edit'); assert.equal(fs.readFileSync(path.join(root,'committed/src/api/actions.ts'),'utf8'),'committed');
  for(const kind of ['working','committed']) {assert.ok(!fs.existsSync(path.join(root,kind,'private.env'))); assert.equal(fs.statSync(path.join(root,kind,'src/api')).mode & 0o777,0o755); assert.equal(fs.statSync(path.join(root,kind,'run.sh')).mode & 0o777,0o755);}
}));
test('CRX parsing refuses unsigned and malformed packages', () => {
  for (const data of [Buffer.alloc(0),Buffer.from('Cr24'),Buffer.alloc(128)]) assert.throws(() => inspectCrx(data,'a'.repeat(32)));
});
test('Debian metadata is read without dpkg, and malformed archives fail', () => temporary(async root => {
  fs.writeFileSync(path.join(root, 'control'), 'Package: fixture\nVersion: 1.2.3-1\nArchitecture: arm64\n');
  const archive = path.join(root, 'control.tar.gz');
  await tar.c({ cwd: root, file: archive, gzip: true }, ['control']);
  const data = fs.readFileSync(archive);
  const header = 'control.tar.gz/'.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(data.length).padEnd(10) + '`\n';
  const file = path.join(root, 'fixture.deb');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('!<arch>\n' + header), data, data.length % 2 ? Buffer.from('\n') : Buffer.alloc(0)]));
  assert.deepEqual(await debMetadata(file), { Version: '1.2.3-1', Architecture: 'arm64' });
  fs.truncateSync(file, 65); await assert.rejects(debMetadata(file), /Truncated/);
}));
test('downloads retry past stale partial files and reject changed or symlinked caches', t => temporary(async root => {
  const file = path.join(root, 'asset'), data = Buffer.from('locked package');
  fs.writeFileSync(file + '.partial', 'interrupted');
  t.mock.method(globalThis, 'fetch', async () => new Response(data));
  assert.deepEqual(await download('https://example.test/package', file, sha(data)), data);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('cached content must avoid network'); });
  assert.deepEqual(await download('https://example.test/package', file, sha(data)), data);
  t.mock.restoreAll(); t.mock.method(globalThis, 'fetch', async () => new Response('changed'));
  await assert.rejects(download('https://example.test/package', path.join(root, 'new'), sha(data)), /upstream package changed/);
  fs.symlinkSync(file, path.join(root, 'link'));
  await assert.rejects(download('https://example.test/package', path.join(root, 'link'), sha(data)), /symlinks/);
}));
