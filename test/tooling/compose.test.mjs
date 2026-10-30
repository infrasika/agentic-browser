import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseEnv } from 'node:util';
import { initializeCompose } from '../../deploy/agent/app/compose-init.mjs';
import { composeFiles, writeCompose } from '../../scripts/build/package-compose.mjs';

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-compose-'));
  const options = { input: path.join(root, 'input'), config: path.join(root, 'config'), browser: path.join(root, 'browser'), gateway: path.join(root, 'gateway'), storage: [path.join(root, 'data')], owner: false };
  await fs.mkdir(options.input);
  const settings = { version: 1, origin: 'http://127.0.0.1:3333', adminEmail: 'admin@example.test', model: { name: 'fixture', baseURL: 'http://fixture:9000/v1', promptRate: 1, completionRate: 1 }, credits: {}, browser: {} };
  await fs.writeFile(path.join(options.input, 'settings.json'), JSON.stringify(settings));
  await fs.writeFile(path.join(options.input, 'secrets.env'), 'QWEN_API_KEY="synthetic-$key#value"\nDEMO_ADMIN_PASSWORD="Synthetic-Password-2026!"\n');
  try { await fn(options, settings, root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
test('Compose initializes private volumes and preserves keys and user data after interruption/restart', () => fixture(async options => {
  await initializeCompose(options);
  const identity = await fs.readFile(path.join(options.config, 'identity.json'), 'utf8');
  const secrets = parseEnv(await fs.readFile(path.join(options.config, 'agent'), 'utf8'));
  assert.equal(secrets.QWEN_API_KEY, 'synthetic-$key#value');
  assert.match(secrets.JWT_SECRET, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(path.join(options.config, 'identity.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(options.browser)).sort(), ['browser_token', 'settings.json']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.browser, 'settings.json'))), { origin: 'http://127.0.0.1:3333', maximum: 1 });
  await fs.writeFile(path.join(options.storage[0], 'keep'), 'existing-data');
  await fs.unlink(path.join(options.config, 'agent'));
  await initializeCompose(options);
  assert.equal(await fs.readFile(path.join(options.config, 'identity.json'), 'utf8'), identity);
  assert.deepEqual(parseEnv(await fs.readFile(path.join(options.config, 'agent'), 'utf8')), secrets);
  assert.equal(await fs.readFile(path.join(options.storage[0], 'keep'), 'utf8'), 'existing-data');
}));
test('Invalid Compose settings fail before changing persistent identity or generated configuration', () => fixture(async (options, settings) => {
  await initializeCompose(options);
  const before = await fs.readFile(path.join(options.config, 'settings.json'), 'utf8');
  settings.model.promptRate = null;
  await fs.writeFile(path.join(options.input, 'settings.json'), JSON.stringify(settings));
  await assert.rejects(initializeCompose(options), /model.promptRate/);
  assert.equal(await fs.readFile(path.join(options.config, 'settings.json'), 'utf8'), before);
}));
test('Compose refuses placeholder credentials and corrupt identity instead of rotating keys', () => fixture(async options => {
  const file = path.join(options.input, 'secrets.env'), original = await fs.readFile(file);
  await fs.writeFile(file, 'QWEN_API_KEY=CHANGE_ME_BEFORE_START\nDEMO_ADMIN_PASSWORD=CHANGE_ME_BEFORE_START\n');
  await assert.rejects(initializeCompose(options), /DEMO_ADMIN_PASSWORD/);
  await assert.rejects(fs.access(options.config));
  await fs.writeFile(file, original); await initializeCompose(options);
  await fs.writeFile(path.join(options.config, 'identity.json'), '{broken');
  await assert.rejects(initializeCompose(options), /identity is unreadable/);
  assert.equal(await fs.readFile(path.join(options.config, 'identity.json'), 'utf8'), '{broken');
}));
test('Compose distribution pins all images, rejects mutable releases and never overwrites user files', () => fixture(async (options, settings, root) => {
  const images = Object.fromEntries(['agent', 'browser', 'runtime', 'gateway', 'mongo', 'redis'].map(name => [name, 'example/' + name + '@sha256:' + 'a'.repeat(64)]));
  const files = composeFiles({ images });
  assert.deepEqual(Object.keys(files).sort(), ['COMPOSE.md', 'LICENSE', 'compose.yaml', 'secrets.env', 'settings.json']);
  assert.ok(!files['compose.yaml'].includes('@@'));
  assert.ok(!files['compose.yaml'].includes('driver_opts'));
  assert.throws(() => composeFiles({ images: { ...images, agent: 'example/agent:latest' } }), /Immutable/);
  const output = path.join(root, 'delivery'); writeCompose({ images }, output);
  await fs.writeFile(path.join(output, 'secrets.env'), 'private-user-value');
  assert.throws(() => writeCompose({ images }, output), /EEXIST/);
  assert.equal(await fs.readFile(path.join(output, 'secrets.env'), 'utf8'), 'private-user-value');
}));
test('Compose preserves literal dollar signs, hashes, quotes and backslashes in user credentials', () => fixture(async options => {
  const password = `Synthetic-"double"-'single'-$value#hash\\slash`;
  await fs.writeFile(path.join(options.input, 'secrets.env'), 'QWEN_API_KEY="synthetic-$key#value"\nDEMO_ADMIN_PASSWORD=`' + password + '`\n');
  await initializeCompose(options);
  assert.equal(parseEnv(await fs.readFile(path.join(options.config, 'agent'), 'utf8')).DEMO_ADMIN_PASSWORD, password);
}));

const { waitForGateway, redactDiagnostics } = await import('../acceptance/verify-compose.mjs');
test('Compose readiness waits for connection and proxy startup but rejects permanent errors', async () => {
  const pending = [new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }), new Response('', { status: 502 }), new Response('{"ready":true}')];
  let pauses = 0;
  assert.deepEqual(await waitForGateway('http://127.0.0.1:3350', { fetcher: async () => { const next = pending.shift(); if (next instanceof Error) throw next; return next; }, pause: async () => { pauses++; }, attempts: 3 }), { ready: true });
  assert.equal(pauses, 2);
  await assert.rejects(waitForGateway('http://127.0.0.1:3350', { fetcher: async () => new Response('', { status: 421 }), pause: async () => assert.fail('Permanent errors must not retry') }), /421/);
  await assert.rejects(waitForGateway('http://127.0.0.1:3350', { fetcher: async () => new Response('', { status: 503 }), pause: async () => {}, attempts: 2 }), /deadline/);
});
test('Compose diagnostics redact supplied and generated secrets and session tokens', () => {
  const result = redactDiagnostics('password=synthetic-password key=' + 'a'.repeat(64) + ' token=eyJabc.def.ghi', ['synthetic-password', 'a'.repeat(64)]);
  assert.equal(result, 'password=[REDACTED] key=[REDACTED] token=[REDACTED_JWT]');
});
