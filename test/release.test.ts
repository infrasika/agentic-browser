import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig } from '../src/config.js';

const exec = promisify(execFile);
test('stable publication: latest preserves immutable digests and rejects prereleases, downgrades and partial publication', async () => {
  await exec('python3', ['test/release_channel.py']);
});
test('release deployment pins override local tags and reject executable or mutable image configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentic-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pins = join(directory, 'release.env'), settings = join(directory, 'compose.env');
  const controller = `ghcr.io/infrasika/agentic-browser-controller@sha256:${'a'.repeat(64)}`;
  const runtime = `ghcr.io/infrasika/agentic-browser-runtime@sha256:${'b'.repeat(64)}`;
  await writeFile(settings, 'AB_CONTROLLER_IMAGE=untrusted:latest\nAB_PROJECT_NAME=release-fixture\n');
  const env = { ...process.env, AB_RELEASE_FILE: pins, AB_COMPOSE_ENV_FILE: settings, AB_DOCKER_GID: '0', AB_CONTROLLER_IMAGE: 'untrusted:latest' };
  const run = () => exec('bash', ['scripts/release-compose.sh', 'config', '--format', 'json'], { env });
  await writeFile(pins, `AB_CONTROLLER_IMAGE=${controller}\nAB_RUNTIME_IMAGE=${runtime}\n`);
  const rendered = JSON.parse((await run()).stdout);
  assert.equal(rendered.services.controller.image, controller);
  assert.equal(rendered.services.controller.environment.BROWSER_RUNTIME_IMAGE, runtime);
  assert.equal(rendered.services.controller.environment.BROWSER_RUNTIME_PLATFORM, 'auto');
  await writeFile(pins, `AB_CONTROLLER_IMAGE=ghcr.io/infrasika/agentic-browser-controller:latest\nAB_RUNTIME_IMAGE=${runtime}\n`);
  await assert.rejects(run(), /sha256 digest/);
  const sentinel = join(directory, 'must-not-exist');
  await writeFile(pins, `AB_CONTROLLER_IMAGE=$(touch ${sentinel})\nAB_RUNTIME_IMAGE=${runtime}\n`);
  await assert.rejects(run(), /sha256 digest/);
  await assert.rejects(access(sentinel));
});

test('private image settings map from the deployment file with documented defaults and shell overrides', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentic-compose-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = join(directory, 'compose.env');
  const env = { ...process.env, AB_COMPOSE_ENV_FILE: settings, AB_DOCKER_GID: '0',
    AB_COMPOSE_VARIANT: '', AB_RELEASE_FILE: 'deploy/release.env' };
  // Ensure a developer's exported overrides cannot affect the default assertions.
  for (const name of ['AB_MAX_SESSIONS', 'AB_MAX_SESSIONS_PER_MEMBER', 'AB_SESSION_TTL_SECONDS',
    'AB_SESSION_MAX_LIFETIME_SECONDS', 'AB_PUBLIC_URL', 'AB_PORT']) delete env[name as keyof typeof env];
  const render = async (overrides = {}) => JSON.parse((await exec('bash',
    ['scripts/release-compose.sh', 'config', '--format', 'json'], { env: { ...env, ...overrides } })).stdout);
  await writeFile(settings, '');
  const defaults = readConfig((await render()).services.controller.environment);
  assert.equal(defaults.maxSessions, 1);
  assert.equal(defaults.maxSessionsPerOwner, 1);
  assert.equal(defaults.ttlMs, 1800_000);
  assert.equal(defaults.maxLifetimeMs, 14400_000);
  await writeFile(settings, 'AB_PORT=8081\nAB_PUBLIC_URL=https://browser.example.test\nAB_MAX_SESSIONS=5\nAB_MAX_SESSIONS_PER_MEMBER=2\nAB_SESSION_TTL_SECONDS=600\nAB_SESSION_MAX_LIFETIME_SECONDS=7200\n');
  const service = (await render()).services.controller;
  const configured = readConfig(service.environment);
  assert.equal(configured.publicUrl, 'https://browser.example.test');
  assert.equal(configured.maxSessions, 5);
  assert.equal(configured.maxSessionsPerOwner, 2);
  assert.equal(configured.ttlMs, 600_000);
  assert.equal(configured.maxLifetimeMs, 7200_000);
  assert.equal(configured.port, 3333, 'Host port changes do not change the internal port');
  assert.equal(service.ports[0].published, '8081');
  assert.equal(readConfig((await render({ AB_MAX_SESSIONS: '3' })).services.controller.environment).maxSessions, 3);
  assert.equal(readConfig((await render()).services.controller.environment).maxSessions, 5, 'Shell overrides do not rewrite the file');
  // Container variable names in the deployment file are not arbitrary passthrough.
  await writeFile(settings, 'MAX_SESSIONS=9\nPUBLIC_URL=https://ignored.example.test\n');
  const unmapped = readConfig((await render()).services.controller.environment);
  assert.equal(unmapped.maxSessions, 1);
  assert.equal(unmapped.publicUrl, 'http://127.0.0.1:3333');
  await writeFile(settings, "AB_MODE=authenticated\nAB_ADMIN_USERNAME=alice\nAB_ADMIN_PASSWORD='synthetic-$literal-#password'\nAB_PORT=4444\n");
  const authenticated = readConfig((await render()).services.controller.environment);
  assert.equal(authenticated.authMode, 'team');
  // Compose config escapes dollars for round-tripping; container acceptance checks the actual value.
  assert.equal(authenticated.bootstrapAdmin?.password, 'synthetic-$$literal-#password');
  assert.equal(authenticated.publicUrl, 'http://127.0.0.1:4444');
  await writeFile(settings, 'AB_MODE=public\nAB_MAX_SESSIONS=5\nAB_MAX_SESSIONS_PER_IP=3\nAB_TRUST_PROXY=true\nAB_BIND_ADDRESS=0.0.0.0\n');
  const publicService = (await render()).services.controller;
  const publicConfig = readConfig(publicService.environment);
  assert.equal(publicConfig.authMode, 'public');
  assert.equal(publicConfig.bootstrapAdmin, undefined);
  assert.equal(publicConfig.maxSessions, 5);
  assert.equal(publicConfig.publicMaxSessionsPerIp, 3);
  assert.equal(publicConfig.trustProxy, true);
  assert.equal(publicConfig.maxLifetimeMs, 600000);
  assert.equal(publicService.ports[0].host_ip, '0.0.0.0');
  await writeFile(settings, 'AB_MODE=team\n');
  const invalidMode = (await render()).services.controller.environment;
  assert.throws(() => readConfig(invalidMode));
});
