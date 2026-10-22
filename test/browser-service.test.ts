import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocket } from 'ws';
import { BrowserAllocationError, type BrowserEngine, type BrowserWorkspace } from '../src/contracts.js';
import { createControlServer } from '../src/api/server.js';
import { BrowserService } from '../src/scheduling/service.js';
import { SchedulerStore, type Principal } from '../src/scheduling/store.js';
import { ViewerGrants } from '../src/streaming/grants.js';
import { createDataServer } from '../src/streaming/server.js';

const options = { ttlMs: 60000, maxLifetimeMs: 120000, queueTtlMs: 60000, maxQueued: 100 };
const principal = (userId: string = randomUUID()): Principal => ({ userId, conversationId: randomUUID(), taskId: randomUUID() });
const input = () => ({ acquisitionId: randomUUID(), purpose: 'Test browser task', url: 'https://example.com/' });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function workspace(overrides: Partial<BrowserWorkspace> = {}): BrowserWorkspace {
  return { async perform(action) { return { type: action.type }; }, async screenshot() { return Buffer.from('frame'); }, async close() {}, ...overrides };
}
function engine(create: BrowserEngine['create'] = async () => workspace()): BrowserEngine { return { create, async close() {} }; }

test('history cleanup preserves unacknowledged recovery, live leases, and recent idempotency', () => {
  let now = 1000;
  const store = new SchedulerStore(':memory:', 2, () => now);
  try {
    const ended = store.acquire(principal(), input());
    store.beginOperation(ended.id, 'operation', 'fingerprint');
    store.finishOperation(ended.id, 'operation', { done: true });
    store.update(ended.id, { state: 'completed' }, 'session_ended');
    const live = store.acquire(principal(), input());
    now += 86400001;
    assert.equal(store.prune(86400000), 0);
    const cursor = store.events(0).at(-1)!.id;
    store.ack(cursor);
    const recent = store.acquire(principal(), input());
    store.update(recent.id, { state: 'cancelled' });
    assert.equal(store.prune(86400000), 1);
    assert.throws(() => store.get(ended.id), /not found/);
    assert.equal(store.get(live.id).state, 'queued');
    assert.equal(store.get(recent.id).state, 'cancelled');
    store.ack(cursor);
    assert.equal(store.cursor(), cursor);
  } finally { store.close(); }
});

test('FIFO capacity is global and per account; cleanup retains its slot until confirmed', async () => {
  const cleanup = deferred(); let creations = 0;
  const store = new SchedulerStore(':memory:', 20);
  const service = new BrowserService(store, engine(async () => {
    const index = creations++;
    return workspace({ async close() { if (index === 0) await cleanup.promise; } });
  }), options);
  try {
    const users = Array.from({ length: 21 }, () => principal());
    const requests = users.map(() => input());
    const leases = users.map((user, i) => service.acquire(user, requests[i]));
    await service.idle();
    assert.deepEqual(store.capacity(), { occupied: 20, maximum: 20 });
    assert.equal(creations, 20);
    assert.equal(service.status(leases[20].id, users[20]).position, 1);
    assert.throws(() => service.acquire(principal(users[0].userId), input()), /Another browser task/);
    assert.equal(service.acquire(users[0], requests[0]).id, leases[0].id);
    const releasing = service.release(leases[0].id, users[0]);
    await delay(0);
    assert.equal(store.capacity().occupied, 20);
    assert.equal(creations, 20);
    cleanup.resolve(); await releasing; await service.idle();
    assert.equal(creations, 21);
    assert.equal(service.status(leases[20].id, users[20]).state, 'active');
    assert.equal(store.capacity().occupied, 20);
    const events = store.events(0);
    assert.equal(events.filter(event => event.type === 'slot_ready').length, 21);
  } finally { cleanup.resolve(); await service.close(); }
});

