import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { IdentityStore } from '../src/identity.js';
import { SessionRegistry } from '../src/sessions.js';
import { createHttpServer } from '../src/http.js';
import { RemoteMcp, publicClientAddress } from '../src/remote-mcp.js';
import { readConfig } from '../src/config.js';
import { BrowserAllocationError } from '../src/contracts.js';
import { deferred, fakeWorkspace } from './helpers.js';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';

const result = (value: any) => JSON.parse(value.content[0].text);
async function fixture(t: any, maxPerIp = 2, createHook?: () => Promise<void>, maxSessions = 4) {
  const directory = await mkdtemp(join(tmpdir(), 'agentic-remote-mcp-'));
  const identity = new IdentityStore(directory);
  let closed = 0;
  const registry = new SessionRegistry({ async create({ ownerId } = {}) {
    await createHook?.();
    return { ...fakeWorkspace(), async perform() { return { text: `private ${ownerId}`, url: 'https://example.com/' }; }, async close() { closed++; } };
  }, async close() {} }, { ttlMs: 300000, maxSessions, maxSessionsPerOwner: 1, maxLifetimeMs: 600000 });
  const server = createHttpServer(registry, { publicUrl: 'http://127.0.0.1', identity, publicBrowser: true, publicMaxSessionsPerIp: maxPerIp });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await server.closeRemoteMcp(); await registry.close(); server.close(); server.closeAllConnections();
    identity.close(); await rm(directory, { recursive: true, force: true });
  });
  async function client(headers?: Record<string, string>) {
    const client = new Client({ name: 'public-test-client', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers } });
    clients.push(client); await client.connect(transport); assert.equal(transport.sessionId, undefined);
    return client;
  }
  const claim = (url: string, origin = base) => {
    const [sessionId, ticket] = new URL(url).hash.slice(1).split('.');
    return fetch(base + '/api/public/claim', { method: 'POST', headers: { Origin: origin, 'X-Agentic-Browser': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, ticket }) });
  };
  return { base, registry, identity, client, claim, closed: () => closed };
}

