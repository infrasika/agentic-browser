#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

assert.equal(process.argv.length, 2, 'Usage: npm run test:remote-client');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/self-host.integration.ts'], {
  env: { ...process.env, AB_ACCEPTANCE_REMOTE_CLIENT: '1', AB_ACCEPTANCE_EXPERIENCE_MINUTES: '0' }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
