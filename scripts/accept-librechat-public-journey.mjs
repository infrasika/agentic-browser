import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { readFile, mkdir, writeFile, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

// Explicit, bounded acceptance. Auth fixtures are provisioned through LibreChat's
// native methods; this is NOT a Turnstile/signup UI test. Credentials stay in memory.
// Production uses the public hostname; --acceptance uses isolated loopback services.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const acceptance = process.argv.includes('--acceptance');
if (mode !== '--run' && mode !== '--cleanup') {
  console.log('Usage: node scripts/accept-librechat-public-journey.mjs --run [--acceptance] | --cleanup RUN_UUID [--acceptance]');
  process.exit(0);
}
const runId = mode === '--cleanup' ? process.argv[3] : randomUUID();
assert.match(runId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const directory = resolve(root, `.deployment/librechat/${acceptance ? 'journey-acceptance' : 'public-acceptance'}`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const manifestPath = resolve(directory, `${runId}.json`);
const lockPath = resolve(directory, 'running.lock');
const lock = await open(lockPath, 'wx', 0o600);
await lock.writeFile(runId);
const origin = acceptance ? 'http://127.0.0.1:3081' : 'https://agentic-browser.zkpass.org';
const liveStates = ['queued', 'starting', 'active', 'closing', 'cleanup_pending'];
const checks = [];
const fixtures = [];
let stage = 'preflight';
let report;
let mongoose;
let db;
let methods;
let ledger;
let socket;
let manifest = { runId, createdAt: new Date().toISOString(), fixtures: [] };
let stopping = false;
const deadline = Date.now() + 6 * 60_000;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });

async function saveManifest() {
  manifest.fixtures = fixtures.map(({ id, email, conversationId }) => ({ id, email, conversationId }));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
}
function liveLeases() {
  return ledger.prepare("SELECT userId, conversationId, state FROM leases WHERE state IN ('queued','starting','active','closing','cleanup_pending')").all();
}
async function capacityGuard() {
  assert.ok(!stopping && Date.now() < deadline, 'Acceptance interrupted or deadline reached');
  const mem = await readFile('/proc/meminfo', 'utf8');
  assert.ok(Number(mem.match(/^MemAvailable:\s+(\d+)/m)?.[1]) > 3 * 1024 * 1024, 'Memory reserve reached');
  const ids = new Set(fixtures.map(f => f.id));
  assert.ok(liveLeases().every(lease => ids.has(lease.userId)), 'A public user needs capacity; yielding all test browsers');
}
async function request(fixture, path, body, method) {
  return fetch(origin + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      authorization: `Bearer ${fixture.token}`, origin, 'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
      'x-librechat-generation-protocol': '2', 'x-user-id': 'untrusted-client-header',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
}
async function call(fixture, path, body, method) {
  const response = await request(fixture, path, body, method);
  assert.ok(response.ok, `Public API returned HTTP ${response.status} during ${stage}`);
  return response.json();
}
const browserPath = fixture => `/api/agentic-browser/${fixture.conversationId}`;
async function waitForLease(fixture, predicate, maxMs = 60000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    await capacityGuard();
    const { lease } = await call(fixture, browserPath(fixture));
    if (predicate(lease)) return lease;
    await delay(1000);
  }
  assert.fail(`Browser transition deadline during ${stage}`);
}
async function startTask(fixture) {
  await capacityGuard();
  const messageId = randomUUID();
  const task = await call(fixture, '/api/agents/chat', {
    text: 'Open https://example.com and call browser_request_handoff so I can use it. Wait until I return control; then call browser_snapshot, report the page title, and close the browser.',
    sender: 'User', isCreatedByUser: true, parentMessageId: '00000000-0000-0000-0000-000000000000',
    conversationId: 'new', messageId, responseMessageId: `${messageId}_`, endpoint: 'agents',
    agent_id: 'agent_browser_demo', spec: 'browser-demo', isTemporary: false, isRegenerate: false,
  });
  assert.ok(task.conversationId);
  fixture.conversationId = task.conversationId;
  await saveManifest();
}
async function stopTask(fixture) {
  if (!fixture.conversationId) return;
  const { lease } = await call(fixture, browserPath(fixture));
  if (lease && liveStates.includes(lease.state)) await call(fixture, browserPath(fixture) + '/cancel', {});
  const job = await call(fixture, `/api/agents/chat/status/${fixture.conversationId}`);
  if (!job.active) return;
  const aborted = await request(fixture, '/api/agents/chat/abort', {
    conversationId: fixture.conversationId, generationCreatedAt: job.createdAt,
  });
  // The Browser recovery worker can abort the cancelled task between status and
  // this request. Accept that race only after observing the job is inactive.
  assert.ok(aborted.ok || [404, 409].includes(aborted.status), `Task abort returned HTTP ${aborted.status}`);
  await aborted.body?.cancel();
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await call(fixture, `/api/agents/chat/status/${fixture.conversationId}`);
    if (!current.active) return;
    await delay(500);
  }
  assert.fail('Fixture generation still active after cancellation');
}
async function cleanup() {
  socket?.terminate();
  // Recover creation if balance setup or manifest persistence failed afterwards.
  const created = await db.collection('users').find({
    email: { $regex: `^public-${runId}-[0-9]+@demo-acceptance\\.invalid$` }, role: 'USER',
  }).toArray();
  for (const user of created) {
    let fixture = fixtures.find(item => item.id === String(user._id));
    if (!fixture) {
      fixture = { id: String(user._id), email: user.email };
      fixtures.push(fixture);
    }
    fixture.token ??= await methods.generateToken(user, 900000);
  }
  const failures = [];
  const existingIds = new Set(created.map(user => String(user._id)));
  for (const fixture of fixtures) {
    if (!existingIds.has(fixture.id)) continue;
    try {
      // Admission may finish before its response/manifest write reaches this process.
      const conversations = await db.collection('conversations').find({ user: fixture.id }, { projection: { conversationId: 1 } }).toArray();
      const conversationIds = new Set(conversations.map(item => item.conversationId));
      if (fixture.conversationId) conversationIds.add(fixture.conversationId);
      for (const conversationId of conversationIds) await stopTask({ ...fixture, conversationId });
    } catch { failures.push('stop_task'); }
  }
  const ids = new Set(fixtures.map(f => f.id));
  for (let i = 0; i < 30 && liveLeases().some(lease => ids.has(lease.userId)); i++) await delay(1000);
  for (const fixture of fixtures) {
    if (liveLeases().some(lease => lease.userId === fixture.id)) {
      failures.push('browser_cleanup_pending');
      continue;
    }
    try {
      const user = await db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(fixture.id) });
      assert.match(fixture.email, new RegExp(`^public-${runId}-[0-9]+@demo-acceptance\\.invalid$`));
      if (user) {
        assert.equal(user.email, fixture.email);
        assert.equal(user.role, 'USER');
      }
      // Recover a task even if interruption occurred after admission but before its
      // conversation id was saved. The native delete route also prunes checkpoints.
      const conversations = await db.collection('conversations').find({ user: fixture.id }, { projection: { conversationId: 1 } }).toArray();
      if (!user) assert.equal(conversations.length, 0, 'Deleted fixture still has conversations; inspect privately');
      for (const conversation of conversations) {
        await call(fixture, '/api/convos', { arg: { conversationId: conversation.conversationId } }, 'DELETE');
      }
      assert.equal(await db.collection('messages').countDocuments({ user: fixture.id }), 0);
      if (user) await methods.deleteUserById(fixture.id); // Includes shared auth-cache eviction.
      const owner = { $in: [fixture.id, new mongoose.Types.ObjectId(fixture.id)] };
      for (const collection of ['balances', 'transactions', 'sessions', 'tokens', 'refreshtokenbridges'])
        await db.collection(collection).deleteMany({ user: owner });
      // Deleted fixture credentials must immediately stop authenticating.
      const rejected = await request(fixture, `/api/agentic-browser/${randomUUID()}`);
      assert.equal(rejected.status, 401);
      await rejected.body?.cancel();
    } catch { failures.push('fixture_cleanup'); }
  }
  assert.equal(failures.length, 0, `Fixture cleanup checks failed: ${[...new Set(failures)].join(',')}`);
  manifest.cleanedAt = new Date().toISOString();
  await saveManifest();
  return { accountsRemoved: fixtures.length, liveBrowsers: 0, deletedTokensRejected: true };
}

