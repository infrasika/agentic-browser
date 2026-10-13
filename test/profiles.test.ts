import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../src/profiles.js";
import { fakeWorkspace, startService } from "./helpers.js";

test("saved profiles survive store recreation, restrict permissions, and exclude concurrent use/deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "profiles-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new ProfileStore(root);
  const info = await first.create("测试账号");
  const second = new ProfileStore(root);
  assert.deepEqual(await second.list(), [info]);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "profiles", info.id, "profile.json"))).mode & 0o777, 0o600);
  const lease = await first.acquire(info.id);
  await writeFile(join(lease.directory, "test-state"), "synthetic login");
  try {
    await assert.rejects(second.acquire(info.id), { code: "profile_in_use" });
    await assert.rejects(second.remove(info.id), { code: "profile_in_use" });
  } finally { await lease.release(); }
  const reopened = await second.acquire(info.id);
  assert.equal(await readFile(join(reopened.directory, "test-state"), "utf8"), "synthetic login");
  await reopened.release();
  await first.remove(info.id);
  assert.deepEqual(await second.list(), []);
  await assert.rejects(first.acquire(info.id), { code: "profile_not_found" });
  await assert.rejects(first.acquire("../../escape"));
});

test("orphaned Chrome process locks block deletion and reuse", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "profiles-orphan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProfileStore(root);
  const info = await store.create("Orphan guard");
  const lease = await store.acquire(info.id);
  await lease.release();
  const lock = join(lease.directory, "SingletonLock");
  await symlink(`${hostname()}-${process.pid}`, lock);
  await assert.rejects(store.remove(info.id), { code: "profile_in_use" });
  await assert.rejects(store.acquire(info.id), { code: "profile_in_use" });
  await rm(lock);

  const afterFailure = await store.acquire(info.id);
  await afterFailure.release();
  await store.remove(info.id);
});

test("HTTP profile management and link recovery require agent authorization; human renewal preserves control", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "profiles-http-"));
  const store = new ProfileStore(root);
  const service = await startService({ profiles: store, create: async () => fakeWorkspace(), close: async () => {} });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const created = await service.request("/api/profiles", "POST", { name: "Saved account" });
  assert.equal(created.status, 201);
  const profile = await created.json() as { id: string };
  const session = await (await service.request("/api/sessions", "POST", {})).json() as { id: string; humanUrl: string };
  const humanToken = new URL(session.humanUrl).hash.split(".")[1];
  assert.equal((await service.request("/api/profiles", "GET", undefined, humanToken)).status, 401);
  assert.equal((await service.request(`/api/profiles/${profile.id}`, "DELETE", undefined, humanToken)).status, 401);
  assert.equal((await service.request(`/api/sessions/${session.id}/human-link`, "POST", {}, humanToken)).status, 401);
  assert.equal((await service.request(`/api/human/${session.id}/human-link`, "POST", {}, humanToken)).status, 405);
  const recovered = await (await service.request(`/api/sessions/${session.id}/human-link`, "POST", {})).json() as { humanUrl: string };
  assert.equal(recovered.humanUrl, session.humanUrl);
  await service.request(`/api/sessions/${session.id}/handoff`, "POST", { reason: "Login" });
  const before = service.registry.get(session.id).info();
  const renewed = await service.request(`/api/human/${session.id}/extend`, "POST", {}, humanToken);
  assert.equal(renewed.status, 200);
  const after = service.registry.get(session.id).info();
  assert.equal(after.control, "human");
  assert.equal(after.revision, before.revision);
  assert.ok(after.expiresAt >= before.expiresAt);
  assert.equal((await service.request(`/api/sessions/${session.id}/extend`, "POST", { seconds: -1 })).status, 400);
  assert.equal((await service.request(`/api/profiles/${profile.id}`, "DELETE")).status, 200);
});
