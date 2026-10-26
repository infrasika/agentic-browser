import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const script = resolve('scripts/librechat-config.mjs');
test('LibreChat private setup preserves credentials, restricts permissions, and doctor never reveals values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-config-'));
  try {
    await exec(process.execPath, [script, 'setup', '--config-dir', directory]);
    const path = join(directory, 'private.env');
    const content = await readFile(path, 'utf8');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(!content.includes('DOMAIN_SERVER='));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await exec(process.execPath, [script, 'setup', '--config-dir', directory]);
    assert.equal(await readFile(path, 'utf8'), content);
    const secret = 'private-key-must-never-be-logged';
    await writeFile(path, content.replace('QWEN_API_KEY=', `QWEN_API_KEY=${secret}`));
    try { await exec(process.execPath, [script, 'check', '--config-dir', directory]); assert.fail('Missing config must block production'); }
    catch (error) {
      const result = error as Error & { stdout: string; stderr: string; code: number };
      assert.equal(result.code, 2);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
      const report = JSON.parse(result.stdout);
      assert.equal(report.ready, false);
      assert.ok(!report.missing.includes('QWEN_API_KEY'));
      assert.ok(report.missing.includes('QWEN_BASE_URL'));
    }
    await rm(path);
    const target = join(directory, 'unrelated');
    await writeFile(target, secret);
    await symlink(target, path);
    await assert.rejects(exec(process.execPath, [script, 'setup', '--config-dir', directory]));
    assert.equal(await readFile(target, 'utf8'), secret);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private configuration rejects obsolete keys, unsafe origins, and unverified runtime references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-config-audit-'));
  try {
    await exec(process.execPath, [script, 'setup', '--config-dir', directory]);
    const path = join(directory, 'private.env');
    const content = (await readFile(path, 'utf8')).replace('DOMAIN_CLIENT=https://agentic-browser.zkpass.org', 'DOMAIN_CLIENT=https://user:secret@example.test/path')
      .replace('BROWSER_RUNTIME_IMAGE=', 'BROWSER_RUNTIME_IMAGE=runtime:latest').replace('BROWSER_MAX_SESSIONS=5', 'BROWSER_MAX_SESSIONS=11') + '\nDOMAIN_SERVER=https://unused.example.test\n';
    await writeFile(path, content);
    await assert.rejects(exec(process.execPath, [script, 'check', '--config-dir', directory]), (error: any) => {
      const report = JSON.parse(error.stdout);
      assert.deepEqual(report.unknown, ['DOMAIN_SERVER']);
      for (const key of ['DOMAIN_CLIENT', 'BROWSER_RUNTIME_IMAGE', 'BROWSER_MAX_SESSIONS']) assert.ok(report.invalid.includes(key));
      assert.ok(!error.stdout.includes('user:secret')); return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
