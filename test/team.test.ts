import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { IdentityStore } from '../src/identity.js';
import { ProfileStore } from '../src/profiles.js';
import { SessionRegistry } from '../src/sessions.js';
import { createHttpServer } from '../src/http.js';
import type { BrowserEngine, BrowserWorkspace } from '../src/contracts.js';

const password = 'synthetic-member-password-only';

test('identity: private metadata survives restart; key kinds, expiry, revocation and member disable are enforced', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-identity-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.now();
  let store = new IdentityStore(root, () => now);
  t.after(() => store.close());
  const member = await store.createMember('alice', password);
  await assert.rejects(store.login('nobody', password, 'fixture'));
  await assert.rejects(store.login('alice', 'incorrect-password', 'fixture'));
  const login = await store.login('alice', password, 'fixture');
  const human = store.authenticate(login.token, 'human');
  const agent = store.issueAgent(human, 'Test Agent');
  assert.equal(store.authenticate(agent.token, 'agent').ownerId, member.id);
  assert.throws(() => store.authenticate(login.token, 'agent'));
  assert.throws(() => store.authenticate(agent.token, 'human'));
  assert.throws(() => store.issueAgent(store.authenticate(agent.token, 'agent'), 'Escalation'));
  assert.equal((await stat(join(root, 'identity.sqlite'))).mode & 0o777, 0o600);
  const raw = await readFile(join(root, 'identity.sqlite'));
  for (const value of [password, login.token, agent.token]) assert.equal(raw.includes(Buffer.from(value)), false);
  store.close(); store = new IdentityStore(root, () => now);
  assert.equal(store.authenticate(agent.token, 'agent').ownerId, member.id);
  store.revokeAgent(store.authenticate(login.token, 'human'), agent.id);
  assert.throws(() => store.authenticate(agent.token, 'agent'));
  const second = store.issueAgent(human, 'Second Agent');
  await store.setPassword('alice', 'replacement-fixture-password');
  assert.throws(() => store.authenticate(second.token, 'agent'));
  assert.throws(() => store.authenticate(login.token, 'human'));
  const newLogin = await store.login('alice', 'replacement-fixture-password', 'fixture');
  store.setActive('alice', false);
  assert.throws(() => store.authenticate(newLogin.token, 'human'));
  store.setActive('alice', true);
  assert.throws(() => store.authenticate(newLogin.token, 'human'), 'Enabling never revives revoked credentials');
  const expiring = await store.login('alice', 'replacement-fixture-password', 'fixture');
  now += 13 * 3600000;
  assert.throws(() => store.authenticate(expiring.token, 'human'));
});

test('profiles: ownerless data is frozen in team mode; only local explicit migration assigns it once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-profile-owner-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = new ProfileStore(root);
  const alice = '11111111-1111-4111-8111-111111111111';
  const bob = '22222222-2222-4222-8222-222222222222';
  const legacy = await profiles.create('Ownerless fixture');
  assert.deepEqual(await profiles.list(alice), []);
  await assert.rejects(profiles.acquire(legacy.id, alice));
  const busy = await profiles.acquire(legacy.id);
  await assert.rejects(profiles.assignOwner(legacy.id, alice));
  await busy.release();
  await profiles.assignOwner(legacy.id, alice);
  assert.equal((await profiles.list(alice)).length, 1);
  assert.deepEqual(await profiles.list(), []);
  await assert.rejects(profiles.assignOwner(legacy.id, bob));
  await assert.rejects(profiles.acquire(legacy.id, bob));
  await assert.rejects(profiles.remove(legacy.id, bob));
  const own = await profiles.acquire(legacy.id, alice);
  await assert.rejects(profiles.acquire(legacy.id, alice));
  await own.release();
  await profiles.remove(legacy.id, alice);
});

