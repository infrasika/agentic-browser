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