test('failed allocation keeps user and global reservations until cleanup succeeds', async () => {
  let canClean = false; let creations = 0;
  const broken = workspace({ async close() { if (!canClean) throw new Error('cleanup unavailable'); } });
  const store = new SchedulerStore(':memory:', 1);
  const service = new BrowserService(store, engine(async () => {
    if (creations++ === 0) throw new BrowserAllocationError(broken);
    return workspace();
  }), options);
  try {
    const first = principal(); const second = principal();
    const a = service.acquire(first, input()); const b = service.acquire(second, input());
    await service.idle();
    assert.equal(service.status(a.id, first).state, 'cleanup_pending');
    assert.equal(service.status(b.id, second).state, 'queued');
    assert.equal(creations, 1);
    assert.throws(() => service.acquire(principal(first.userId), input()), /Another browser task/);
    canClean = true; await service.tick(); await service.idle();
    assert.equal(service.status(a.id, first).state, 'failed');
    assert.equal(service.status(b.id, second).state, 'active');
  } finally { canClean = true; await service.close(); }
});

test('cancelling while Chrome starts cannot publish ready or release its slot early', async () => {
  const started = deferred(); let closed = 0;
  const store = new SchedulerStore(':memory:', 1);
  const service = new BrowserService(store, engine(async () => {
    await started.promise;
    return workspace({ async close() { closed++; } });
  }), options);
  try {
    const user = principal(); const lease = service.acquire(user, input());
    await service.release(lease.id, user);
    assert.equal(store.capacity().occupied, 1);
    started.resolve(); await service.idle();
    assert.equal(store.capacity().occupied, 0);
    assert.equal(closed, 1);
    assert.equal(store.events(0).some(event => event.type === 'slot_ready'), false);
  } finally { started.resolve(); await service.close(); }
});

test('SQLite restart retains FIFO, events and confirmed operations; unknown actions cannot replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-scheduler-'));
  const path = join(directory, 'scheduler.sqlite');
  try {
    let store = new SchedulerStore(path, 1);
    const first = store.acquire(principal(), input());
    const waitingUser = principal(); const waitingInput = input();
    const waiting = store.acquire(waitingUser, waitingInput);
    assert.equal(store.reserve()?.id, first.id);
    store.update(first.id, { state: 'active', sessionId: randomUUID() }, 'slot_ready');
    store.beginOperation(first.id, 'done', 'one'); store.finishOperation(first.id, 'done', { clicked: true });
    store.beginOperation(first.id, 'uncertain', 'two');
    store.ack(1); store.close();
    store = new SchedulerStore(path, 1); store.recover();
    assert.equal(store.get(first.id).state, 'failed');
    assert.equal(store.acquire(waitingUser, waitingInput).id, waiting.id);
    assert.equal(store.reserve()?.id, waiting.id);
    assert.deepEqual(store.beginOperation(first.id, 'done', 'one'), { fresh: false, result: { clicked: true } });
    assert.throws(() => store.beginOperation(first.id, 'uncertain', 'two'), /no confirmed result/);
    assert.equal(store.cursor(), 1);
    assert.equal(store.events(1)[0].type, 'session_ended');
    assert.throws(() => store.ack(100), /Invalid event cursor/);
    store.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('two scheduler connections cannot exceed capacity or allocate two tasks for one account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-scheduler-race-'));
  const path = join(directory, 'scheduler.sqlite');
  const a = new SchedulerStore(path, 1); const b = new SchedulerStore(path, 1);
  try {
    const user = principal(); a.acquire(user, input());
    assert.throws(() => b.acquire(principal(user.userId), input()), /Another browser task/);
    b.acquire(principal(), input());
    assert.ok(a.reserve()); assert.equal(b.reserve(), undefined);
    assert.equal(a.capacity().occupied, 1);
  } finally { a.close(); b.close(); await rm(directory, { recursive: true, force: true }); }
});

