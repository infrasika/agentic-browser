import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { IdentityStore } from '../src/identity.js';
import { SessionRegistry } from '../src/sessions.js';
import { createHttpServer } from '../src/http.js';
import { deferred, fakeWorkspace } from './helpers.js';

test('revoking an Agent during an action prevents queued actions from starting and suppresses the old result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-auth-race-'));
  const identity = new IdentityStore(root);
  const member = await identity.createMember('alice', 'synthetic-race-password');
  const login = await identity.login('alice', 'synthetic-race-password', 'fixture');
  const human = identity.authenticate(login.token, 'human'), key = identity.issueAgent(human, 'Race fixture');
  const started = deferred(), release = deferred(); let executions = 0;
  const registry = new SessionRegistry({ async create() { return { ...fakeWorkspace(), async perform() { executions++; started.resolve(); await release.promise; return { privateResult: 'must-not-return-after-revocation' }; } }; }, async close() {} }, { ttlMs: 60000, maxSessions: 2 });
  const server = createHttpServer(registry, { publicUrl: 'http://127.0.0.1:3333', identity });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { release.resolve(); server.close(); server.closeAllConnections(); await registry.close(); identity.close(); await rm(root, { recursive: true, force: true }); });
  const session = await registry.create('Revocation race', undefined, member.id, identity.authenticate(key.token, 'agent').credentialHash);
  const action = () => fetch(`${base}/api/sessions/${session.id}/actions`, { method: 'POST', headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'snapshot' }) });
  const active = action(); await started.promise;
  const queued = action(); await delay(50);
  identity.revokeAgent(human, key.id); release.resolve();
  const results = await Promise.all([active, queued]);
  for (const response of results) { assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), /must-not-return/); }
  assert.equal(executions, 1);
});
