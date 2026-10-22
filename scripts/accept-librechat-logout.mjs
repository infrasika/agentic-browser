import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

const require = createRequire(new URL('../../librechat-agent/package.json', import.meta.url));
const { MongoClient } = require('mongodb');
const { WebSocket } = require('ws');
const origin = 'http://127.0.0.1:3081';
const database = await MongoClient.connect('mongodb://127.0.0.1:27019/LibreChatBrowserAcceptance');
const db = database.db();
const ledger = new DatabaseSync('.data/librechat-acceptance/scheduler.sqlite', { readOnly: true });
let socket;
let conversationId;
let headers;
let report;
async function call(path, body) {
  const r = await fetch(`${origin}${path}`, { headers, method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  assert.ok(r.ok, `Unexpected acceptance status ${r.status}`);
  return r.json();
}
try {
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'accept-one@example.invalid', password: 'LocalBrowserDemo-Only!2026' }) });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  headers = { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-librechat-generation-protocol': '2' };
  // Clear any older synthetic acceptance generation before exercising a new one.
  await call('/api/auth/logout', {});
  const freshLogin = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'accept-one@example.invalid', password: 'LocalBrowserDemo-Only!2026' }) });
  assert.equal(freshLogin.status, 200);
  headers.authorization = `Bearer ${(await freshLogin.json()).token}`;
  const messageId = randomUUID();
  const task = await call('/api/agents/chat', {
    text: 'Open https://example.com and hand the browser to me. Wait for me to return control before doing anything else.',
    sender: 'User', isCreatedByUser: true, parentMessageId: '00000000-0000-0000-0000-000000000000',
    conversationId: 'new', messageId, responseMessageId: `${messageId}_`, endpoint: 'agents',
    agent_id: 'agent_browser_demo', spec: 'browser-demo', isTemporary: false, isRegenerate: false,
  });
  conversationId = task.conversationId;
  assert.ok(conversationId);
  let lease;
  for (let n = 0; n < 90; n++) {
    ({ lease } = await call(`/api/agentic-browser/${conversationId}`));
    if (lease?.state === 'active' && lease.control === 'human') break;
    await delay(1000);
  }
  assert.equal(lease?.control, 'human');
  const grant = await call(`/api/agentic-browser/${conversationId}/viewer`, { revision: lease.revision, role: 'input' });
  socket = new WebSocket('ws://127.0.0.1:3081/browser/v1/input', { origin });
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  const received = once(socket, 'message', { signal: AbortSignal.timeout(10000) });
  socket.send(JSON.stringify({ grant: grant.grant }));
  await received;
  const closed = once(socket, 'close', { signal: AbortSignal.timeout(30000) });
  await call('/api/auth/logout', {});
  await closed;
  const user = await db.collection('users').findOne({ email: 'accept-one@example.invalid' });
  const before = await db.collection('transactions').countDocuments({ user: user._id });
  const count = ledger.prepare('SELECT COUNT(*) AS n FROM leases WHERE conversationId = ?').get(conversationId).n;
  // Several worker ticks must not reopen a new browser after the revoked lease ends.
  await delay(10000);
  assert.equal(ledger.prepare('SELECT COUNT(*) AS n FROM leases WHERE conversationId = ?').get(conversationId).n, count);
  assert.equal(ledger.prepare("SELECT COUNT(*) AS n FROM leases WHERE userId = ? AND state IN ('queued','starting','active','closing','cleanup_pending')").get(String(user._id)).n, 0);
  assert.equal((await call(`/api/agents/chat/status/${conversationId}`)).active, false);
  assert.equal(await db.collection('transactions').countDocuments({ user: user._id }), before);
  report = { passed: true, completedAt: new Date().toISOString(), checks: [
    'authenticated_input_websocket_closed_on_logout', 'logout_aborts_original_generation',
    'logout_releases_all_user_leases', 'worker_does_not_recreate_browser_or_call_model_after_logout',
  ] };
} finally {
  socket?.terminate();
  if (!report && conversationId && headers) {
    const state = await call(`/api/agents/chat/status/${conversationId}`).catch(() => null);
    if (state?.active) await call('/api/agents/chat/abort', { conversationId, generationCreatedAt: state.createdAt }).catch(() => {});
  }
  ledger.close();
  await database.close();
  await mkdir('output/librechat', { recursive: true });
  await writeFile('output/librechat/logout-real.json', JSON.stringify(report ?? { passed: false }, null, 2) + '\n');
}
console.log(JSON.stringify(report));
