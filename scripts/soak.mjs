#!/usr/bin/env node
// External verifier only. Never load a deployment's .env or build new images.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const env = { ...process.env };
for (const kind of ['CONTROLLER', 'RUNTIME']) {
  const key = `AB_${kind}_IMAGE`;
  const prefix = `${key}=`;
  const lines = readFileSync('deploy/release.env', 'utf8').split('\n').filter(line => line.startsWith(prefix));
  assert.equal(lines.length, 1, `Expected one accepted ${kind} pin`);
  const image = lines[0].slice(prefix.length);
  assert.match(image, new RegExp(`^ghcr\\.io/infrasika/agentic-browser-${kind.toLowerCase()}@sha256:[a-f0-9]{64}$`));
  env[key] = image;
}
env.AB_RELIABILITY_SOAK_MINUTES ??= '120';
env.AB_RELIABILITY_ROUNDS ??= '1';
env.AB_RELIABILITY_HOLD_SECONDS ??= '120';
const minutes = Number(env.AB_RELIABILITY_SOAK_MINUTES);
assert.ok(Number.isInteger(minutes) && minutes >= 1 && minutes <= 120, 'Soak duration must be 1-120 minutes');
assert.ok(Number(env.AB_RELIABILITY_HOLD_SECONDS) > 0, 'Soak hold interval must be positive');
for (const kind of ['CONTROLLER', 'RUNTIME']) {
  const result = spawnSync('docker', ['pull', env[`AB_${kind}_IMAGE`]], { env, stdio: 'inherit', timeout: 300000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot pull accepted ${kind} image`);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/reliability.integration.ts'], { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
