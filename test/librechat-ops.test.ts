import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { SchedulerStore } from '../src/scheduling/store.js';
import { backupHealth, httpHealth, ledgerHealth } from '../scripts/check-librechat-health.js';
import { command, exitCode, privateFile, probe } from '../scripts/librechat-ops.js';
import { backupName } from '../scripts/verify-librechat-backup.js';

test('health probes preserve other results and never emit private command/exception data', async () => {
  const secret = 'password-or-private-page-must-not-appear';
  const checks = await Promise.all([
    probe('database', async () => { throw new Error(secret); }),
    probe('other_service', async () => ({ status: 'ok' })),
    probe('command', async () => { await command(process.execPath, ['-e', `console.log('${secret}'); console.error('${secret}'); process.exit(1)`]); return { status: 'ok' }; }),
  ]);
  assert.equal(exitCode(checks), 2);
  assert.equal(checks[1].status, 'ok');
  assert.ok(!JSON.stringify(checks).includes(secret));
  assert.equal(exitCode([{ name: 'old_backup', status: 'warning' }]), 1);
});

test('empty/pruned history is healthy; overdue leases and stalled outbox fail without modifying the ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lc-health-ledger-'));
  const path = join(directory, 'scheduler.sqlite');
  const now = 1800000000000;
  const store = new SchedulerStore(path, 5, () => now - 300000);
  try {
    assert.equal(ledgerHealth(path, 5, 600, now).status, 'ok');
    const lease = store.acquire({ userId: 'private-user-id', conversationId: 'private-chat', taskId: 'private-task' }, { acquisitionId: 'a', purpose: 'private-page-content', url: 'https://private.example/secret' });
    store.update(lease.id, { state: 'active', expiresAt: now - 120000 }, 'slot_ready');
    const before = readLedger(path);
    const check = ledgerHealth(path, 5, 600, now);
    assert.equal(check.status, 'error');
    assert.equal(check.metrics?.overdue, 1);
    assert.equal(check.metrics?.delayedEvents, 1);
    assert.equal(check.metrics?.occupied, 1);
    assert.ok(!JSON.stringify(check).includes('private'));
    assert.deepEqual(readLedger(path), before);
    store.update(lease.id, { state: 'cleanup_pending', expiresAt: null });
    store.ack(1);
    assert.equal(ledgerHealth(path, 5, 600, now).status, 'warning');
    assert.equal(ledgerHealth(path, 11, 600, now).status, 'error');
    assert.throws(() => ledgerHealth(join(directory, 'missing.sqlite'), 5));
    await assert.rejects(readFile(join(directory, 'missing.sqlite')), { code: 'ENOENT' });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

function readLedger(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { leases: db.prepare('SELECT * FROM leases').all(), events: db.prepare('SELECT * FROM events').all(), consumers: db.prepare('SELECT * FROM consumers').all() }; }
  finally { db.close(); }
}

test('fresh asset backups cannot hide stale data; restore evidence binds to actual archive bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lc-health-backup-'));
  const report = join(directory, 'verification.json');
  const now = Date.now();
  const bytes = Buffer.from('fixture archive');
  try {
    await mkdir(join(directory, 'database'), { mode: 0o700 });
    await writeFile(join(directory, 'database/manifest.json'), JSON.stringify({ createdAt: new Date(now - 48 * 3600000) }), { mode: 0o600 });
    const archive = join(directory, 'database/production-mongo.archive.gz');
    await writeFile(archive, bytes, { mode: 0o600 });
    await mkdir(join(directory, 'new-assets'), { mode: 0o700 });
    await writeFile(join(directory, 'new-assets/manifest.json'), JSON.stringify({ createdAt: new Date(now) }), { mode: 0o600 });
    await writeFile(join(directory, 'new-assets/agent.archive.gz'), 'not a full DB', { mode: 0o600 });
    let checks = await backupHealth(directory, report, now);
    assert.equal(checks[0].metrics?.ageHours, 48);
    assert.equal(checks[0].status, 'warning');
    assert.equal(checks[1].status, 'warning');
    await writeFile(report, JSON.stringify({ passed: true, cleanup: { passed: true }, archiveSHA256: createHash('sha256').update(bytes).digest('hex') }));
    checks = await backupHealth(directory, report, now);
    assert.equal(checks[1].status, 'ok');
    await writeFile(archive, 'modified archive');
    assert.equal((await backupHealth(directory, report, now))[1].status, 'warning');
    await chmod(archive, 0o644);
    assert.equal((await backupHealth(directory, report, now))[0].status, 'error');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an HTML error page or failing health body cannot pass an HTTP JSON probe', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"status":"failed"}');
    } else if (request.url === '/mcp') {
      response.writeHead(404); response.end('Not found');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html>Private error text</html>');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await probe('config', () => httpHealth(`${origin}/api/config`, 200, 'json'))).status, 'error');
    assert.equal((await httpHealth(`${origin}/health`, 200, 'json')).status, 'error');
    assert.equal((await httpHealth(`${origin}/mcp`, 404)).status, 'ok');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('backup verification refuses traversal, implicit execution, public files and symlinks', async () => {
  assert.throws(() => backupName([]));
  assert.throws(() => backupName(['--run', '../production']));
  assert.throws(() => backupName(['--run', '/data']));
  assert.throws(() => backupName(['--run', 'backup', '--unexpected']));
  assert.equal(backupName(['--run', '20261022T204507Z']), '20261022T204507Z');
  const directory = await mkdtemp(join(tmpdir(), 'lc-health-private-'));
  try {
    const path = join(directory, 'archive');
    await writeFile(path, 'private-data', { mode: 0o600 });
    await symlink(path, join(directory, 'link'));
    await assert.rejects(privateFile(join(directory, 'link')));
    await chmod(path, 0o644);
    await assert.rejects(privateFile(path));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
