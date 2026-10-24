import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { open, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Isolated DB, model and mail capture. Never reads the production private.env.
const root = resolve(import.meta.dirname, '..');
const checkout = resolve(root, '../librechat-agent');
const artifacts = resolve(root, '.deployment/librechat/artifacts/budget-20261024');
const directory = resolve(root, '.deployment/librechat/controls-acceptance');
const origin = 'http://127.0.0.1:3093';
const require = createRequire(resolve(checkout, 'package.json'));
const { MongoClient } = require('mongodb');
const database = `LibreChatControls_${randomBytes(6).toString('hex')}`;
const mongo = new MongoClient(`mongodb://127.0.0.1:27019/${database}`);
const children = [];
const checks = [];
let stage = 'setup';
let calls = 0;
let finishHold;
process.on('SIGTERM', () => finishHold?.());
process.on('SIGINT', () => finishHold?.());
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const [destination, source] of [
  ['node_modules', 'node_modules'],
]) {
  try { await symlink(resolve(checkout, source), resolve(artifacts, destination), 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const log = await open(resolve(directory, 'server.log'), 'w', 0o600);
const provider = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); calls++;
  const message = { id: `fixture-${calls}`, object: 'chat.completion', created: 1, model: 'budget-fixture',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Budget fixture complete.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
  if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...message, object: 'chat.completion.chunk', usage: undefined, choices: [{ index: 0, delta: { role: 'assistant', content: 'Budget fixture complete.' }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...message, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});
function start(file, env, args = []) {
  const child = spawn(process.execPath, [file, ...args], { cwd: checkout, env, stdio: ['ignore', log.fd, log.fd] });
  children.push(child); return child;
}
async function ready(url) {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* process starting */ }
    await delay(1000);
  }
  throw new Error('Startup timeout');
}
const baseHeaders = { 'content-type': 'application/json', origin, 'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-librechat-generation-protocol': '2' };
async function api(path, body, token, method = body === undefined ? 'GET' : 'POST') {
  return fetch(`${origin}/api${path}`, { method, headers: { ...baseHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(email, password) {
  const result = await api('/auth/login', { email, password }); assert.equal(result.status, 200);
  return (await result.json()).token;
}
try {
  await mongo.connect();
  await new Promise(resolve => provider.listen(18899, '127.0.0.1', resolve));
  const config = JSON.parse(await readFile(resolve(root, '.deployment/librechat/acceptance.yaml'), 'utf8'));
  config.browser.enabled = false;
  config.balance.siteBudget = { enabled: true, dailyCredits: 20000000, endpoints: ['Qwen'], timeZone: 'Asia/Shanghai' };
  const model = config.endpoints.custom[0];
  model.models.default = ['budget-fixture']; model.titleModel = 'budget-fixture';
  model.apiKey = 'fixture-key'; model.baseURL = 'http://127.0.0.1:18899/v1';
  model.tokenConfig = { 'budget-fixture': { prompt: 0.276, completion: 1.101, context: 64000 } };
  await writeFile(resolve(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  const hook = `const Module = require('node:module');
const base = ${JSON.stringify(checkout)};
const artifacts = ${JSON.stringify(artifacts)};
const original = Module._resolveFilename;
const maps = { '@librechat/api': artifacts + '/api/index.cjs', '@librechat/api/telemetry': artifacts + '/api/telemetry.cjs', '@librechat/api/credentials': artifacts + '/api/credentials.cjs', '@librechat/data-schemas': artifacts + '/data-schemas/index.cjs', '@librechat/data-schemas/capabilities': artifacts + '/data-schemas/admin/capabilities.cjs' };
Module._resolveFilename = function(name, parent, ...args) {
  if (maps[name]) return maps[name];
  if (parent?.filename?.startsWith(artifacts) && !name.startsWith('.') && !name.startsWith('/')) return original.call(this, name, { ...parent, paths: Module._nodeModulePaths(base + (parent.filename.includes('/data-schemas/') ? '/packages/data-schemas' : '/packages/api')) }, ...args);
  return original.call(this, name, parent, ...args);
};
require(base + '/api/config/paths.js').dist = artifacts + '/client';\n`;
  await writeFile(resolve(directory, 'hook.cjs'), hook, { mode: 0o600 });
  const adminEmail = 'controls-admin@example.test', password = 'BudgetFixture-Only!2026';
  const env = { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: `--require=${resolve(directory, 'hook.cjs')}`,
    MONGO_URI: `mongodb://127.0.0.1:27019/${database}`, USE_REDIS: 'false', USE_REDIS_STREAMS: 'false',
    HOST: '127.0.0.1', PORT: '3093', DOMAIN_CLIENT: origin, DOMAIN_SERVER: origin,
    CONFIG_PATH: resolve(directory, 'config.json'), ENDPOINTS: 'agents,custom',
    DEMO_ADMIN_EMAIL: adminEmail, DEMO_ADMIN_PASSWORD: password, QWEN_MODEL: 'budget-fixture',
    JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    CREDS_KEY: randomBytes(32).toString('hex'), CREDS_IV: randomBytes(16).toString('hex'),
    ALLOW_REGISTRATION: 'true', ALLOW_EMAIL_LOGIN: 'true', ALLOW_UNVERIFIED_EMAIL_LOGIN: 'true',
    RESET_PASSWORD_MAX: '3', RESET_PASSWORD_SUBMISSION_MAX: '3',
    ALLOW_PASSWORD_RESET: 'true', ALLOW_SOCIAL_LOGIN: 'false', ALLOW_SOCIAL_REGISTRATION: 'false',
    ADMIN_PANEL_URL: `${origin}/demo-admin`, EMAIL_HOST: '127.0.0.1', EMAIL_PORT: '11025', EMAIL_ENCRYPTION: '',
    EMAIL_FROM: 'noreply@fixture.example.test', EMAIL_FROM_NAME: 'Browser Demo', EMAIL_USERNAME: '', EMAIL_PASSWORD: '',
    EMAIL_SERVICE: '', MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', E2E_SMTP_PORT: '11025', E2E_MAILBOX_PORT: '18025',
    SEARCH: 'false', DEBUG_LOGGING: 'false', DEBUG_CONSOLE: 'false', CONSOLE_JSON: 'true',
    LIMIT_CONCURRENT_MESSAGES: 'true', CONCURRENT_MESSAGE_MAX: '1', BAN_VIOLATIONS: 'false',
  };
  start('e2e/setup/mailbox-server.js', env); await ready('http://127.0.0.1:18025/health');
  stage = 'bootstrap';
  const bootstrap = start('config/bootstrap-browser.cjs', env);
  assert.equal(await new Promise(resolve => bootstrap.once('exit', resolve)), 0);
  stage = 'server'; start('api/server/index.js', env); await ready(`${origin}/api/config`); await delay(4000);
  const db = mongo.db();
  const admin = await login(adminEmail, password);
  const email = 'controls-user@example.test';
  const registration = await api('/auth/register', { email, password, confirm_password: password, name: 'Controls Fixture', username: 'controls-fixture' });
  assert.equal(registration.status, 200);
  const user = await db.collection('users').findOne({ email }); assert.ok(user); assert.equal(user.role, 'USER');
  const token = await login(email, password);
  const balance = await db.collection('balances').findOne({ user: user._id }); assert.equal(balance.tokenCredits, 200000);
  stage = 'admin';
  assert.equal((await api('/demo-admin', undefined, token)).status, 403);
  assert.equal((await api('/demo-admin')).status, 401);
  assert.equal((await api('/demo-admin/users', undefined, admin)).status, 200);
  const topup = { credits: 1000, id: randomUUID() };
  for (let i = 0; i < 2; i++) assert.equal((await api(`/demo-admin/users/${user._id}/credits`, topup, admin)).status, 200);
  assert.equal((await db.collection('balances').findOne({ user: user._id })).tokenCredits, 201000);
  checks.push('admin_auth_and_idempotent_credit');
  let budget = await (await api('/demo-admin', undefined, admin)).json();
  assert.equal((await api('/demo-admin/budget', { credits: 0, revision: budget.revision }, admin)).status, 200);
  async function chat() {
    const messageId = randomUUID();
    const admission = await api('/agents/chat', { text: 'Say hello in one sentence. Do not use tools.', sender: 'User', isCreatedByUser: true,
      parentMessageId: '00000000-0000-0000-0000-000000000000', conversationId: 'new', messageId, responseMessageId: `${messageId}_`, endpoint: 'agents', agent_id: 'agent_browser_demo', spec: 'browser-demo', isTemporary: false, isRegenerate: false, error: false }, token);
    const body = await admission.json(); await writeFile(resolve(directory, 'admission.json'), JSON.stringify({status:admission.status,body}), { mode: 0o600 }); assert.ok(body.conversationId);
    const stream = await fetch(`${origin}/api/agents/chat/stream/${body.conversationId}?resume=true`, { headers: { ...baseHeaders, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    const events = await stream.text();
    await delay(1000);
    const messages = await db.collection('messages').find({ conversationId: body.conversationId }).toArray();
    return events + JSON.stringify(messages);
  }
  stage = 'budget_denial'; const denied = await chat();
  assert.match(denied, /site_budget_exceeded/); assert.equal(calls, 0);
  assert.equal((await db.collection('balances').findOne({ user: user._id })).tokenCredits, 201000);
  checks.push('zero_daily_budget_prevents_provider_and_personal_spend');
  budget = await (await api('/demo-admin', undefined, admin)).json();
  await api('/demo-admin/budget', { credits: 20000000, revision: budget.revision }, admin);
  stage = 'budget_settlement'; const allowed = await chat(); assert.match(allowed, /Budget fixture complete/);
  for (let i = 0; i < 20; i++) { budget = await (await api('/demo-admin', undefined, admin)).json(); if (calls >= 2 && budget.reservedCredits === 0) break; await delay(500); }
  assert.ok(calls >= 2, 'Chat and title both reach the mock provider'); assert.equal(budget.spentCredits, calls * 39); assert.equal(budget.reservedCredits, 0);
  checks.push('chat_and_title_share_persistent_budget');
  stage = 'password_reset';
  const before = (await db.collection('balances').findOne({ user: user._id })).tokenCredits;
  const reset = await api('/auth/requestPasswordReset', { email }); const absent = await api('/auth/requestPasswordReset', { email: 'absent@example.test' });
  assert.equal(reset.status, 200); assert.equal(absent.status, 200);
  assert.deepEqual(await reset.json(), await absent.json());
  const mailbox = await (await fetch('http://127.0.0.1:18025/messages?subject=Password%20Reset%20Request')).json();
  const mail = mailbox.messages.find(message => message.to.includes(email)); assert.ok(mail);
  const link = new URL(mail.urls.find(url => url.includes('/reset-password?'))); assert.equal(link.origin, origin);
  const newPassword = 'ResetFixture-Only!2026';
  const payload = { userId: link.searchParams.get('userId'), token: link.searchParams.get('token'), password: newPassword, confirm_password: newPassword };
  assert.equal((await api('/auth/resetPassword', payload)).status, 200);
  assert.equal((await api('/auth/resetPassword', payload)).status, 400);
  assert.ok([401, 404].includes((await api('/auth/login', { email, password })).status));
  await login(email, newPassword);
  assert.equal((await api('/user', undefined, token)).status, 401);
  assert.equal((await db.collection('balances').findOne({ user: user._id })).tokenCredits, before);
  await api('/auth/requestPasswordReset', { email });
  const expiredMail = await (await fetch('http://127.0.0.1:18025/messages?subject=Password%20Reset%20Request')).json();
  const expiredLink = new URL(expiredMail.messages.filter(message => message.to.includes(email)).at(-1).urls.find(url => url.includes('/reset-password?')));
  await db.collection('tokens').updateMany({ userId: user._id }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await api('/auth/resetPassword', { ...payload, token: expiredLink.searchParams.get('token') })).status, 400);
  assert.equal((await api('/auth/resetPassword', payload)).status, 429);
  checks.push('mail_capture_reset_single_use_expiry_revocation_preserves_balance');
  checks.push('password_reset_rate_limited');
  await writeFile(resolve(root, 'output/librechat/controls-acceptance.json'), JSON.stringify({ passed: true, completedAt: new Date().toISOString(), checks, providerCalls: calls, spentCredits: budget.spentCredits }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks, providerCalls: calls }));
  if (process.argv.includes('--hold')) { console.log('Isolated UI ready at http://127.0.0.1:3093; synthetic administrator controls-admin@example.test / BudgetFixture-Only!2026.'); await new Promise(resolve => { finishHold = resolve; }); }
} catch (error) {
  await writeFile(resolve(directory, 'failure.txt'), String(error?.stack), { mode: 0o600 });
  console.error(JSON.stringify({ passed: false, stage, kind: error?.name, checks })); process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode == null) child.kill('SIGTERM');
  await Promise.all(children.filter(child => child.exitCode == null).map(child => Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000).then(() => child.kill('SIGKILL'))])));
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  if (mongo.topology?.isConnected()) await mongo.db().dropDatabase();
  await mongo.close(); await log.close();
}