test('private API checks service, user, task, actor and revisions; replay does not repeat clicks', async () => {
  let clicks = 0;
  const store = new SchedulerStore(':memory:', 2);
  const service = new BrowserService(store, engine(async () => workspace({ async perform(action) {
    if (action.type === 'click') clicks++;
    return { type: action.type };
  } })), options);
  const grants = new ViewerGrants(); const token = 'a'.repeat(64);
  const server = createControlServer(service, grants, token);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const user = principal('507f1f77bcf86cd799439011');
  const call = (path: string, method = 'GET', body?: unknown, owner = user, actor = 'agent', key = token) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-User-ID': owner.userId,
      'X-Conversation-ID': owner.conversationId, 'X-Task-ID': owner.taskId, 'X-Actor': actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await call('/internal/v1/leases', 'POST', input(), user, 'agent', 'fake')).status, 401);
    const allocated = await call('/internal/v1/leases', 'POST', input());
    assert.equal(allocated.status, 202);
    const lease = await allocated.json() as { id: string };
    const path = `/internal/v1/leases/${lease.id}`;
    await service.idle();
    assert.equal((await call(path, 'GET', undefined, principal())).status, 404);
    assert.equal((await call(path, 'GET', undefined, { ...user, taskId: randomUUID() })).status, 404);
    const click = { operationId: 'click-1', revision: 0, action: { type: 'click', selector: '#go' } };
    assert.equal((await call(`${path}/actions`, 'POST', click)).status, 200);
    assert.equal((await call(`${path}/actions`, 'POST', click)).status, 200);
    assert.equal(clicks, 1);
    assert.equal((await call(`${path}/actions`, 'POST', { ...click, action: { type: 'click', selector: '#other' } })).status, 409);
    const handoff = { operationId: 'handoff-1', revision: 0, target: 'human', reason: 'Sign in' };
    assert.equal((await call(`${path}/control`, 'POST', handoff)).status, 200);
    assert.equal((await call(`${path}/snapshot`, 'POST', {})).status, 409);
    assert.equal((await call(`${path}/actions`, 'POST', { ...click, operationId: 'click-2' })).status, 409);
    assert.equal((await call(`${path}/control`, 'POST', { operationId: 'return-1', revision: 1, target: 'agent' })).status, 403);
    assert.equal((await call(`${path}/control`, 'POST', { operationId: 'return-1', revision: 1, target: 'agent' }, user, 'human')).status, 200);
    // A replay reads the original result; it cannot switch control back to human.
    assert.equal((await call(`${path}/control`, 'POST', handoff)).status, 200);
    assert.equal(service.status(lease.id, user).control, 'agent');
    assert.equal(store.events(0).filter(event => event.type === 'control_returned').length, 1);
    assert.equal((await call(`${path}/viewer-grants`, 'POST', { role: 'observe', revision: 2 })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await service.close(); }
});

test('public data listener exposes no control routes; viewer grants are single-use and readonly', async () => {
  const store = new SchedulerStore(':memory:', 1);
  const service = new BrowserService(store, engine(), options);
  const grants = new ViewerGrants();
  const origin = 'https://agentic-browser.zkpass.org';
  const server = createDataServer(service, grants, origin);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ['/mcp', '/internal/v1/events', '/api/sessions', '/view', '/connect']) assert.equal((await fetch(base + path)).status, 404);
    const user = principal(); const lease = service.acquire(user, input()); await service.idle();
    const grant = grants.issue({ ...user, leaseId: lease.id, role: 'observe', revision: 0 });
    const ws = new WebSocket(base.replace('http:', 'ws:') + grant.path, { origin });
    await once(ws, 'open'); ws.send(JSON.stringify({ grant: grant.grant }));
    const [frame] = await once(ws, 'message'); assert.equal(frame.toString(), 'frame');
    const closed = once(ws, 'close'); ws.send(Buffer.from('fake keyboard input')); await closed;
    const replay = new WebSocket(base.replace('http:', 'ws:') + grant.path, { origin });
    await once(replay, 'open'); const rejected = once(replay, 'close'); replay.send(JSON.stringify({ grant: grant.grant })); await rejected;
    const wrongRole = grants.issue({ ...user, leaseId: lease.id, role: 'observe', revision: 0 });
    assert.throws(() => grants.consume(wrongRole.grant, 'input'), /authorization expired/);
  } finally {
    server.closeViewers(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await service.close();
  }
});
