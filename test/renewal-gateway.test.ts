import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, createConnection, type AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { fakeWorkspace, startService } from "./helpers.js";

test("a connected mirror survives renewal past its old deadline and closes at its new deadline", { timeout: 10000 }, async (t) => {
  const peers = new Set<ReturnType<typeof createConnection>>();
  const vnc = createServer((socket) => { peers.add(socket); socket.on("close", () => peers.delete(socket)); });
  vnc.listen(0, "127.0.0.1");
  await once(vnc, "listening");
  const workspace = { ...fakeWorkspace(), transport: "desktop" as const,
    openDesktop() { return createConnection({ port: (vnc.address() as AddressInfo).port, host: "127.0.0.1" }); } };
  const service = await startService({ create: async () => workspace, close: async () => {} }, 1200);
  t.after(async () => {
    await service.close();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => vnc.close(() => resolve()));
  });
  const session = await service.registry.create("Renew connected mirror");
  await session.transfer("human");
  const originalDeadline = session.expiresAt;
  const socket = new WebSocket(`${service.base.replace("http:", "ws:")}/api/human/${session.id}/desktop`, { origin: service.base });
  t.after(() => socket.terminate());
  await once(socket, "open");
  const ready = once(socket, "message");
  socket.send(JSON.stringify({ token: session.humanToken, revision: session.info().revision }));
  assert.equal((await ready)[0].toString(), "ready");
  await delay(600);
  session.extend();
  await delay(Math.max(0, originalDeadline - Date.now() + 100));
  assert.equal(socket.readyState, WebSocket.OPEN);
  const closed = once(socket, "close");
  await closed;
  assert.ok(Date.now() >= session.expiresAt);
  assert.throws(() => session.extend(), { code: "session_ended" });
});
