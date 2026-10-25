import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { open, readFile, readlink, readdir, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Invoked only by the parent inside the disposable Mongo network namespace.
const work = resolve(process.argv[2]);
const settings = JSON.parse(await readFile(resolve(work, 'settings.json'), 'utf8'));
assert.notEqual(await readlink('/proc/self/ns/net'), settings.hostNetworkNamespace);
assert.equal(process.version, settings.expectedNode);
const browser = resolve(work, 'agentic-browser'), librechat = resolve(work, 'librechat-agent');
const require = createRequire(resolve(librechat, 'package.json'));
require(resolve(work, 'modules.cjs'));
for (const name of ['@librechat/api', '@librechat/data-schemas', 'librechat-data-provider']) {
  assert.ok(require.resolve(name).startsWith(librechat + '/packages/'));
}
const { MongoClient } = require('mongodb'), Redis = require('ioredis'), jwt = require('jsonwebtoken');
const configDir = resolve(browser, '.deployment/librechat');
const privateEnv = parseEnv(await readFile(resolve(configDir, 'private.env'), 'utf8'));
const runtime = parseEnv(await readFile(resolve(configDir, 'production.env'), 'utf8'));
assert.equal(runtime.MONGO_URI, 'mongodb://127.0.0.1:27019/LibreChatBrowserDemo');
assert.equal(runtime.REDIS_URI, 'redis://127.0.0.1:6381');
const env = { ...privateEnv, ...runtime,
  PATH: `${resolve(work, 'bin')}:${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  NODE_OPTIONS: `--max-old-space-size=768 --require=${resolve(work, 'modules.cjs')}`,
  CONFIG_PATH: resolve(configDir, 'production.yaml'), BROWSER_ENV_FILE: resolve(configDir, 'private.env'),
  BROWSER_DATA_DIR: resolve(browser, '.data/librechat-browser'), RESTORE_DOCKER_DENIED: resolve(work, 'docker-denied'),
  // Keep the restored credentials on disk for integrity checks, but give runtime
  // outbound clients inert credentials in addition to kernel network isolation.
  QWEN_API_KEY: 'offline-restore-disabled', EMAIL_PASSWORD: 'offline-restore-disabled',
  EMAIL_HOST: '127.0.0.1', EMAIL_PORT: '9', TURNSTILE_SECRET_KEY: 'offline-restore-disabled',
};
const log = await open(resolve(work, 'applications.log'), 'w', 0o600);
const children = [];
const mongo = await MongoClient.connect(runtime.MONGO_URI), redis = new Redis(runtime.REDIS_URI);
let interrupted = false, phase = 'restored_state';
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function start(file, cwd, args = []) {
  const child = spawn(process.execPath, [...args, file], { cwd, env, stdio: ['ignore', log.fd, log.fd] });
  children.push(child); return child;
}
async function ready(url) {
  for (let i = 0; i < 70; i++) {
    if (interrupted) throw new Error('interrupted');
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) { await response.body?.cancel(); return; } } catch { /* bounded startup */ }
    await delay(500);
  }
  throw new Error('startup_timeout');
}
async function protectedState(db) {
  const users = await db.collection('users').find({}, { projection: { _id: 1, email: 1, password: 1, role: 1, provider: 1 } }).sort({ _id: 1 }).toArray();
  const balances = await db.collection('balances').find({}, { projection: { _id: 1, user: 1, tokenCredits: 1, reservedCredits: 1, autoRefillEnabled: 1, adminCredits: 1 } }).sort({ _id: 1 }).toArray();
  const messages = await db.collection('messages').find({}, { projection: { _id: 1, updatedAt: 1 } }).sort({ _id: 1 }).toArray();
  const transactions = await db.collection('transactions').find({}, { projection: { _id: 1, tokenValue: 1, updatedAt: 1 } }).sort({ _id: 1 }).toArray();
  return { users, accountHash: hash(users), balanceHash: hash(balances), messageHash: hash(messages), usageHash: hash(transactions) };
}
function assertIdleLedger() {
  const db = new DatabaseSync(resolve(env.BROWSER_DATA_DIR, 'scheduler.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases WHERE state IN ('queued','starting','active','closing','cleanup_pending')").get().n, 0);
  } finally { db.close(); }
}
async function assertIdleRedis() {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', '*stream:*', 'COUNT', 1000); cursor = next;
    for (const key of keys) if (key.endsWith(':running') || key.endsWith(':requires_action')) assert.equal(await redis.scard(key), 0);
  } while (cursor !== '0');
}
let report;
try {
  const db = mongo.db(), before = await protectedState(db);
  const budgetBefore = await db.collection('sitebudgets').findOne({ _id: 'global' });
  assert.ok(before.users.length > 0 && budgetBefore);
  const redisKeys = await redis.dbsize();
  assertIdleLedger(); await assertIdleRedis();
  phase = 'browser_startup'; start('src/service.ts', browser, ['--import', 'tsx']);
  await ready('http://127.0.0.1:8081/health'); await ready('http://127.0.0.1:8082/health');
  phase = 'librechat_bootstrap';
  const bootstrap = start('config/bootstrap-browser.cjs', librechat);
  assert.equal(await new Promise(resolve => bootstrap.once('exit', resolve)), 0);
  phase = 'librechat_startup'; start('api/server/index.js', librechat); await ready('http://127.0.0.1:3080/api/config');
  phase = 'authenticated_routes';
  const admin = before.users.find(user => user.role === 'ADMIN'), user = before.users.find(user => user.role === 'USER');
  assert.ok(admin && user);
  const token = account => jwt.sign({ id: String(account._id), provider: account.provider, issuedAtMs: Date.now() }, privateEnv.JWT_SECRET, { expiresIn: 60 });
  const get = (path, bearer) => fetch('http://127.0.0.1:3080' + path, { headers: { origin: runtime.DOMAIN_CLIENT, ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, signal: AbortSignal.timeout(5000) });
  const status = await get('/api/demo-admin', token(admin)); assert.equal(status.status, 200);
  const budgetStatus = await status.json(); assert.equal(budgetStatus.limitCredits, budgetBefore.limitCredits);
  const accounts = await get('/api/demo-admin/users', token(admin)); assert.equal(accounts.status, 200); assert.equal((await accounts.json()).total, before.users.length);
  assert.equal((await get('/api/demo-admin', token(user))).status, 403);
  assert.equal((await get('/api/demo-admin')).status, 401);
  const after = await protectedState(db); assert.equal(after.accountHash, before.accountHash); assert.equal(after.balanceHash, before.balanceHash);
  assert.equal(after.messageHash, before.messageHash); assert.equal(after.usageHash, before.usageHash);
  const budgetAfter = await db.collection('sitebudgets').findOne({ _id: 'global' });
  assert.equal(budgetAfter.limitCredits, budgetBefore.limitCredits); assert.equal(budgetAfter.revision, budgetBefore.revision);
  for (const [day, value] of Object.entries(budgetBefore.days)) assert.deepEqual(budgetAfter.days[day], value);
  assert.equal(budgetAfter.days[budgetStatus.day].spent, budgetBefore.days[budgetStatus.day]?.spent ?? 0);
  assert.equal(budgetAfter.days[budgetStatus.day].reserved, budgetBefore.days[budgetStatus.day]?.reserved ?? 0);
  phase = 'restored_assets';
  const home = await get('/'); assert.equal(home.status, 200); assert.match(await home.text(), /assets\//);
  const assets = (await readdir(resolve(librechat, 'client/dist/assets'))).filter(name => /^Admin\..*\.js$/.test(name)); assert.ok(assets.length);
  for (const name of assets) {
    const response = await get('/assets/' + name); assert.equal(response.status, 200);
    const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    const expected = createHash('sha256').update(await readFile(resolve(librechat, 'client/dist/assets', name))).digest('hex'); assert.equal(actual, expected);
  }
  assertIdleLedger(); await assertIdleRedis();
  await assert.rejects(access(env.RESTORE_DOCKER_DENIED), { code: 'ENOENT' });
  report = { passed: true, checks: ['restored_build_modules_loaded', 'mongo_accounts_password_hashes_roles_preserved', 'personal_balances_preserved', 'daily_budget_history_preserved', 'chat_and_usage_unchanged', 'redis_snapshot_loaded', 'browser_ledger_integrity', 'both_application_services_started', 'administrator_and_ordinary_permissions', 'restored_frontend_assets', 'no_old_jobs_resumed', 'no_docker_mutations_attempted'], accounts: before.users.length, redisKeys, adminAssets: assets.length, isolation: 'kernel network namespace without external routes' };
} catch {
  report = { passed: false, phase, failureCode: 'isolated_application_check_failed' }; process.exitCode = 2;
} finally {
  for (const child of children) if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.all(children.filter(child => child.exitCode == null).map(child => Promise.race([
    new Promise(resolve => child.once('exit', resolve)), delay(10000).then(() => { child.kill('SIGKILL'); }),
  ])));
  await mongo.close(); redis.disconnect(); await log.close();
  await writeFile(resolve(work, 'application-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
