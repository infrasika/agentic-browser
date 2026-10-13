import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { fakeWorkspace, startService } from "./helpers.js";

test("local forwarding accepts loopback aliases and preserves the forwarded origin", async (t) => {
  const service = await startService({
    create: async () => fakeWorkspace(),
    close: async () => {},
  });
  t.after(() => service.close());
  const forwarded = (host: string, origin = `http://${host}`) =>
    new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${service.base}/api/sessions`,
          {
            method: "POST",
            headers: {
              Host: host,
              Origin: origin,
              Authorization: `Bearer ${service.token}`,
              "Content-Type": "application/json",
            },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve({ status: response.statusCode, body }),
            );
          },
        );
        request.on("error", reject);
        request.end("{}");
      },
    );
  for (const host of ["localhost:50350", "127.0.0.1:50350", "[::1]:50350"]) {
    const result = await forwarded(host);
    assert.equal(result.status, 201, result.body);
    assert.equal(
      new URL(JSON.parse(result.body).humanUrl).origin,
      `http://${host}`,
    );
  }
  for (const host of [
    "localhost.attacker.example:50350",
    "127.0.0.1.attacker.example",
    "localhost:99999",
  ]) {
    assert.equal((await forwarded(host)).status, 403);
  }
  assert.equal(
    (await forwarded("localhost:50350", "http://localhost:50351")).status,
    403,
  );
  assert.equal(
    (await forwarded("localhost:50350", "https://untrusted.example")).status,
    403,
  );
});

test("HTTP handoff separates agent and human capabilities", async (t) => {
  const service = await startService({
    create: async () => fakeWorkspace(),
    close: async () => {},
  });
  t.after(() => service.close());
  assert.equal(
    (await service.request("/api/sessions", "GET", undefined, "")).status,
    401,
  );
  const response = await service.request("/api/sessions", "POST", {
    purpose: "Login",
  });
  assert.equal(response.status, 201);
  const session = (await response.json()) as { id: string; humanUrl: string };
  const humanToken = new URL(session.humanUrl).hash.slice(1).split(".")[1];
  const agent = `/api/sessions/${session.id}`;
  const human = `/api/human/${session.id}`;
  assert.equal((await service.request(human)).status, 401);
  assert.equal(
    (
      await service.request(
        `${human}/actions`,
        "POST",
        { type: "snapshot" },
        humanToken,
      )
    ).status,
    409,
  );
  assert.equal(
    (await service.request(`${agent}/handoff`, "POST", { reason: "Login" }))
      .status,
    200,
  );
  assert.equal((await service.request(`${agent}/screen`)).status, 409);
  assert.equal(
    (
      await service.request(`${agent}/actions`, "POST", {
        type: "fill",
        selector: "#password",
        text: "blocked",
      })
    ).status,
    409,
  );
  assert.equal(
    (await service.request(`${agent}/resume`, "POST", {})).status,
    405,
  );
  assert.equal(
    (await service.request(`${human}/screen`, "GET", undefined, humanToken))
      .status,
    200,
  );
  assert.equal(
    (await service.request(`${human}/resume`, "POST", {}, humanToken)).status,
    200,
  );
  assert.equal(
    (await service.request(`${agent}/actions`, "POST", { type: "snapshot" }))
      .status,
    200,
  );
  assert.equal(
    (
      await service.request(
        `${human}/actions`,
        "POST",
        { type: "type", text: "late" },
        humanToken,
      )
    ).status,
    409,
  );
  const other = (await (
    await service.request("/api/sessions", "POST", {})
  ).json()) as { id: string };
  assert.equal(
    (
      await service.request(
        `/api/human/${other.id}`,
        "GET",
        undefined,
        humanToken,
      )
    ).status,
    401,
  );
  const listed = JSON.stringify(
    await (await service.request("/api/sessions")).json(),
  );
  assert.equal(listed.includes(humanToken), false);
});

test("invalid input, cross-origin access, and host rebinding are rejected", async (t) => {
  const service = await startService({
    create: async () => fakeWorkspace(),
    close: async () => {},
  });
  t.after(() => service.close());
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:secret@example.com",
  ]) {
    assert.equal(
      (await service.request("/api/sessions", "POST", { url })).status,
      400,
    );
  }
  assert.equal(
    (await service.request("/api/sessions", "POST", { unknown: true })).status,
    400,
  );
  assert.equal(
    (
      await service.request("/api/sessions", "POST", {
        purpose: "x".repeat(70000),
      })
    ).status,
    413,
  );
  const crossOrigin = await fetch(`${service.base}/api/sessions`, {
    headers: {
      Authorization: `Bearer ${service.token}`,
      Origin: "https://untrusted.example",
    },
  });
  assert.equal(crossOrigin.status, 403);
  // Node fetch normalizes Host, so use a raw request to exercise rebinding protection.
  const badHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const request = httpRequest(
        `${service.base}/health`,
        { headers: { Host: "untrusted.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    },
  );
  assert.equal(badHostStatus, 403);
});

test("browser errors do not echo entered credentials", async (t) => {
  const workspace = fakeWorkspace();
  workspace.perform = async () => {
    throw new Error("fill failed with private-password");
  };
  const service = await startService({
    create: async () => workspace,
    close: async () => {},
  });
  t.after(() => service.close());
  const session = (await (
    await service.request("/api/sessions", "POST", {})
  ).json()) as { id: string };
  const response = await service.request(
    `/api/sessions/${session.id}/actions`,
    "POST",
    { type: "fill", selector: "#password", text: "private-password" },
  );
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes("private-password"), false);
});
