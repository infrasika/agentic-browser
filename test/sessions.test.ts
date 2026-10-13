import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSession, SessionRegistry } from "../src/sessions.js";
import { deferred, fakeWorkspace } from "./helpers.js";

test('member quota counts pending allocation and frees capacity after cleanup retries', async () => {
  const ready = deferred(); let attempts = 0;
  const registry = new SessionRegistry({ async create() {
    await ready.promise;
    return { ...fakeWorkspace(), async close() { if (++attempts === 1) throw new Error('temporary cleanup failure'); } };
  }, async close() {} }, { ttlMs: 60000, maxSessions: 4, maxSessionsPerOwner: 1 });
  const first = registry.create('First', undefined, 'owner-A');
  await assert.rejects(registry.create('Second', undefined, 'owner-A'), { code: 'session_limit' });
  const other = registry.create('Other member', undefined, 'owner-B');
  ready.resolve();
  const a = await first; await other;
  await assert.rejects(registry.remove(a.id, 'owner-A'), /cleanup failure/);
  assert.equal(a.info().control, 'closed');
  await registry.reap();
  assert.equal(registry.list('owner-A').length, 0);
  await registry.create('Replacement', undefined, 'owner-A');
  await registry.close();
});

test('session renewal cannot exceed the configured absolute lifetime', () => {
  let now = 0;
  const session = new BrowserSession('bounded', fakeWorkspace(), 1000, () => now, undefined, undefined, 1800);
  now = 900; session.extend(); assert.equal(session.expiresAt, 1800);
  now = 1700; session.extend(); assert.equal(session.expiresAt, 1800);
  now = 1800; assert.throws(() => session.extend(), { code: 'session_ended' });
});

test("desktop transfer revokes live input immediately and waits for detach before human access", async () => {
  const workspace = fakeWorkspace();
  const switching = deferred();
  const detached = deferred();
  let revoked = 0;
  workspace.revokeHumanInput = () => {
    revoked++;
  };
  workspace.setControl = async () => {
    switching.resolve();
    await detached.promise;
  };
  const session = new BrowserSession("desktop", workspace, 60000);
  const transfer = session.transfer("human");
  assert.equal(revoked, 1);
  await switching.promise;
  await assert.rejects(
    session.run("human", async () => {}),
    { code: "control_unavailable" },
  );
  detached.resolve();
  await transfer;
  assert.equal(session.info().control, "human");
});

test("failed desktop reconnection closes the session instead of granting control", async () => {
  const workspace = fakeWorkspace();
  const session = new BrowserSession("desktop failure", workspace, 60000);
  await session.transfer("human");
  workspace.setControl = async () => {
    throw new Error("attach failed");
  };
  await assert.rejects(session.transfer("agent"), /attach failed/);
  assert.equal(session.info().control, "closed");
  assert.equal(workspace.closed, true);
});

test("handoff fences queued work and drains active work before admitting the human", async () => {
  const session = new BrowserSession("race", fakeWorkspace(), 60000);
  const started = deferred();
  const release = deferred();
  const active = session.run("agent", async () => {
    started.resolve();
    await release.promise;
    return "old screen";
  });
  await started.promise;
  let queuedRan = false;
  const queued = session.run("agent", async () => {
    queuedRan = true;
  });
  const activeRejected = assert.rejects(active, {
    code: "control_unavailable",
  });
  const queuedRejected = assert.rejects(queued, {
    code: "control_unavailable",
  });
  const handoff = session.transfer("human", "Login");
  assert.equal(session.info().control, "switching");
  await assert.rejects(
    session.run("human", async () => {}),
    { code: "control_unavailable" },
  );
  await assert.rejects(
    session.run("agent", async () => {}),
    { code: "control_unavailable" },
  );
  release.resolve();
  await Promise.all([activeRejected, queuedRejected, handoff]);
  assert.equal(queuedRan, false);
  assert.equal(session.info().control, "human");
  await session.run("human", async () => {});
});

