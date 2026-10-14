import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeMount } from '../src/runtime-mounts.js';
import { readConfig } from '../src/config.js';

test('runtime volume mounts grant only an existing subdirectory and reject root/traversal/symlink escape', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-volume-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data'); await mkdir(join(data, 'profiles', 'fixture', 'chrome'), { recursive: true });
  const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(data, 'escape'));
  const volume = { name: 'fixture-private-data', root: data };
  assert.equal(await runtimeMount(join(data, 'profiles/fixture/chrome'), '/profile', volume), 'type=volume,src=fixture-private-data,dst=/profile,volume-subpath=profiles/fixture/chrome,volume-nocopy');
  assert.equal(await runtimeMount(join(data, 'profiles/fixture/chrome'), '/egress', volume, true), 'type=volume,src=fixture-private-data,dst=/egress,volume-subpath=profiles/fixture/chrome,volume-nocopy,readonly');
  for (const path of [data, outside, join(data, '../outside'), join(data, 'escape'), join(data, 'missing')]) await assert.rejects(runtimeMount(path, '/profile', volume));
  await assert.rejects(runtimeMount(outside, '/profile', { ...volume, name: 'name,other=mount' }));
  assert.match(await runtimeMount(outside, '/profile'), /^type=bind,src=/);
});

test('demo volume paths preserve the parent volume root while isolating demo data', () => {
  const config = readConfig({ BROWSER_AUTH_MODE: 'demo', BROWSER_MODE: 'docker', BROWSER_DATA_DIR: '/data', BROWSER_DATA_VOLUME: 'fixture-private-data' });
  assert.equal(config.dataDirectory, '/data/public-demo');
  assert.deepEqual(config.runtimeVolume, { name: 'fixture-private-data', root: '/data' });
  assert.throws(() => readConfig({ BROWSER_AUTH_MODE: 'team', BROWSER_MODE: 'docker', BROWSER_DATA_VOLUME: 'name,other=mount' }));
});

test('runtime platform is native by default and an explicit architecture remains constrained', () => {
  const base = { BROWSER_AUTH_MODE: 'team', BROWSER_MODE: 'docker' };
  assert.equal(readConfig(base).runtimePlatform, process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64');
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    assert.equal(readConfig({ ...base, BROWSER_RUNTIME_PLATFORM: platform }).runtimePlatform, platform);
  }
  assert.throws(() => readConfig({ ...base, BROWSER_RUNTIME_PLATFORM: 'linux/arm/v7' }));
});
