import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fakeWorkspace, startService } from "./helpers.js";

test("stdio MCP advertises tools and enforces the HTTP handoff contract", async (t) => {
  const service = await startService({
    create: async () => fakeWorkspace(),
    close: async () => {},
  });
  const transport = new StdioClientTransport({
    command: "npm",
    args: ["run", "--silent", "mcp"],
    env: {
      ...process.env,
      AGENT_BROWSER_TOKEN: service.token,
      AGENT_BROWSER_URL: service.base,
      AGENT_BROWSER_VIEW_URL: "http://localhost:50350",
    } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "browser-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await service.close();
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  assert.ok(tools.some(tool => tool.name === "browser_wait"));
  assert.ok(tools.some((tool) => tool.name === "browser_action"));
  const creation = await client.callTool({
    name: "browser_create",
    arguments: { purpose: "MCP test" },
  });
  const content = creation.content as { type: string; text: string }[];
  const session = JSON.parse(content[0].text) as {
    id: string;
    humanUrl: string;
  };
  assert.equal(new URL(session.humanUrl).origin, "http://localhost:50350");
  const action = {
    name: "browser_action",
    arguments: { sessionId: session.id, action: { type: "snapshot" } },
  };
  assert.notEqual((await client.callTool(action)).isError, true);
  assert.notEqual(
    (
      await client.callTool({
        name: "browser_handoff",
        arguments: { sessionId: session.id, reason: "Login" },
      })
    ).isError,
    true,
  );
  assert.equal((await client.callTool(action)).isError, true);
  for (const name of ["browser_extend", "browser_human_link"]) {
    const result = await client.callTool({ name, arguments: { sessionId: session.id } });
    assert.notEqual(result.isError, true);
  }
  assert.equal(service.registry.get(session.id).info().control, "human");
  const waitResult = await client.callTool({ name: "browser_wait", arguments: { sessionId: session.id, timeoutSeconds: 1 } });
  assert.equal(JSON.parse((waitResult.content as { text: string }[])[0].text).status, 'timed_out');
  const cancel = new AbortController();
  const cancelled = client.callTool({ name: "browser_wait", arguments: { sessionId: session.id, timeoutSeconds: 25 } }, undefined, { signal: cancel.signal });
  const rejection = assert.rejects(cancelled);
  await new Promise(resolve => setTimeout(resolve, 150)); cancel.abort(); await rejection;
  assert.equal(service.registry.get(session.id).info().control, 'human');
  const resumed = client.callTool({ name: "browser_wait", arguments: { sessionId: session.id, timeoutSeconds: 5 } });

  assert.notEqual((await client.callTool({ name: "browser_profiles", arguments: {} })).isError, true);
  const humanToken = new URL(session.humanUrl).hash.slice(1).split(".")[1];
  await service.request(
    `/api/human/${session.id}/resume`,
    "POST",
    {},
    humanToken,
  );
  assert.equal(JSON.parse(((await resumed).content as { text: string }[])[0].text).status, 'ready');
  assert.notEqual((await client.callTool(action)).isError, true);
  const screenshot = await client.callTool({
    name: "browser_screenshot",
    arguments: { sessionId: session.id },
  });
  assert.equal((screenshot.content as { type: string }[])[0].type, "image");
  assert.notEqual(
    (
      await client.callTool({
        name: "browser_close",
        arguments: { sessionId: session.id },
      })
    ).isError,
    true,
  );
});
