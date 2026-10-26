import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Run only against the isolated acceptance stack, with BROWSER_MAX_SESSIONS=1.
const require = createRequire(new URL('../../librechat-agent/package.json', import.meta.url));
const { MongoClient } = require('mongodb');
const dbClient = await MongoClient.connect('mongodb://127.0.0.1:27019/LibreChatBrowserAcceptance');
const db = dbClient.db();
const origin = 'http://127.0.0.1:3081';
const checks = [];
const tasks = [];
let restoreBalance;
let report;
async function login(email) {
  const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'LocalBrowserDemo-Only!2026' }) });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  assert.ok(token);
  return { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-librechat-generation-protocol': '2' };
}
async function call(headers, path, body) {
  const response = await fetch(`${origin}${path}`, { headers, method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `Acceptance HTTP status ${response.status}`);
  return response.json();
}
async function start(headers) {
  const messageId = randomUUID();
  const task = await call(headers, '/api/agents/chat', {
    text: 'Open https://httpbin.org/anything/agentic-browser-acceptance and call browser_request_handoff so I can use the browser. Wait until I return control, then inspect the page and close it.',
    sender: 'User', isCreatedByUser: true, parentMessageId: '00000000-0000-0000-0000-000000000000',
    conversationId: 'new', messageId, responseMessageId: `${messageId}_`, endpoint: 'agents',
    agent_id: 'agent_browser_demo', spec: 'browser-demo', isTemporary: false, isRegenerate: false,
  });
  assert.ok(task.conversationId);
  const result = { ...task, headers };
  tasks.push(result);
  return result;
}
async function waitLease(task, predicate) {
  for (let n = 0; n < 90; n++) {
    const { lease } = await call(task.headers, `/api/agentic-browser/${task.conversationId}`);
    if (predicate(lease)) return lease;
    await delay(1000);
  }
  throw new Error('Browser state transition deadline');
}
async function abort(task) {
  const status = await call(task.headers, `/api/agents/chat/status/${task.conversationId}`);
  if (status.active) await call(task.headers, '/api/agents/chat/abort', { conversationId: task.conversationId, generationCreatedAt: status.createdAt });
}
try {
  const one = await login('accept-one@example.invalid');
  const two = await login('accept-two@example.invalid');
  const first = await start(one);
  await waitLease(first, lease => lease?.state === 'active' && lease.control === 'human');
  const second = await start(two);
  const queued = await waitLease(second, lease => lease?.state === 'queued');
  assert.equal(queued.position, 1);
  checks.push('real_second_account_queued_behind_first');
  console.log('Verified FIFO waiting; stopping first task.');
  await abort(first);
  const active = await waitLease(second, lease => lease?.state === 'active' && lease.control === 'human');
  assert.equal(active.id, queued.id);
  checks.push('stop_reclaims_browser_and_queue_continues_automatically');
  const firstState = await call(one, `/api/agents/chat/status/${first.conversationId}`);
  assert.equal(firstState.active, false);
  checks.push('stopped_generation_not_revived');

  const user = await db.collection('users').findOne({ email: 'accept-two@example.invalid' });
  restoreBalance = await db.collection('balances').findOne({ user: user._id });
  const transactionCount = await db.collection('transactions').countDocuments({ user: user._id });
  await db.collection('balances').updateOne({ _id: restoreBalance._id }, { $set: { tokenCredits: 0 } });
  const stream = await fetch(`${origin}/api/agents/chat/stream/${second.conversationId}?resume=true`, { headers: two, signal: AbortSignal.timeout(45000) });
  const reader = stream.body.getReader();
  let evidence = '';
  const streamRead = (async () => {
    const decoder = new TextDecoder();
    try {
      while (evidence.length < 1000000) {
        const part = await reader.read();
        if (part.done) return;
        evidence += decoder.decode(part.value, { stream: true });
        if (/token_balance|insufficient.*balance/i.test(evidence)) return;
      }
    } finally { await reader.cancel(); }
  })();
  await call(two, `/api/agentic-browser/${second.conversationId}/control`, { revision: active.revision, target: 'agent', operationId: randomUUID() });
  await streamRead;
  // A paused SSE connection intentionally ends at requires_action. Reconnect to
  // the resumed generation instead of mistaking that old pause for completion.
  for (let n = 0; n < 30 && !/token_balance|insufficient.*balance/i.test(evidence); n++) {
    await delay(500);
    const response = await fetch(`${origin}/api/agents/chat/stream/${second.conversationId}?resume=true`, { headers: two, signal: AbortSignal.timeout(30000) });
    evidence += await response.text();
    if (!response.ok) {
      evidence += JSON.stringify(await db.collection('messages').find({ conversationId: second.conversationId, isCreatedByUser: false }).toArray());
      break;
    }
  }
  assert.ok(/token_balance|insufficient.*balance/i.test(evidence), 'Resume must refuse depleted credits');
  await waitLease(second, lease => !lease || ['cancelled', 'completed', 'failed', 'expired'].includes(lease.state));
  assert.equal(await db.collection('transactions').countDocuments({ user: user._id }), transactionCount);
  checks.push('human_return_with_zero_credits_refuses_model_and_releases_browser');
  report = { passed: true, completedAt: new Date().toISOString(), checks };
} finally {
  for (const task of tasks) await abort(task).catch(() => {});
  if (restoreBalance) await db.collection('balances').updateOne({ _id: restoreBalance._id }, { $set: { tokenCredits: restoreBalance.tokenCredits } });
  await dbClient.close();
  await mkdir('output/librechat', { recursive: true });
  await writeFile('output/librechat/recovery-real.json', JSON.stringify(report ?? { passed: false, checks }, null, 2) + '\n');
}
console.log(JSON.stringify(report));
