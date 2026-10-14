import test from "node:test";
import assert from "node:assert/strict";
import { ChromiumEngine } from "../src/browser.js";
import { startService } from "./helpers.js";

test("real Chromium: agent → human login → agent continues in the same context", async (t) => {
  const service = await startService(new ChromiumEngine({ headless: true }));
  t.after(() => service.close());
  const created = await service.request("/api/sessions", "POST", {
    purpose: "Browser handoff test",
    url: `${service.base}/demo`,
  });
  assert.equal(created.status, 201);
  const session = (await created.json()) as { id: string; humanUrl: string };
  const agent = `/api/sessions/${session.id}`;
  const human = `/api/human/${session.id}`;
  const humanToken = new URL(session.humanUrl).hash.slice(1).split(".")[1];
  const act = async (path: string, action: unknown, token = service.token) => {
    const result = await service.request(
      `${path}/actions`,
      "POST",
      action,
      token,
    );
    assert.equal(result.status, 200, await result.clone().text());
    return result.json() as Promise<{ result: { text: string } }>;
  };
  assert.match(
    (await act(agent, { type: "snapshot" })).result.text,
    /Demo username/,
  );
  await service.request(`${agent}/handoff`, "POST", {
    reason: "Please log in",
  });
  assert.equal((await service.request(`${agent}/screen`)).status, 409);
  assert.equal(
    (await service.request(`${agent}/actions`, "POST", { type: "snapshot" }))
      .status,
    409,
  );
  await act(
    human,
    { type: "fill", selector: "#username", text: "demo-user" },
    humanToken,
  );
  await act(
    human,
    { type: "fill", selector: "#password", text: "fake-password" },
    humanToken,
  );
  await act(human, { type: "click", selector: "#login button" }, humanToken);
  assert.match(
    (await act(human, { type: "snapshot" }, humanToken)).result.text,
    /Signed in: demo-user/,
  );
  assert.equal(
    (await service.request(`${human}/resume`, "POST", {}, humanToken)).status,
    200,
  );
  await act(agent, { type: "reload" });
  await act(agent, { type: "click", selector: "#continue" });
  const final = await act(agent, { type: "snapshot" });
  assert.match(final.result.text, /Task complete/);
  assert.equal(JSON.stringify(final).includes("fake-password"), false);
  const screen = await service.request(`${agent}/screen`);
  assert.equal(screen.headers.get("content-type"), "image/jpeg");
  assert.ok((await screen.arrayBuffer()).byteLength > 1000);
  const second = (await (
    await service.request("/api/sessions", "POST", {
      url: `${service.base}/demo`,
    })
  ).json()) as { id: string };
  const clean = await act(`/api/sessions/${second.id}`, { type: "snapshot" });
  assert.doesNotMatch(clean.result.text, /Signed in: demo-user/);
  await service.request(agent, "DELETE");
  assert.equal(
    (await service.request(`${human}/screen`, "GET", undefined, humanToken))
      .status,
    404,
  );
});
