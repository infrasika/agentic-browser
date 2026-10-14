import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopEngine } from "../src/desktop.js";
import { ProfileStore } from "../src/profiles.js";

async function launch(directory: string) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const token = "test-persistent-profile-service-token-32";
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    env: { ...process.env, AGENT_BROWSER_TOKEN: token, BROWSER_MODE: "desktop", BROWSER_DATA_DIR: directory,
      HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: base, SESSION_TTL_SECONDS: "60" },
    stdio: "ignore",
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    try { const [, signal] = await exited; assert.notEqual(signal, "SIGKILL"); }
    finally { clearTimeout(timer); }
  };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${base}/health`)).ok; } catch {}
    if (ready || child.exitCode !== null) break;
    await delay(100);
  }
  if (!ready) { await stop(); throw new Error("Test service failed to start"); }
  return {
    stop,
    async request(path: string, method = "GET", body?: unknown, expected = 200) {
      const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(25000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) });
      assert.equal(response.status, expected, await response.clone().text());
      return response.json() as Promise<any>;
    },
  };
}

test("opt-in native login survives a full service process restart; temporary profiles remain isolated", { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "native-persistence-"));
  const fixture = createServer((request, response) => {
    if (request.url === "/login" && request.method === "POST") {
      response.writeHead(303, { Location: "/", "Set-Cookie": "fixture_login=synthetic-user; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/" });
      response.end(); return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(request.headers.cookie?.includes("fixture_login=synthetic-user")
      ? "<h1>Signed in synthetic-user</h1>" : '<h1>Please sign in</h1><form method="post" action="/login"><button id="login">Sign in with fictional details</button></form>');
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const url = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  let service = await launch(directory);
  t.after(async () => {
    await service.stop();
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const profile = await service.request("/api/profiles", "POST", { name: "Persistent test profile" }, 201);
  const first = await service.request("/api/sessions", "POST", { profileId: profile.id, url }, 201);
  assert.equal(first.profile.id, profile.id);
  await service.request(`/api/sessions/${first.id}/actions`, "POST", { type: "click", selector: "#login" });
  assert.match(JSON.stringify(await service.request(`/api/sessions/${first.id}/actions`, "POST", { type: "snapshot" })), /Signed in synthetic-user/);
  await service.request("/api/sessions", "POST", { profileId: profile.id }, 409);
  await service.request(`/api/profiles/${profile.id}`, "DELETE", undefined, 409);
  await service.request(`/api/sessions/${first.id}/handoff`, "POST", { reason: "Test shutdown during human control" });
  // Shutdown while a saved browser is open, then run a completely new Node process.
  await service.stop();
  service = await launch(directory);
  assert.deepEqual((await service.request("/api/sessions")).sessions, []);
  assert.equal((await service.request("/api/profiles")).profiles[0].id, profile.id);
  const restored = await service.request("/api/sessions", "POST", { profileId: profile.id, url }, 201);
  assert.match(JSON.stringify(await service.request(`/api/sessions/${restored.id}/actions`, "POST", { type: "snapshot" })), /Signed in synthetic-user/);
  const temporary = await service.request("/api/sessions", "POST", { url }, 201);
  assert.equal(temporary.profile, null);
  assert.match(JSON.stringify(await service.request(`/api/sessions/${temporary.id}/actions`, "POST", { type: "snapshot" })), /Please sign in/);
  await service.request(`/api/sessions/${restored.id}`, "DELETE");
  // A failed browser launch must not keep the saved profile locked.
  const profiles = new ProfileStore(directory);
  await assert.rejects(new DesktopEngine({ profiles, executablePath: "/does-not-exist/chrome" }).create({ profileId: profile.id }));
  await service.request(`/api/profiles/${profile.id}`, "DELETE");
  assert.deepEqual((await service.request("/api/profiles")).profiles, []);
});
