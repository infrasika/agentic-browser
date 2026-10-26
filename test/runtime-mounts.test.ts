import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeMount } from '../src/runtime-mounts.js';

test('runtime volume mounts grant only an existing subdirectory and reject root/traversal/symlink escape', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-volume-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data'); await mkdir(join(data, 'runtimes', 'fixture-proxy'), { recursive: true });
  const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(data, 'escape'));
  const volume = { name: 'fixture-private-data', root: data };
  assert.equal(await runtimeMount(join(data, 'runtimes/fixture-proxy'), '/proxy', volume), 'type=volume,src=fixture-private-data,dst=/proxy,volume-subpath=runtimes/fixture-proxy,volume-nocopy');
  assert.equal(await runtimeMount(join(data, 'runtimes/fixture-proxy'), '/egress', volume, true), 'type=volume,src=fixture-private-data,dst=/egress,volume-subpath=runtimes/fixture-proxy,volume-nocopy,readonly');
  for (const path of [data, outside, join(data, '../outside'), join(data, 'escape'), join(data, 'missing')]) await assert.rejects(runtimeMount(path, '/proxy', volume));
  await assert.rejects(runtimeMount(outside, '/proxy', { ...volume, name: 'name,other=mount' }));
  assert.match(await runtimeMount(outside, '/proxy'), /^type=bind,src=/);
});
