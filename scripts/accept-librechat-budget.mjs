import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../../librechat-agent/package.json', import.meta.url));
const { MongoClient } = require('mongodb');
const dbClient = await MongoClient.connect('mongodb://127.0.0.1:27019/LibreChatBrowserAcceptance');
const db = dbClient.db();
const origin = 'http://127.0.0.1:3081';
const user = await db.collection('users').findOne({ email: 'accept-two@example.invalid' });
assert.ok(user);
const balance = await db.collection('balances').findOne({ user: user._id });
assert.ok(balance);
const beforeTransactions = await db.collection('transactions').countDocuments({ user: user._id });
let report;
try {
  await db.collection('balances').updateOne({ _id: balance._id }, { $set: { tokenCredits: 0 } });
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: user.email, password: 'LocalBrowserDemo-Only!2026' }) });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const messageId = randomUUID();
  const headers = { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-librechat-generation-protocol': '2' };
  const response = await fetch(`${origin}/api/agents/chat`, { method: 'POST', headers, body: JSON.stringify({
    text: 'Open https://httpbin.org/anything/agentic-browser-acceptance and summarize the page.', sender: 'User', isCreatedByUser: true,
    parentMessageId: '00000000-0000-0000-0000-000000000000', conversationId: 'new', messageId,
    responseMessageId: `${messageId}_`, endpoint: 'agents', agent_id: 'agent_browser_demo',
    spec: 'browser-demo', isTemporary: false, isRegenerate: false, error: false,
  }) });
  const raw = await response.text();
  let admission;
  try { admission = JSON.parse(raw); } catch { /* A pre-admission denial can use the upstream SSE error envelope. */ }
  let evidence = raw;
  if (admission?.conversationId) {
    const stream = await fetch(`${origin}/api/agents/chat/stream/${admission.conversationId}?resume=true`, { headers, signal: AbortSignal.timeout(30000) });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (evidence.length < 200000) {
        const chunk = await reader.read();
        if (chunk.done) break;
        evidence += decoder.decode(chunk.value, { stream: true });
        if (/TOKEN_BALANCE|token_balance|insufficient.*balance/i.test(evidence)) break;
      }
    } finally { await reader.cancel(); }
    for (let n = 0; n < 30; n++) {
      if (/TOKEN_BALANCE|token_balance|insufficient.*balance/i.test(evidence)) break;
      const messages = await db.collection('messages').find({ conversationId: admission.conversationId }).toArray();
      evidence += JSON.stringify(messages);
      if (/TOKEN_BALANCE|token_balance|insufficient.*balance/i.test(evidence)) break;
      await delay(1000);
    }
    const state = await fetch(`${origin}/api/agentic-browser/${admission.conversationId}`, { headers });
    assert.deepEqual(await state.json(), { lease: null });
  }
  assert.ok(/TOKEN_BALANCE|token_balance|insufficient.*balance/i.test(evidence), 'Expected explicit insufficient-balance refusal');
  const remaining = await db.collection('balances').findOne({ _id: balance._id });
  assert.equal(remaining.tokenCredits, 0);
  assert.equal(await db.collection('transactions').countDocuments({ user: user._id }), beforeTransactions);
  report = { passed: true, completedAt: new Date().toISOString(), checks: ['zero_balance_refuses_model_execution', 'zero_balance_creates_no_browser_or_charge', 'login_does_not_regrant_credits'] };
} finally {
  await db.collection('balances').updateOne({ _id: balance._id }, { $set: { tokenCredits: balance.tokenCredits } });
  await dbClient.close();
  await mkdir('output/librechat', { recursive: true });
  await writeFile('output/librechat/budget-real.json', JSON.stringify(report ?? { passed: false }, null, 2) + '\n');
}
console.log(JSON.stringify(report));
