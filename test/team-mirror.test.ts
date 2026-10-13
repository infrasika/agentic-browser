import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, createConnection, type Socket, type AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { MirrorGrants } from '../src/mirror-grants.js';
import { IdentityStore, type Principal } from '../src/identity.js';
import { SessionRegistry } from '../src/sessions.js';
import { createHttpServer } from '../src/http.js';

test('mirror grants: expiry, replay, session, revision and exact human login are checked', () => {
  let now = 0;
  const grants = new MirrorGrants(() => now);
  const human: Principal = { kind: 'human', ownerId: randomUUID(), credentialHash: 'login-A' };
  const id = randomUUID();
  const first = grants.issue(id, 1, human);
  grants.consume(first.ticket, id, 1, human);
  assert.throws(() => grants.consume(first.ticket, id, 1, human));
  const expired = grants.issue(id, 1, human); now = 15000;
  assert.throws(() => grants.consume(expired.ticket, id, 1, human));
  for (const [session, revision, principal] of [
    [randomUUID(), 1, human], [id, 2, human], [id, 1, { ...human, credentialHash: 'different-login' }],
    [id, 1, { ...human, ownerId: randomUUID() }], [id, 1, { ...human, kind: 'agent' }],
  ] as const) {
    const ticket = grants.issue(id, 1, human);
    assert.throws(() => grants.consume(ticket.ticket, session, revision, principal));
  }
  assert.throws(() => grants.issue(id, 1, { ...human, kind: 'agent' }));
});

test('team mirror: cookie + single-use ticket required; one input window; logout and handback revoke live connections', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-mirror-team-'));
  const identity = new IdentityStore(root);
  const alice = await identity.createMember('alice', 'synthetic-mirror-password');
  await identity.createMember('bob', 'synthetic-mirror-password');
  const login = await identity.login('alice', 'synthetic-mirror-password', 'fixture');
  const bob = await identity.login('bob', 'synthetic-mirror-password', 'fixture');
  const human = identity.authenticate(login.token, 'human');
  const agent = identity.issueAgent(human, 'Synthetic mirror Agent');
  const nativePeers = new Set<Socket>(), nativeClients = new Set<Socket>();
  const vnc = createServer(socket => { nativePeers.add(socket); socket.on('close', () => nativePeers.delete(socket)); });
  vnc.listen(0, '127.0.0.1'); await once(vnc, 'listening');
  const revoke = () => { for (const socket of nativeClients) socket.destroy(); nativeClients.clear(); };
  const registry = new SessionRegistry({
    async create() { return { transport: 'desktop' as const,
      async perform() {}, async screenshot() { return Buffer.alloc(0); }, async close() { revoke(); },
      revokeHumanInput: revoke,
      openDesktop() { const socket = createConnection({ host: '127.0.0.1', port: (vnc.address() as AddressInfo).port }); nativeClients.add(socket); socket.on('close', () => nativeClients.delete(socket)); return socket; },
    }; }, async close() {},
  }, { ttlMs: 60000, maxSessions: 2 });
  const server = createHttpServer(registry, { publicUrl: 'http://127.0.0.1:3333', identity });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await registry.create('Mirror fixture', undefined, alice.id);
  await session.transfer('human');
  const sockets = new Set<WebSocket>();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await registry.close(); server.close(); server.closeAllConnections();
    for (const socket of nativePeers) socket.destroy();
    vnc.close(); identity.close(); await rm(root, { recursive: true, force: true });
  });
  const url = `${base.replace('http:', 'ws:')}/api/human/${session.id}/desktop`;
  async function grant() {
    const response = await fetch(`${base}/api/human/${session.id}/desktop-grant`, { method: 'POST', headers: { Cookie: `ab_login=${login.token}`, Origin: base, 'X-Agentic-Browser': '1', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200); return response.json();
  }
  async function connect(auth: unknown) {
    const socket = new WebSocket(url, { origin: base, headers: { Cookie: `ab_login=${login.token}` } });
    sockets.add(socket); await once(socket, 'open');
    const outcome = new Promise<string>(resolve => { socket.once('message', data => resolve(data.toString())); socket.once('close', () => resolve('closed')); });
    socket.send(JSON.stringify(auth));
    return { socket, outcome: await outcome };
  }
  async function rejected(headers: Record<string, string>, origin = base) {
    const socket = new WebSocket(url, { origin, headers }); sockets.add(socket);
    const response = once(socket, 'unexpected-response');
    socket.on('error', () => {});
    const [, incoming] = await response; incoming.resume(); socket.terminate();
    return incoming.statusCode;
  }
  assert.equal(await rejected({ Authorization: `Bearer ${agent.token}` }), 403);
  assert.equal(await rejected({ Cookie: `ab_login=${bob.token}` }), 403);
  assert.equal(await rejected({ Cookie: `ab_login=${login.token}` }, 'https://attacker.invalid'), 403);
  assert.equal((await connect({ revision: session.info().revision })).outcome, 'closed');
  const ticket = await grant();
  const first = await connect(ticket); assert.equal(first.outcome, 'ready');
  const replay = await connect(ticket); assert.equal(replay.outcome, 'closed');
  const competitor = await connect(await grant()); assert.equal(competitor.outcome, 'closed');
  assert.equal(first.socket.readyState, WebSocket.OPEN, 'Competing window cannot displace current input owner');
  const firstClosed = once(first.socket, 'close'); first.socket.close(); await firstClosed;
  const second = await connect(await grant()); assert.equal(second.outcome, 'ready');
  const secondClosed = once(second.socket, 'close'); await session.transfer('agent'); await secondClosed;
  await session.transfer('human');
  const third = await connect(await grant()); assert.equal(third.outcome, 'ready');
  const thirdClosed = once(third.socket, 'close'); identity.logout(human); await thirdClosed;
  assert.equal(await rejected({ Cookie: `ab_login=${login.token}` }), 403);
});
