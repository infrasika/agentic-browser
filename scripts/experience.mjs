#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
assert.ok(args.length <= 1 && (!args[0] || /^--minutes=\d+$/.test(args[0])), 'Usage: npm run test:experience -- --minutes=15');
const minutes = Number(args[0]?.split('=')[1] ?? process.env.AB_ACCEPTANCE_EXPERIENCE_MINUTES ?? 15);
assert.ok(Number.isInteger(minutes) && minutes >= 1 && minutes <= 60, 'Experience duration must be 1-60 minutes');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/self-host.integration.ts'], {
  env: { ...process.env, AB_ACCEPTANCE_EXPERIENCE_MINUTES: String(minutes) }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