test("returning control preserves the workspace and rejects further human input", async () => {
  const workspace = fakeWorkspace();
  const session = new BrowserSession("login", workspace, 60000);
  await session.transfer("human");
  await session.run("human", async (current) => {
    assert.equal(current, workspace);
  });
  await assert.rejects(
    session.run("agent", (current) => current.screenshot()),
    { code: "control_unavailable" },
  );
  await session.transfer("agent");
  assert.equal(session.info().revision, 2);
  await session.run("agent", async (current) => {
    assert.equal(current, workspace);
  });
  await assert.rejects(
    session.run("human", async () => {}),
    { code: "control_unavailable" },
  );
  assert.equal(workspace.closed, false);
});

test("a failed action does not poison the queue or future handoffs", async () => {
  const session = new BrowserSession("failure", fakeWorkspace(), 60000);
  await assert.rejects(
    session.run("agent", async () => {
      throw new Error("failed");
    }),
  );
  await session.run("agent", async () => {});
  await session.transfer("human");
  assert.equal(session.info().control, "human");
});

test("closing during a handoff cannot revive the session", async () => {
  const session = new BrowserSession("close", fakeWorkspace(), 60000);
  const started = deferred();
  const release = deferred();
  const running = session.run("agent", async () => {
    started.resolve();
    await release.promise;
  });
  const rejected = assert.rejects(running, { code: "session_ended" });
  await started.promise;
  const handoff = session.transfer("human");
  const transferRejected = assert.rejects(handoff, { code: "session_ended" });
  await session.close();
  release.resolve();
  await Promise.all([rejected, transferRejected]);
  assert.equal(session.info().control, "closed");
});

test("expiry is enforced before the cleanup timer and contexts are reclaimed", async () => {
  let now = 0;
  const workspace = fakeWorkspace();
  const registry = new SessionRegistry(
    { create: async () => workspace, close: async () => {} },
    { ttlMs: 1000, maxSessions: 1 },
    () => now,
  );
  const session = await registry.create("ttl");
  now = 1000;
  assert.throws(() => registry.get(session.id), { code: "session_ended" });
  await assert.rejects(
    session.run("agent", async () => {}),
    { code: "session_ended" },
  );
  await registry.reap();
  assert.equal(workspace.closed, true);
  assert.deepEqual(registry.list(), []);
});

test("capacity accounts for browser launches still in progress", async () => {
  const pending = deferred<ReturnType<typeof fakeWorkspace>>();
  const registry = new SessionRegistry(
    { create: () => pending.promise, close: async () => {} },
    { ttlMs: 60000, maxSessions: 1 },
  );
  const first = registry.create("first");
  await assert.rejects(registry.create("second"), { code: "session_limit" });
  pending.resolve(fakeWorkspace());
  await first;
  await registry.close();
});

test("shutdown disposes a browser context that finishes starting late", async () => {
  const workspace = fakeWorkspace();
  const pending = deferred<typeof workspace>();
  const registry = new SessionRegistry(
    { create: () => pending.promise, close: async () => {} },
    { ttlMs: 60000, maxSessions: 1 },
  );
  const creation = registry.create("late");
  const rejected = assert.rejects(creation, { code: "shutting_down" });
  const closing = registry.close();
  pending.resolve(workspace);
  await Promise.all([rejected, closing]);
  assert.equal(workspace.closed, true);
  assert.deepEqual(registry.list(), []);
});

test("renewal resets the remaining duration without accumulating time or reviving expired sessions", async () => {
  let now = 1000;
  const workspace = fakeWorkspace();
  const session = new BrowserSession("renew", workspace, 1000, () => now);
  await session.transfer("human");
  now = 1500;
  const renewed = session.extend();
  assert.equal(renewed.expiresAt, new Date(2500).toISOString());
  assert.equal(renewed.control, "human");
  assert.equal(renewed.revision, 1);
  assert.equal(session.extend().expiresAt, renewed.expiresAt);
  now = 2000; // The original deadline no longer ends the live browser.
  await session.run("human", async () => {});
  now = 2500;
  assert.throws(() => session.extend(), { code: "session_ended" });
  await session.close();
  now = 1500;
  assert.throws(() => session.extend(), { code: "session_ended" });
});