test('public MCP: URL-only clients, per-browser capabilities, one-use human links, real handback and revocation', async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client();
  assert.equal((await a.listTools()).tools.length, 9);
  assert.ok(!(await a.listTools()).tools.some(tool => ['browser_sessions', 'browser_profiles'].includes(tool.name)));
  const one = result(await a.callTool({ name: 'browser_create', arguments: { purpose: 'Private A' } }));
  const two = result(await b.callTool({ name: 'browser_create', arguments: { purpose: 'Private B', url: 'https://example.com' } }));
  const aa = { sessionId: one.sessionId, sessionKey: one.sessionKey }, bb = { sessionId: two.sessionId, sessionKey: two.sessionKey };
  assert.notEqual(one.sessionKey, two.sessionKey);
  assert.equal(result(await b.callTool({ name: 'browser_status', arguments: { ...bb, sessionId: one.sessionId } })).status, 404);
  const forbidden = await fetch(f.base + `/api/human/${one.sessionId}`, { headers: { Authorization: `Bearer ${one.sessionKey}` } });
  assert.equal(forbidden.status, 401);
  const handoff = result(await a.callTool({ name: 'browser_handoff', arguments: aa }));
  assert.equal((await f.claim(one.humanUrl)).status, 410, 'A new link revokes the previous unclaimed link');
  assert.equal((await f.claim(handoff.humanUrl, 'https://attacker.invalid')).status, 403);
  const claimed = await f.claim(handoff.humanUrl); assert.equal(claimed.status, 200);
  const cookie = claimed.headers.get('set-cookie')!.split(';')[0];
  assert.match(claimed.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.equal((await f.claim(handoff.humanUrl)).status, 410, 'Claim cannot be replayed');
  const otherClaim = await f.claim(two.humanUrl), otherCookie = otherClaim.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(f.base + `/api/human/${one.sessionId}`, { headers: { Cookie: otherCookie } })).status, 404);
  assert.equal(result(await a.callTool({ name: 'browser_action', arguments: { ...aa, action: { type: 'snapshot' } } })).status, 409);
  const waiting = a.callTool({ name: 'browser_wait', arguments: { ...aa, afterRevision: handoff.revision, timeoutSeconds: 5 } });
  const resumed = await fetch(f.base + `/api/human/${one.sessionId}/resume`, { method: 'POST', headers: { Cookie: cookie, Origin: f.base, 'X-Agentic-Browser': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await resumed.json()).control, 'agent', 'Public mode must not run the built-in fixed demo Agent');
  assert.equal(result(await waiting).status, 'ready');
  assert.match(result(await a.callTool({ name: 'browser_action', arguments: { ...aa, action: { type: 'snapshot' } } })).result.text, /private/);
  for (const path of ['/api/profiles', '/api/credentials', '/api/sessions', '/api/auth/login']) {
    assert.equal((await fetch(f.base + path, { method: 'POST', headers: { Cookie: cookie, Origin: f.base, 'X-Agentic-Browser': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  }
  assert.equal(result(await a.callTool({ name: 'browser_close', arguments: aa })).control, 'closed');
  assert.equal(f.closed(), 1);
  assert.equal((await fetch(f.base + '/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal(result(await a.callTool({ name: 'browser_status', arguments: aa })).status, 404);
  assert.equal(result(await b.callTool({ name: 'browser_status', arguments: bb })).control, 'human');
});

test('public MCP: handoff and refreshed links include a user-ready URL without exposing the Agent key', async t => {
  const f = await fixture(t), client = await f.client();
  const created = result(await client.callTool({ name: 'browser_create', arguments: {} }));
  const access = { sessionId: created.id, sessionKey: created.sessionKey };
  let previousUrl = created.humanUrl;
  for (const name of ['browser_handoff', 'browser_human_link']) {
    const response = await client.callTool({ name, arguments: access });
    const data = result(response);
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent, data, 'Structured and legacy JSON clients receive the same link and message');
    const url = new URL(data.humanUrl);
    assert.equal(url.origin, f.base);
    assert.equal(url.pathname, '/connect');
    assert.ok(url.hash.startsWith(`#${created.id}.`));
    assert.match(data.userMessage, /连接并接管/);
    assert.match(data.userMessage, /完成，交还给 Agent/);
    assert.ok(data.userMessage.includes(`[打开浏览器并接管](${data.humanUrl})`), 'The message contains an actual clickable URL');
    assert.ok(data.userMessage.split('\n').includes(data.humanUrl), 'Raw URL remains copyable in text-only clients');
    assert.ok(Array.isArray(response.content));
    assert.ok(response.content.some((block: any) => block.type === 'text' && block.text.includes(`\n\n${data.userMessage}`)), 'Text-only clients get the ready-to-send message outside JSON');
    assert.ok(!JSON.stringify(response).includes(created.sessionKey), 'Only the human link may appear in the handoff message');
    assert.equal((await f.claim(previousUrl)).status, 410);
    assert.equal(result(await client.callTool({ name: 'browser_status', arguments: access })).control, 'human');
    previousUrl = data.humanUrl;
  }
  assert.equal((await f.claim(previousUrl)).status, 200, 'The exact displayed URL claims this session');
  const denied = await client.callTool({ name: 'browser_human_link', arguments: { ...access, sessionKey: 'x'.repeat(43) } });
  assert.equal(denied.isError, true);
  assert.ok(!JSON.stringify(denied).includes('/connect#'), 'Failed authorization must not expose a link');
});

test('public MCP: reserves per-source quota during creation and ignores untrusted forwarded IPs', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, 1, async () => { entered.resolve(); await gate.promise; });
  const a = await f.client(), b = await f.client({ 'X-Real-IP': '198.51.100.27', 'X-Forwarded-For': '198.51.100.28' });
  const creating = a.callTool({ name: 'browser_create', arguments: {} }); await entered.promise;
  const extra = await b.callTool({ name: 'browser_create', arguments: {} });
  const limited = result(extra);
  assert.equal(limited.status, 429);
  assert.equal(limited.error, 'source_limit');
  assert.deepEqual(limited.sourceCapacity, { currentSessions: 1, maxSessions: 1 });
  assert.equal(limited.capacity.currentSessions, 1);
  assert.equal(limited.capacity.full, false);
  assert.match(limited.userMessage, /当前网络/);
  gate.resolve();
  const created = result(await creating);
  assert.equal(result(await b.callTool({ name: 'browser_create', arguments: {} })).status, 429);
  await a.callTool({ name: 'browser_close', arguments: { sessionId: created.id, sessionKey: created.sessionKey } });
});

test('public MCP: five concurrent allocations fill capacity, expose only totals, and closing releases a slot', async t => {
  const gate = deferred(), entered = deferred(); let starts = 0;
  const f = await fixture(t, 8, async () => { if (++starts === 5) entered.resolve(); await gate.promise; }, 5);
  const client = await f.client();
  const capacity = async () => {
    const response = await fetch(f.base + '/api/public/capacity');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  assert.deepEqual(await capacity(), { currentSessions: 0, maxSessions: 5, availableSessions: 5, full: false });
  const creating = Array.from({ length: 5 }, (_, i) => client.callTool({ name: 'browser_create', arguments: { purpose: `Private fixture ${i}` } }));
  try {
    await entered.promise;
    const full = { currentSessions: 5, maxSessions: 5, availableSessions: 0, full: true };
    assert.deepEqual(await capacity(), full, 'Allocations reserve slots before launch finishes');
    const denied = await client.callTool({ name: 'browser_create', arguments: {} });
    const payload = result(denied);
    assert.equal(denied.isError, true); assert.equal(payload.error, 'session_limit'); assert.equal(payload.status, 429);
    assert.deepEqual(payload.capacity, full); assert.deepEqual(denied.structuredContent, payload);
    assert.equal(payload.retryAfterSeconds, 30);
    assert.match(payload.userMessage, /5 \/ 5/); assert.match(payload.userMessage, /稍后再试/);
    assert.ok(Array.isArray(denied.content) && denied.content.some((part: any) => part.type === 'text' && part.text.includes('Show this capacity notice')));
    assert.equal(starts, 5, 'No sixth browser was launched');
  } finally { gate.resolve(); }
  const sessions = (await Promise.all(creating)).map(result);
  assert.equal((await capacity()).currentSessions, 5);
  const access = { sessionId: sessions[0].id, sessionKey: sessions[0].sessionKey };
  await client.callTool({ name: 'browser_close', arguments: access });
  assert.deepEqual(await capacity(), { currentSessions: 4, maxSessions: 5, availableSessions: 1, full: false });
  assert.ok(result(await client.callTool({ name: 'browser_create', arguments: {} })).sessionKey);
  assert.equal(starts, 6);
});

test('public MCP: failed startup with failed cleanup retains global and source slots until retry succeeds', async t => {
  for (const maxSessions of [1, 3]) await t.test(`maximum ${maxSessions}`, async t => {
    let first = true, cleanupReady = false, cleaned = false;
    const f = await fixture(t, 1, async () => {
      if (!first) return;
      first = false;
      throw new BrowserAllocationError({ ...fakeWorkspace(), async close() {
        if (!cleanupReady) throw new Error('synthetic Docker cleanup failure');
        cleaned = true;
      } });
    }, maxSessions);
    const client = await f.client();
    assert.equal(result(await client.callTool({ name: 'browser_create', arguments: {} })).status, 502);
    assert.equal(f.registry.capacity().currentSessions, 1);
    const denied = result(await client.callTool({ name: 'browser_create', arguments: {} }));
    assert.equal(denied.status, 429);
    assert.equal(denied.error, maxSessions === 1 ? 'session_limit' : 'source_limit');
    assert.equal(denied.capacity.currentSessions, 1);
    assert.equal(f.identity.listMembers().length, 0);
    cleanupReady = true;
    assert.ok(result(await client.callTool({ name: 'browser_create', arguments: {} })).sessionKey);
    assert.equal(cleaned, true);
    assert.equal(f.registry.capacity().currentSessions, 1, 'Only the replacement occupies a slot');
  });
});

test('public MCP: client cancelling a wait never changes control; origin and body guards', async t => {
  const f = await fixture(t), client = await f.client();
  const created = result(await client.callTool({ name: 'browser_create', arguments: {} }));
  const access = { sessionId: created.id, sessionKey: created.sessionKey };
  await client.callTool({ name: 'browser_handoff', arguments: access });
  const cancel = new AbortController();
  const wait = client.callTool({ name: 'browser_wait', arguments: { ...access, timeoutSeconds: 25 } }, undefined, { signal: cancel.signal });
  const rejected = assert.rejects(wait); setTimeout(() => cancel.abort(), 50); await rejected;
  assert.equal(result(await client.callTool({ name: 'browser_status', arguments: access })).control, 'human');
  assert.equal((await fetch(f.base + '/mcp', { method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  // node:fetch normalizes Host, so use a raw HTTP request for this guard.
  assert.equal(await new Promise(resolve => { const req = request(f.base + '/mcp', { method: 'POST', headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); }), 403);
  assert.equal((await fetch(f.base + '/mcp?key=must-not-be-in-url', { method: 'POST' })).status, 400);
  assert.equal((await fetch(f.base + '/mcp')).status, 405);
  assert.equal((await fetch(f.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ padding: 'x'.repeat(66000) }) })).status, 413);
});

test('public mode bounds lifetime, preserves public egress, and isolates its data from team/offline-demo', () => {
  const config = readConfig({ BROWSER_AUTH_MODE: 'public', BROWSER_MODE: 'docker', BROWSER_DATA_DIR: '/data', BROWSER_DATA_VOLUME: 'test-volume', SESSION_TTL_SECONDS: '14400', SESSION_MAX_LIFETIME_SECONDS: '86400' });
  assert.equal(config.ttlMs, 300000); assert.equal(config.maxLifetimeMs, 600000);
  assert.equal(config.runtimeNetwork, 'public'); assert.equal(config.dataDirectory, '/data/public-browser');
  assert.equal(config.runtimeVolume!.root, '/data'); assert.equal(config.maxSessionsPerOwner, 1);
  assert.equal(config.trustProxy, false);
  assert.throws(() => readConfig({ BROWSER_AUTH_MODE: 'public', BROWSER_MODE: 'desktop' }));
  const request = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-real-ip': '198.51.100.22' } } as unknown as IncomingMessage;
  assert.equal(publicClientAddress(request), '127.0.0.1'); assert.equal(publicClientAddress(request, true), '198.51.100.22');
  request.headers['x-real-ip'] = '198.51.100.22, attacker'; assert.equal(publicClientAddress(request, true), '127.0.0.1');
});

test('public MCP: disconnected creation discards the unclaimed browser and returns quota', async t => {
  const gate = deferred(), entered = deferred(); let first = true;
  const f = await fixture(t, 1, async () => { if (first) { first = false; entered.resolve(); await gate.promise; } });
  const cancel = new AbortController();
  const creating = fetch(f.base + '/mcp', { method: 'POST', signal: cancel.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_create', arguments: {} } }) });
  const rejected = assert.rejects(creating); await entered.promise; cancel.abort(); await rejected;
  // Let the disconnected HTTP request reach the server before launch resolves.
  await new Promise(resolve => setTimeout(resolve, 50)); gate.resolve();
  for (let i = 0; i < 100 && !f.closed(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.closed(), 1);
  assert.deepEqual(f.registry.list(), []); assert.equal(f.identity.listMembers().length, 0);
  assert.ok(result(await (await f.client()).callTool({ name: 'browser_create', arguments: {} })).sessionKey);
});

test('public MCP: request budget is enforced before executing more tools', async t => {
  const f = await fixture(t);
  for (let id = 0; id <= 120; id++) {
    const response = await fetch(f.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) });
    assert.equal(response.status, id < 120 ? 200 : 429); await response.arrayBuffer();
  }
});

test('public human links expire without consuming another guest identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-claim-expiry-')); let now = Date.now();
  const identity = new IdentityStore(root, () => now);
  const registry = new SessionRegistry({ async create() { return fakeWorkspace(); }, async close() {} }, { ttlMs: 300000, maxSessions: 1 }, () => now);
  const remote = new RemoteMcp(registry, identity, {}, () => now);
  t.after(async () => { await remote.close(); await registry.close(); identity.close(); await rm(root, { recursive: true, force: true }); });
  const created = await (remote as any).create('fixture', 'https://demo.example', { purpose: 'Expiry' }, new AbortController().signal);
  const ticket = new URL(created.humanUrl).hash.slice(1).split('.')[1];
  now += 120001;
  await assert.rejects(remote.claim(created.id, ticket, 'https://demo.example', {} as ServerResponse), { status: 410 });
  now += 480000; identity.reap(); await remote.reap();
  assert.equal(identity.listMembers().length, 0);
});

test('public failed creation retains source quota until browser cleanup succeeds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-public-cleanup-'));
  let cleanupReady = false, creates = 0, closed = 0;
  const identity = new IdentityStore(root);
  const registry = new SessionRegistry({ async create() {
    const first = ++creates === 1;
    return { ...fakeWorkspace(), async perform() { if (first) throw new Error('Synthetic navigation failure'); return {}; },
      async close() { if (!cleanupReady) throw new Error('Synthetic cleanup failure'); closed++; } };
  }, async close() {} }, { ttlMs: 300000, maxSessions: 4 });
  const remote = new RemoteMcp(registry, identity, { maxSessionsPerIp: 1 });
  t.after(async () => { cleanupReady = true; await remote.close(); await registry.close(); identity.close(); await rm(root, { recursive: true, force: true }); });
  const create = () => (remote as any).create('fixture', 'http://127.0.0.1', { purpose: 'Cleanup fixture' }, new AbortController().signal);
  await assert.rejects(create());
  await assert.rejects(create(), { status: 429 }); assert.equal(creates, 1);
  cleanupReady = true;
  assert.ok((await create()).sessionKey); assert.equal(closed, 1); assert.equal(identity.listMembers().length, 1);
});
