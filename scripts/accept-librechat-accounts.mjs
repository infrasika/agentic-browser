import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// This script intentionally targets only disposable loopback acceptance accounts.
const require = createRequire(new URL('../../librechat-agent/package.json', import.meta.url));
const { MongoClient } = require('mongodb');
const origin = 'http://127.0.0.1:3081';
const conversationId = process.argv[2];
assert.match(conversationId ?? '', /^[a-f0-9-]{36}$/);
const password = 'LocalBrowserDemo-Only!2026';
const checks = [];
const database = await MongoClient.connect('mongodb://127.0.0.1:27019/LibreChatBrowserAcceptance');
const db = database.db();
async function login(email) {
  const r = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.token);
  return body.token;
}
async function call(token, path, body) {
  return fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', origin,
    'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
    'x-librechat-generation-protocol': '2', 'x-user-id': 'forged-victim',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
let report;
try {
  const one = await login('accept-one@example.invalid');
  const two = await login('accept-two@example.invalid');
  const users = await db.collection('users').find({ email: { $in: ['accept-one@example.invalid', 'accept-two@example.invalid'] } }).toArray();
  const before = await Promise.all(users.map(user => db.collection('balances').findOne({ user: user._id })));
  assert.ok(before[0] && before[1]);
  assert.ok(before.some(balance => balance.tokenCredits < 200000));
  assert.ok(before.every(balance => balance.tokenCredits >= 0 && balance.tokenCredits <= 200000));
  assert.notEqual(String(before[0]._id), String(before[1]._id));
  assert.ok(before.every(balance => balance.autoRefillEnabled === false));
  checks.push('independent_balances_and_no_auto_refill');
  await login('accept-one@example.invalid');
  const after = await Promise.all(users.map(user => db.collection('balances').findOne({ user: user._id })));
  assert.deepEqual(after.map(b => b.tokenCredits), before.map(b => b.tokenCredits));
  checks.push('relogin_does_not_reset_credits');

  const status = await call(one, `/api/agentic-browser/${conversationId}`);
  assert.equal(status.status, 200);
  const { lease } = await status.json();
  assert.equal(lease.state, 'active');
  assert.equal(lease.control, 'human');
  const hidden = await call(two, `/api/agentic-browser/${conversationId}`);
  assert.deepEqual(await hidden.json(), { lease: null });
  assert.equal((await call(two, `/api/agentic-browser/${conversationId}/viewer`, { revision: lease.revision, role: 'input' })).status, 404);
  assert.equal((await call(two, `/api/agentic-browser/${conversationId}/cancel`, {})).status, 404);
  assert.ok([403, 404].includes((await call(two, `/api/messages/${conversationId}`)).status));
  checks.push('cross_account_chat_viewer_and_cancellation_denied');
  const returned = await call(one, `/api/agentic-browser/${conversationId}/control`, { revision: lease.revision, target: 'agent', operationId: randomUUID() });
  assert.equal(returned.status, 200);
  let completed = false;
  for (let n = 0; n < 90; n++) {
    const response = await call(one, `/api/agents/chat/status/${conversationId}`);
    const state = await response.json();
    if (state.active === false) { completed = true; break; }
    await delay(1000);
  }
  assert.ok(completed, 'Automatic continuation did not complete');
  const messages = await db.collection('messages').find({ conversationId, isCreatedByUser: false }).toArray();
  assert.ok(messages.length > 0);
  assert.ok(JSON.stringify(messages).includes('browser_snapshot'));
  checks.push('server_continues_without_frontend_message');
  report = { passed: true, completedAt: new Date().toISOString(), checks, balances: users.map((u, i) => ({ email: u.email, creditsBefore: before[i].tokenCredits })) };
} finally {
  await database.close();
  await mkdir('output/librechat', { recursive: true });
  await writeFile('output/librechat/accounts-real.json', JSON.stringify(report ?? { passed: false, checks }, null, 2) + '\n');
}
console.log(JSON.stringify(report));
