import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSession } from "../src/scheduling/session.js";
import { deferred, fakeWorkspace } from "./helpers.js";

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