test('team HTTP: two members and Agents cannot cross resource ownership or acquire human credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-team-http-test-'));
  const identity = new IdentityStore(join(root, 'identity'));
  const profiles = new ProfileStore(root);
  const alice = await identity.createMember('alice', password);
  await identity.createMember('bob', password);
  const engine: BrowserEngine = {
    profiles,
    async create(options) {
      const lease = options?.profileId ? await profiles.acquire(options.profileId, options.ownerId) : undefined;
      return {
        profile: lease?.info,
        async perform() { return { text: 'Synthetic fixture' }; },
        async screenshot() { return Buffer.from('synthetic-screen'); },
        async close() { await lease?.release(); },
      } satisfies BrowserWorkspace;
    },
    async close() {},
  };
  const registry = new SessionRegistry(engine, { ttlMs: 60000, maxSessions: 10 });
  const server = createHttpServer(registry, { publicUrl: 'http://127.0.0.1:3333', identity, token: 'legacy-token-must-not-work'.repeat(2) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.close(); server.closeAllConnections(); await registry.close(); identity.close(); await rm(root, { recursive: true, force: true }); });
  async function call(path: string, method = 'GET', credential?: string, body?: unknown, origin = base) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin, 'X-Agentic-Browser': '1' };
    if (credential?.startsWith('ab_login=')) headers.Cookie = credential;
    else if (credential) headers.Authorization = `Bearer ${credential}`;
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
    return { response, data, status: response.status };
  }
  const aLogin = await call('/api/auth/login', 'POST', undefined, { username: 'alice', password });
  assert.equal(aLogin.status, 200);
  const cookieA = aLogin.response.headers.get('set-cookie')!.split(';')[0];
  assert.match(aLogin.response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.equal('token' in aLogin.data, false);
  const bLogin = await call('/api/auth/login', 'POST', undefined, { username: 'bob', password });
  const cookieB = bLogin.response.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call('/api/auth/login', 'POST', undefined, { username: 'alice', password }, 'https://attacker.invalid')).status, 403);
  assert.equal((await call('/api/sessions', 'POST', cookieA, {}, 'https://attacker.invalid')).status, 403);
  const profile = (await call('/api/profiles', 'POST', cookieA, { name: 'Alice profile' })).data;
  const keyA = (await call('/api/credentials', 'POST', cookieA, { name: 'Alice Agent', profileIds: [profile.id] })).data;
  const keyB = (await call('/api/credentials', 'POST', cookieB, { name: 'Bob Agent' })).data;
  assert.equal((await call('/api/credentials', 'POST', keyA.token, { name: 'Privilege escalation' })).status, 401);
  assert.equal((await call('/api/sessions', 'GET', 'legacy-token-must-not-work'.repeat(2))).status, 401);
  const old = await profiles.create('Frozen legacy profile');
  assert.deepEqual((await call('/api/profiles', 'GET', keyA.token)).data.profiles.map((p: { id: string }) => p.id), [profile.id]);
  assert.equal((await call('/api/sessions', 'POST', keyA.token, { profileId: old.id })).status, 404);
  assert.equal((await call('/api/profiles', 'POST', keyA.token, { name: 'Forbidden creation' })).status, 403);
  assert.equal((await call('/api/profiles', 'DELETE', keyB.token)).status, 404);
  assert.equal((await call(`/api/profiles/${profile.id}`, 'DELETE', keyB.token)).status, 403);
  assert.equal((await call('/api/sessions', 'POST', keyB.token, { profileId: profile.id })).status, 404);
  const created = await call('/api/sessions', 'POST', keyA.token, { purpose: 'Alice private task', profileId: profile.id });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal(created.data.humanUrl, `${base}/view#${id}`);
  assert.equal('humanToken' in created.data, false);
  assert.equal((await call('/api/sessions', 'GET', cookieA)).data.sessions.length, 1);
  assert.deepEqual((await call('/api/sessions', 'GET', keyB.token)).data.sessions, []);
  assert.equal((await call('/api/sessions', 'POST', keyA.token, { ownerId: alice.id })).status, 400);
  for (const [operation, method, body] of [
    ['', 'GET', undefined], ['', 'DELETE', undefined], ['/screen', 'GET', undefined],
    ['/actions', 'POST', { type: 'snapshot' }], ['/handoff', 'POST', {}], ['/extend', 'POST', {}], ['/human-link', 'POST', {}],
  ] as const) assert.equal((await call(`/api/sessions/${id}${operation}`, method, keyB.token, body)).status, 404, operation);
  assert.equal((await call(`/api/human/${id}`, 'GET', cookieB)).status, 404);
  assert.equal((await call(`/api/human/${id}`, 'GET', keyA.token)).status, 401);
  assert.equal((await call(`/api/sessions/${id}/handoff`, 'POST', keyA.token, {})).status, 200);
  assert.equal((await call(`/api/sessions/${id}/actions`, 'POST', keyA.token, { type: 'snapshot' })).status, 409);
  assert.equal((await call(`/api/human/${id}/resume`, 'POST', cookieA, {})).status, 200);
  assert.equal((await call(`/api/sessions/${id}/actions`, 'POST', keyA.token, { type: 'snapshot' })).status, 200);
  await call(`/api/credentials/${keyA.id}`, 'DELETE', cookieB);
  assert.equal((await call(`/api/sessions/${id}`, 'GET', keyA.token)).status, 200, 'Bob cannot revoke Alice credential');
  await call(`/api/credentials/${keyA.id}`, 'DELETE', cookieA);
  assert.equal((await call(`/api/sessions/${id}`, 'GET', keyA.token)).status, 401);
  const replacement = (await call('/api/credentials', 'POST', cookieA, { name: 'New Alice Agent' })).data;
  assert.equal((await call(`/api/sessions/${id}`, 'GET', replacement.token)).status, 404, 'Same-owner key cannot claim another credential session');
  assert.deepEqual((await call('/api/profiles', 'GET', replacement.token)).data.profiles, [], 'Profile access is explicitly granted');
  assert.equal((await call('/api/sessions', 'POST', replacement.token, { profileId: profile.id })).status, 404);
  assert.equal((await call(`/api/human/${id}/bind-agent`, 'POST', cookieA, { credentialId: replacement.id })).status, 200);
  assert.equal((await call(`/api/sessions/${id}`, 'GET', replacement.token)).status, 200);
  assert.equal((await call(`/api/sessions/${id}/actions`, 'POST', replacement.token, { type: 'snapshot' })).status, 409, 'Binding fences input until human returns control');
  identity.setActive('alice', false);
  assert.equal((await call(`/api/human/${id}`, 'GET', cookieA)).status, 401);
  assert.equal((await call(`/api/sessions/${id}`, 'GET', replacement.token)).status, 401);
  await registry.closeInactiveMembers(owner => identity.isActive(owner));
  assert.deepEqual(registry.list(alice.id), []);
  assert.equal((await profiles.list(alice.id)).length, 1, 'Disabling closes sessions but retains private saved data');
  await call('/api/auth/logout', 'POST', cookieB, {});
  assert.equal((await call('/api/auth/me', 'GET', cookieB)).status, 401);
});
