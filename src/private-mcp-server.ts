import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { request as httpRequest } from 'node:http';
import { z } from "zod";
import { actionSchema, webUrl } from "./contracts.js";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
async function localApiRequest(url: URL, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal): Promise<Response> {
  // Native fetch ignores a custom Host in this runtime. The internal adapter
  // must preserve the validated external Host while connecting only to loopback.
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers, signal }, async response => {
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) { response.destroy(); throw new Error('Response exceeds limit'); }
          chunks.push(chunk);
        }
        resolve(new Response(response.statusCode === 204 ? null : new Uint8Array(Buffer.concat(chunks)), { status: response.statusCode }));
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
    request.end(body);
  });
}
export function apiRequester(base: string, token: string, host?: string, connectionSignal?: AbortSignal) {
  return async function request(path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
    const init = {
      method,
      redirect: "error" as const,
      signal: AbortSignal.any([AbortSignal.timeout(30000), ...[signal, connectionSignal].filter((s): s is AbortSignal => !!s)]),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(host ? { Host: host } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const url = new URL(path, base);
    const response = host ? await localApiRequest(url, method, init.headers, init.body, init.signal) : await fetch(url, init);
    if (!response.ok) {
      const payload = (await response.json()) as { message?: string; error?: string };
      throw new ApiError(
        response.status, payload.error ?? 'service_error', payload.message ?? `Browser service returned ${response.status}`,
      );
    }
    return response;
  }

}

export function createPrivateMcpServer(request: ReturnType<typeof apiRequester>, viewOrigin?: string) {
  const server = new McpServer({ name: "agentic-browser", version: "0.1.0" }, {
      instructions: 'Private browser workspace. Send the actual humanUrl to the user for manual work; never request passwords in chat. After browser_handoff, wait for handback before observing or acting. Close temporary sessions when done.',
    });
  const sessionId = z
    .string()
    .uuid()
    .describe("Session ID returned by browser_create");

  function output(value: unknown) {
    if (viewOrigin && value && typeof value === 'object' && 'humanUrl' in value && typeof value.humanUrl === 'string') {
      const url = new URL(value.humanUrl);
      value = { ...value, humanUrl: `${new URL(viewOrigin).origin}${url.pathname}${url.hash}` };
    }
    const content = [{ type: "text" as const, text: JSON.stringify(value) }];
    if (value && typeof value === 'object' && 'humanUrl' in value && typeof value.humanUrl === 'string')
      content.push({ type: 'text', text: `Send this link to the current user now: [Open browser](${value.humanUrl})\n${value.humanUrl}\nSign in to the workspace as the owning member, complete the manual steps, then click Hand back to Agent. Preserve the complete URL.` });
    return { content };
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
        "Pause agent actions and observations. Send the returned humanUrl to the user, then wait until control is agent. Only the user can return control.",
      inputSchema: { sessionId, reason: z.string().min(1).max(500) },
    },
    (args) =>
      safely(async () => {
        const state = await (await request(`/api/sessions/${args.sessionId}/handoff`, "POST", { reason: args.reason })).json();
        const link = await (await request(`/api/sessions/${args.sessionId}/human-link`, "POST", {})).json();
        return output({ ...state, ...link });
      }),
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

  return server;
}
