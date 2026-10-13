import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { actionSchema, webUrl } from "./contracts.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const token = process.env.AGENT_BROWSER_TOKEN;
const base =
  process.env.AGENT_BROWSER_URL ??
  process.env.PUBLIC_URL ??
  "http://127.0.0.1:3333";
const viewOrigin = process.env.AGENT_BROWSER_VIEW_URL;
try {
  for (const value of [base, viewOrigin].filter(Boolean)) {
    const url = new URL(value!);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid origin');
  }
} catch { console.error('AGENT_BROWSER_URL and AGENT_BROWSER_VIEW_URL must be HTTP(S) origins without credentials or paths.'); process.exit(1); }
if (!token || token.length < 32) {
  console.error("Set AGENT_BROWSER_TOKEN before starting the MCP adapter.");
  process.exit(1);
}
const server = new McpServer({ name: "agentic-browser", version: "0.1.0" });
const sessionId = z
  .string()
  .uuid()
  .describe("Session ID returned by browser_create");

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
async function request(path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
  const response = await fetch(new URL(path, base), {
    method,
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json()) as { message?: string; error?: string };
    throw new ApiError(
      response.status, payload.error ?? 'service_error', payload.message ?? `Browser service returned ${response.status}`,
    );
  }
  return response;
}

function output(value: unknown) {
  if (viewOrigin && value && typeof value === 'object' && 'humanUrl' in value && typeof value.humanUrl === 'string') {
    const url = new URL(value.humanUrl);
    value = { ...value, humanUrl: `${new URL(viewOrigin).origin}${url.pathname}${url.hash}` };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function safely(
  work: () => Promise<
    | ReturnType<typeof output>
    | { content: { type: "image"; data: string; mimeType: string }[] }
  >,
) {
  try {
    return await work();
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            error instanceof ApiError ? JSON.stringify({ error: error.code, status: error.status, message: error.message }) : error instanceof Error
              ? error.message
              : "Browser service unavailable",
        },
      ],
    };
  }
}

server.registerTool(
  "browser_create",
  {
    description:
      "Create a browser session for one continuous task. Team deployments use a private container and bind it to this credential. Give humanUrl to the member for login/manual interaction; it requires their separate service login. Never request passwords in chat.",
    inputSchema: {
      purpose: z.string().min(1).max(300),
      url: webUrl.optional(),
      profileId: z.string().uuid().optional().describe("Reuse a saved profile only when the user has opted in; omit for a temporary session."),
    },
  },
  (args) =>
    safely(async () =>
      output(await (await request("/api/sessions", "POST", args)).json()),
    ),
);

server.registerTool(
  "browser_sessions",
  {
    description:
      "List browser sessions and their control states. Human control means the agent must wait.",
    inputSchema: {},
  },
  () =>
    safely(async () => output(await (await request("/api/sessions")).json())),
);

server.registerTool(
  "browser_status",
  {
    description:
      "Check whether the user returned control. Continue actions only when control is agent.",
    inputSchema: { sessionId },
  },
  (args) =>
    safely(async () =>
      output(await (await request(`/api/sessions/${args.sessionId}`)).json()),
    ),
);

server.registerTool(
  "browser_action",
  {
    description:
      "Operate the browser using navigate, snapshot, click/fill (Playwright selectors), pointer, type, press, scroll, back/forward/reload, tabs or selectTab. No actions or observations are allowed during human control.",
    inputSchema: { sessionId, action: actionSchema },
  },
  (args) =>
    safely(async () =>
      output(
        await (
          await request(
            `/api/sessions/${args.sessionId}/actions`,
            "POST",
            args.action,
          )
        ).json(),
      ),
    ),
);

server.registerTool(
  "browser_screenshot",
  {
    description:
      "View the active tab. Password inputs are masked. Unavailable during human control.",
    inputSchema: { sessionId },
  },
  (args) =>
    safely(async () => ({
      content: [
        {
          type: "image" as const,
          data: Buffer.from(
            await (
              await request(`/api/sessions/${args.sessionId}/screen`)
            ).arrayBuffer(),
          ).toString("base64"),
          mimeType: "image/jpeg",
        },
      ],
    })),
);

server.registerTool(
  "browser_handoff",
  {
    description:
      "Pause all agent actions and observations and give control to the user. Share the humanUrl from browser_create and wait until browser_status reports agent. Only the user can return control.",
    inputSchema: { sessionId, reason: z.string().min(1).max(500) },
  },
  (args) =>
    safely(async () =>
      output(
        await (
          await request(`/api/sessions/${args.sessionId}/handoff`, "POST", {
            reason: args.reason,
          })
        ).json(),
      ),
    ),
);

server.registerTool(
  'browser_wait',
  {
    description: 'Wait up to 25 seconds for the requested control state, optionally after a known revision. Returns ready or timed_out. Cancelling this tool only cancels waiting; it does not close the browser or return human control. Never replay page submissions after a timeout.',
    inputSchema: { sessionId, control: z.enum(['agent', 'human']).default('agent'), afterRevision: z.number().int().nonnegative().optional(), timeoutSeconds: z.number().int().min(1).max(25).default(20) },
  },
  (args, extra) => safely(async () => output(await (await request(`/api/sessions/${args.sessionId}/wait`, 'POST', { control: args.control, afterRevision: args.afterRevision, timeoutMs: args.timeoutSeconds * 1000 }, extra.signal)).json())),
);

server.registerTool(
  "browser_profiles",
  { description: "List login profiles explicitly granted to this Agent credential. An empty list means use a temporary session or ask the member to grant a profile in the service UI.", inputSchema: {} },
  () => safely(async () => output(await (await request("/api/profiles")).json())),
);

server.registerTool(
  "browser_extend",
  { description: "Renew a live session for its configured duration from now. Does not change control or revive ended sessions.", inputSchema: { sessionId } },
  (args) => safely(async () => output(await (await request(`/api/sessions/${args.sessionId}/extend`, "POST", {})).json())),
);

server.registerTool(
  "browser_human_link",
  { description: "Recover the current handoff link after a viewer disconnects. Does not change browser control.", inputSchema: { sessionId } },
  (args) => safely(async () => output(await (await request(`/api/sessions/${args.sessionId}/human-link`, "POST", {})).json())),
);

server.registerTool(
  "browser_close",
  {
    description:
      "End the browser session. Temporary login state is discarded; explicitly saved profiles remain available.",
    inputSchema: { sessionId },
  },
  (args) =>
    safely(async () =>
      output(
        await (
          await request(`/api/sessions/${args.sessionId}`, "DELETE")
        ).json(),
      ),
    ),
);

await server.connect(new StdioServerTransport());