try {
  const privateEnv = parseEnv(await readFile(resolve(root, '.deployment/librechat/private.env'), 'utf8'));
  const runtimeEnv = parseEnv(await readFile(resolve(root, `.deployment/librechat/${acceptance ? 'acceptance' : 'production'}.env`), 'utf8'));
  assert.equal(runtimeEnv.DOMAIN_CLIENT, origin);
  assert.equal(runtimeEnv.MONGO_URI, `mongodb://127.0.0.1:27019/${acceptance ? 'LibreChatBrowserAcceptance' : 'LibreChatBrowserDemo'}`);
  Object.assign(process.env, privateEnv, runtimeEnv);
  const config = JSON.parse(await readFile(runtimeEnv.CONFIG_PATH, 'utf8'));
  if (acceptance) assert.equal(config.turnstile, undefined);
  else assert.equal(config.turnstile.verification.required, true);
  assert.equal(config.balance.autoRefillEnabled, false);
  const service = await readFile(resolve(root, '.deployment/librechat/agentic-browser-service.service'), 'utf8');
  const capacity = acceptance ? 1 : Number(service.match(/BROWSER_MAX_SESSIONS=(\d+)/)?.[1]);
  assert.ok(capacity >= 1 && capacity <= 5, 'This acceptance script is bounded to at most five browsers');
  ledger = new DatabaseSync(resolve(root, `.data/${acceptance ? 'librechat-acceptance' : 'librechat-browser'}/scheduler.sqlite`), { readOnly: true });
  if (mode === '--run') {
    assert.equal(liveLeases().length, 0, 'Public users have live sessions; rerun when idle');
    const mem = await readFile('/proc/meminfo', 'utf8');
    assert.ok(Number(mem.match(/^MemAvailable:\s+(\d+)/m)?.[1]) > (capacity + 3) * 1024 * 1024, 'Insufficient memory for bounded public acceptance');
  }
  const checkout = resolve(root, '../librechat-agent');
  const require = createRequire(resolve(checkout, 'package.json'));
  mongoose = require('mongoose');
  require('@librechat/data-schemas').createModels(mongoose);
  require('module-alias')({ base: resolve(checkout, 'api') });
  methods = require(resolve(checkout, 'api/models'));
  await mongoose.connect(runtimeEnv.MONGO_URI);
  db = mongoose.connection.db;
  if (mode === '--cleanup') {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.runId, runId);
    for (const fixture of manifest.fixtures) {
      assert.match(fixture.email, new RegExp(`^public-${runId}-[0-9]+@demo-acceptance\\.invalid$`));
      const user = await db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(fixture.id) });
      if (user) {
        assert.equal(user.email, fixture.email);
        assert.equal(user.role, 'USER');
      }
      // Also verify already-deleted fixtures and finish any interrupted ledger cleanup.
      const token = await methods.generateToken(user ?? {
        _id: new mongoose.Types.ObjectId(fixture.id), email: fixture.email, provider: 'local',
      }, 900000);
      fixtures.push({ ...fixture, token });
    }
  } else {
    stage = 'fixture_provisioning';
    for (let i = 0; i <= capacity; i++) {
      await capacityGuard();
      const email = `public-${runId}-${i}@demo-acceptance.invalid`;
      const user = await methods.createUser({
        email, username: `public-${runId}-${i}`, name: 'Public acceptance fixture',
        provider: 'local', role: 'USER', emailVerified: true,
        password: await require('bcryptjs').hash(randomBytes(32).toString('base64url'), 12),
      }, config.balance, true, true);
      const fixture = { id: String(user._id), email };
      fixtures.push(fixture);
      await saveManifest();
      fixture.token = await methods.generateToken(user, 900000);
      const balance = await db.collection('balances').findOne({ user: user._id });
      assert.equal(balance.tokenCredits, config.balance.startBalance);
      assert.equal(balance.autoRefillEnabled, false);
    }
    checks.push('native_user_fixtures_have_initial_credits_and_no_refill');
    stage = 'fill_capacity';
    for (const fixture of fixtures.slice(0, capacity)) await startTask(fixture);
    for (const fixture of fixtures.slice(0, capacity))
      await waitForLease(fixture, lease => lease?.state === 'active' && lease.control === 'human');
    assert.equal(liveLeases().length, capacity);
    assert.equal(new Set(liveLeases().map(lease => lease.userId)).size, capacity);
    checks.push('public_qwen_tasks_reach_human_handoff', 'one_live_browser_per_fixture');
    console.log('Public acceptance: browser slots filled with dedicated fixtures.');

    stage = 'cross_account_access';
    const [owner, other] = fixtures;
    const { lease } = await call(owner, browserPath(owner));
    const hidden = await call(other, browserPath(owner));
    assert.deepEqual(hidden, { lease: null });
    for (const [operation, body] of [
      ['viewer', { revision: lease.revision, role: 'input' }],
      ['control', { revision: lease.revision, target: 'agent', operationId: randomUUID() }],
      ['cancel', {}],
    ]) {
      const denied = await request(other, browserPath(owner) + '/' + operation, body);
      assert.equal(denied.status, 404);
      await denied.body?.cancel();
    }
    const messages = await request(other, `/api/messages/${owner.conversationId}`);
    assert.ok([403, 404].includes(messages.status));
    await messages.body?.cancel();
    checks.push('public_cross_account_status_viewer_control_cancel_and_chat_denied');

    stage = 'queue';
    const queued = fixtures.at(-1);
    await startTask(queued);
    const waiting = await waitForLease(queued, candidate => candidate?.state === 'queued');
    assert.equal(waiting.position, 1);
    checks.push('extra_task_queues_at_configured_capacity');

    stage = 'authenticated_wss';
    const grant = await call(owner, browserPath(owner) + '/viewer', { revision: lease.revision, role: 'input' });
    assert.equal(grant.path, '/browser/v1/input');
    socket = new WebSocket(origin.replace(/^http/, 'ws') + grant.path, { origin });
    await once(socket, 'open', { signal: AbortSignal.timeout(15000) });
    const firstFrame = once(socket, 'message', { signal: AbortSignal.timeout(15000) });
    socket.send(JSON.stringify({ grant: grant.grant }));
    const [frame] = await firstFrame;
    assert.ok(Buffer.from(frame).toString('ascii').startsWith('RFB '));
    checks.push('public_authenticated_input_websocket_works');

    stage = 'release_and_automatic_admission';
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(30000) });
    await stopTask(owner);
    const [code] = await closed;
    assert.equal(code, 1008);
    const admitted = await waitForLease(queued, candidate => candidate?.state === 'active' && candidate.control === 'human');
    assert.equal(admitted.id, waiting.id);
    checks.push('public_cancel_revokes_live_input_websocket', 'public_queue_resumes_without_client_message');

    stage = 'return_and_complete';
    await call(queued, browserPath(queued) + '/control', { revision: admitted.revision, target: 'agent', operationId: randomUUID() });
    await waitForLease(queued, candidate => candidate?.state === 'completed');
    const end = Date.now() + 30000;
    let job;
    do {
      await capacityGuard();
      job = await call(queued, `/api/agents/chat/status/${queued.conversationId}`);
      if (!job.active) break;
      await delay(1000);
    } while (Date.now() < end);
    assert.equal(job.active, false);
    const result = await call(queued, `/api/messages/${queued.conversationId}`);
    const serialized = JSON.stringify(result);
    assert.ok(serialized.includes('browser_snapshot') && serialized.includes('Example Domain'));
    checks.push('public_done_continues_real_qwen_task_and_completes');
    const usage = await db.collection('transactions').aggregate([
      { $match: { user: { $in: fixtures.map(f => new mongoose.Types.ObjectId(f.id)) } } },
      { $group: { _id: null, value: { $sum: '$tokenValue' } } },
    ]).toArray();
    report = {
      passed: true, completedAt: new Date().toISOString(), origin, environment: acceptance ? 'isolated' : 'production', checks, capacity, fixtureAccounts: fixtures.length,
      billedCreditsAtCompletion: -(usage[0]?.value ?? 0),
      authentication: 'Dedicated USER accounts and short-lived tokens provisioned by native server methods; tokens never persisted. Requests traverse the stated origin and normal authenticated API.',
      limitation: 'Does not automate signup/login or solve a Turnstile challenge. No real GitHub credentials or private repositories are used.',
    };
  }
} catch (error) {
  report = { passed: false, completedAt: new Date().toISOString(), checks, failedStage: stage,
    reason: error instanceof assert.AssertionError ? error.message : 'Acceptance dependency/request failed; inspect private logs.' };
  if (db && fixtures.length) {
    // Fixture-only diagnostic, never user credentials or real account messages.
    const diagnostics = [];
    for (const fixture of fixtures.filter(item => item.conversationId)) {
      try {
        diagnostics.push({
          browser: await call(fixture, browserPath(fixture)),
          job: await call(fixture, `/api/agents/chat/status/${fixture.conversationId}`),
          messages: await db.collection('messages').find({ user: fixture.id, conversationId: fixture.conversationId }).toArray(),
        });
      } catch { /* Cleanup must still run when the API is unavailable. */ }
    }
    await writeFile(resolve(directory, `${runId}-diagnostic.json`), JSON.stringify(diagnostics, null, 2) + '\n', { mode: 0o600 });
    report.diagnosticRunId = runId;
  }
  process.exitCode = 1;
} finally {
  try {
    if (db && ledger) {
      const result = await cleanup();
      report = { ...(report ?? { passed: true, cleanupOnly: true }), cleanup: result };
    }
  } catch {
    report = { ...report, passed: false, cleanup: { passed: false, recoveryRunId: runId } };
    process.exitCode = 1;
  }
  ledger?.close();
  await mongoose?.disconnect();
  await lock.close();
  await unlink(lockPath);
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(root, 'output/librechat'), { recursive: true });
  const reportName = mode === '--cleanup' ? `journey-cleanup-${runId}.json` : `${acceptance ? 'acceptance' : 'public'}-journey.json`;
  await writeFile(resolve(root, 'output/librechat', reportName), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
// Native cache clients own background timers; all fixture cleanup has completed.
process.exit(process.exitCode ?? 0);
