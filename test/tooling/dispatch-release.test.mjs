import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'scripts/build/dispatch-release.mjs');
function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-dispatch-'));
  const captured = path.join(dir, 'arguments');
  fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$DISPATCH_ARGS"\n', { mode: 0o755 });
  const invoke = (...args) => spawnSync(process.execPath, [script, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: dir, DISPATCH_ARGS: captured },
  });
  try { run({ invoke, captured }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('release rejects non-main branches and tags before invoking GitHub CLI', () => fixture(({ invoke, captured }) => {
  for (const ref of ['feature', 'refs/heads/main', 'refs/tags/main', 'v0.1.0-preview.10', '']) {
    const result = invoke('--ref', ref);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Releases only run from main/);
    assert.equal(fs.existsSync(captured), false);
  }
}));

test('release dispatches package version to main, preserves resume inputs and dry-run has no side effects', () => fixture(({ invoke, captured }) => {
  const version = 'v' + JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(invoke().status, 0);
  assert.deepEqual(fs.readFileSync(captured, 'utf8').trim().split('\n'), ['workflow', 'run', 'release-agent.yml', '--ref', 'main', '-f', 'version=' + version]);
  assert.equal(invoke('v1.2.3-preview.4', '--ref', 'main', '--build-run-id', '123').status, 0);
  assert.deepEqual(fs.readFileSync(captured, 'utf8').trim().split('\n'), ['workflow', 'run', 'release-agent.yml', '--ref', 'main', '-f', 'version=v1.2.3-preview.4', '-f', 'build_run_id=123']);
  fs.unlinkSync(captured);
  const dry = invoke('--dry-run');
  assert.equal(dry.status, 0); assert.match(dry.stdout, /Dry run:/);
  assert.equal(fs.existsSync(captured), false);
}));

test('release accepts RC versions and rejects unsupported versions before dispatch', () => fixture(({ invoke, captured }) => {
  assert.equal(invoke('v0.1.0-rc.1').status, 0);
  assert.deepEqual(fs.readFileSync(captured, 'utf8').trim().split('\n'), ['workflow', 'run', 'release-agent.yml', '--ref', 'main', '-f', 'version=v0.1.0-rc.1']);
  fs.unlinkSync(captured);
  for (const version of ['v0.1.0', 'v0.1.0-rc', 'v0.1.0-rc.x', 'v0.1.0-rc.1-extra', 'v0.1.0-beta.1', '0.1.0-rc.1']) {
    const result = invoke(version);
    assert.equal(result.status, 1, version);
    assert.match(result.stderr, /Use X.Y.Z-rc.N/);
    assert.equal(fs.existsSync(captured), false);
  }
}));
