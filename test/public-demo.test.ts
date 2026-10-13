import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { IdentityStore } from '../src/identity.js';
import { SessionRegistry } from '../src/sessions.js';
import { createHttpServer } from '../src/http.js';
import { readConfig } from '../src/config.js';
import { fakeWorkspace } from './helpers.js';

test('public demo configuration forces isolated runtimes, private demo storage, no egress and bounded lifetime', () => {
  const config = readConfig({ BROWSER_AUTH_MODE: 'demo', BROWSER_MODE: 'docker', BROWSER_NETWORK: 'public', BROWSER_DATA_DIR: '/tmp/fixture', SESSION_TTL_SECONDS: '14400', SESSION_MAX_LIFETIME_SECONDS: '86400', MAX_SESSIONS_PER_MEMBER: '32' });
  assert.equal(config.runtimeNetwork, 'none'); assert.equal(config.ttlMs, 300000); assert.equal(config.maxLifetimeMs, 600000);
  assert.equal(config.maxSessionsPerOwner, 1); assert.equal(config.dataDirectory, '/tmp/fixture/public-demo');
  assert.throws(() => readConfig({ BROWSER_AUTH_MODE: 'demo', BROWSER_MODE: 'desktop' }));
  assert.throws(() => readConfig({ BROWSER_AUTH_MODE: 'team', BROWSER_MODE: 'playwright' }));
});

test('public demo: two anonymous visitors have isolated identities; no profile/credential/arbitrary session APIs; expiry removes guests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-public-demo-'));
  let now = Date.now(), completed = 0, closed = 0;
  const identity = new IdentityStore(root, () => now);
  const registry = new SessionRegistry({ async create(options) {
    assert.equal(options?.profileId, undefined);
    return { ...fakeWorkspace(), async perform(action) {
      if (action.type === 'navigate') assert.equal(action.url, 'https://agentic-browser.invalid/demo');
      if (action.type === 'click' && action.selector === '#continue') completed++;
      return { url: 'http://127.0.0.1:8080/demo', text: '已登录：虚构访客' };
    }, async close() { closed++; } };
  }, async close() {} }, { ttlMs: 300000, maxSessions: 2, maxSessionsPerOwner: 1, maxLifetimeMs: 600000 }, () => now);
  const server = createHttpServer(registry, { publicUrl: 'http://127.0.0.1:3333', identity, demo: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.close(); server.closeAllConnections(); await registry.close(); identity.close(); await rm(root, { recursive: true, force: true }); });
  const call = (path: string, method = 'GET', cookie?: string, body?: unknown) => fetch(base + path, { method, headers: { Origin: base, 'X-Agentic-Browser': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.match(await (await call('/')).text(), /每位访客/);
  const first = await call('/api/demo/start', 'POST', undefined, {});
  const a = await first.json(), cookieA = first.headers.get('set-cookie')!.split(';')[0];
  const second = await call('/api/demo/start', 'POST', undefined, {});
  const b = await second.json(), cookieB = second.headers.get('set-cookie')!.split(';')[0];
  assert.notEqual(a.id, b.id); assert.equal(a.control, 'human'); assert.equal(a.profile, null);
  assert.equal(a.humanUrl, `${base}/view#${a.id}`);
  const resumed = await (await call('/api/demo/start', 'POST', cookieA, {})).json(); assert.equal(resumed.id, a.id);
  assert.equal((await call('/api/demo/start', 'POST', undefined, {})).status, 429);
  assert.equal(identity.listMembers().length, 2, 'Failed allocation removes its new guest identity');
  assert.equal((await call(`/api/human/${a.id}`, 'GET', cookieB)).status, 404);
  assert.deepEqual(await (await call('/api/profiles', 'GET', cookieA)).json(), { available: false, profiles: [] });
  for (const path of ['/api/profiles', '/api/credentials', '/api/sessions', '/api/auth/login']) assert.equal((await call(path, 'POST', cookieA, {})).status, 403, path);
  assert.equal((await call('/api/demo/start', 'POST', cookieA, { url: 'https://example.com' })).status, 400);
  assert.equal((await call(`/api/human/${a.id}/resume`, 'POST', cookieA, {})).status, 200); assert.equal(completed, 1);
  const state = await (await call(`/api/human/${a.id}`, 'GET', cookieA)).json(); assert.match(state.reason, /演示完成/); assert.equal(state.control, 'human');
  now += 600001; identity.reap(); await registry.closeInactiveMembers(owner => identity.isActive(owner));
  assert.equal(identity.listMembers().length, 0); assert.equal(closed, 2);
  assert.equal((await call(`/api/human/${a.id}`, 'GET', cookieA)).status, 401);
});
