import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorkspace, startService } from './helpers.js';

const exec = promisify(execFile);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

test('public self-host download is reproducible, pinned, source-free, and available without credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentic-self-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await exec('python3', ['scripts/package-self-host.py']);
  const service = await startService({ create: async () => fakeWorkspace(), close: async () => {} });
  t.after(() => service.close());
  const download = '/self-host/download/agentic-browser-self-host.tar.gz';
  const response = await fetch(service.base + download);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
  const archive = Buffer.from(await response.arrayBuffer());
  const checksum = await fetch(service.base + '/self-host/download/SHA256SUMS');
  assert.equal(checksum.status, 200);
  assert.equal(await checksum.text(), `${hash(archive)}  agentic-browser-self-host.tar.gz\n`);
  const archivePath = join(directory, 'setup.tar.gz');
  await writeFile(archivePath, archive);
  const names = (await exec('tar', ['-tzf', archivePath])).stdout.trim().split('\n');
  assert.ok(names.includes('agentic-browser/compose.yaml'));
  assert.ok(names.includes('agentic-browser/scripts/compose.sh'));
  assert.ok(names.includes('agentic-browser/deploy/release.env'));
  for (const name of names) {
    assert.ok(name.startsWith('agentic-browser/') && !name.split('/').includes('..'));
    assert.doesNotMatch(name, /(?:^|\/)(?:src|test|\.git|\.data|node_modules|output)(?:\/|$)|\.(?:ts|log)$|\/(?:\.env|\.env\.public|\.env\.compose)$/);
  }
  await exec('tar', ['-xzf', archivePath, '-C', directory]);
  const root = join(directory, 'agentic-browser');
  const manifest = JSON.parse(await readFile(join(root, 'SETUP.json'), 'utf8'));
  assert.equal(manifest.kind, 'public-self-host-configuration');
  assert.equal(names.length, Object.keys(manifest.files).length + 1);
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert.equal(hash(await readFile(join(root, name))), digest);
  }
  const pinsPath = join(root, 'deploy/release.env');
  const pins = await readFile(pinsPath, 'utf8');
  assert.equal(pins, await readFile('deploy/release.env', 'utf8'));
  for (const kind of ['controller', 'runtime']) {
    assert.match(manifest.images[kind], /^ghcr\.io\/infrasika\/agentic-browser-(?:controller|runtime)@sha256:[a-f0-9]{64}$/);
    assert.ok(pins.includes(`AB_${kind.toUpperCase()}_IMAGE=${manifest.images[kind]}\n`));
  }
  // Local secrets added beside the allowlisted files cannot enter the archive.
  await writeFile(join(root, '.env'), 'PRIVATE_SENTINEL=do-not-publish\n');
  const output = join(directory, 'rebuilt');
  const build = () => exec('python3', ['scripts/package-self-host.py', '--root', root, '--output', output]);
  await build();
  assert.deepEqual(await readFile(join(output, 'agentic-browser-self-host.tar.gz')), archive);
  await writeFile(pinsPath, pins.replace(/@sha256:[a-f0-9]{64}/, ':latest'));
  await assert.rejects(build(), /immutable GHCR image pins/);
  await writeFile(pinsPath, pins);
  await rm(join(root, 'README.md'));
  await symlink(join(root, '.env'), join(root, 'README.md'));
  await assert.rejects(build(), /unsafe deployment file/);
  for (const path of ['/self-host/download/.env', '/self-host/download/src/main.ts', '/self-host/download/deploy/release.env', '/self-host-downloads/SHA256SUMS']) {
    assert.notEqual((await fetch(service.base + path)).status, 200, path);
  }
});
