import { z } from "zod";
import { profileName } from "./profiles.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { ZodError } from "zod";
import {
  actionSchema,
  createSessionSchema,
  handoffSchema,
  ServiceError,
  type Actor,
} from "./contracts.js";
import { sameToken, SessionRegistry } from "./sessions.js";
import { requestOrigin } from "./http-origin.js";
import { MirrorGrants } from "./mirror-grants.js";
import { PublicDemo } from "./public-demo.js";
import { waitForSession } from "./session-wait.js";
import type { IdentityStore, Principal } from "./identity.js";
import { checkBrowserRequest, teamAuthRoute } from "./team-http.js";
import { attachDesktopGateway } from "./desktop-gateway.js";
import { RemoteMcp } from "./remote-mcp.js";
import { PrivateMcp } from "./private-mcp.js";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/public-demo.js", ["public-demo.js", "text/javascript; charset=utf-8"]],
  ["/public-browser.js", ["public-browser.js", "text/javascript; charset=utf-8"]],
  ["/self-host", ["self-host.html", "text/html; charset=utf-8"]],
  ["/install.sh", ["self-host-downloads/install.sh", "text/plain; charset=utf-8"]],
  ["/self-host/download/workspace-backup.sh", ["self-host-downloads/workspace-backup.sh", "text/plain; charset=utf-8"]],
  ["/self-host/download/SELF_HOST.md", ["self-host-downloads/SELF_HOST.md", "text/plain; charset=utf-8"]],
  ["/self-host/download/AGENT_CLIENT.md", ["self-host-downloads/AGENT_CLIENT.md", "text/plain; charset=utf-8"]],
  ["/self-host/download/agentic-browser-self-host.tar.gz", ["self-host-downloads/agentic-browser-self-host.tar.gz", "application/gzip"]],
  ["/self-host/download/SHA256SUMS", ["self-host-downloads/SHA256SUMS", "text/plain; charset=utf-8"]],
  ["/connect", ["connect.html", "text/html; charset=utf-8"]],
  ["/connect.js", ["connect.js", "text/javascript; charset=utf-8"]],
  ["/login", ["login.html", "text/html; charset=utf-8"]],
  ["/login.js", ["login.js", "text/javascript; charset=utf-8"]],
  ["/team-client.js", ["team-client.js", "text/javascript; charset=utf-8"]],
  ["/view", ["viewer.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ["/viewer.js", ["viewer.js", "text/javascript; charset=utf-8"]],
  ["/demo", ["demo.html", "text/html; charset=utf-8"]],
  ["/demo.js", ["demo.js", "text/javascript; charset=utf-8"]],
]);

async function readJson(request: IncomingMessage) {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new ServiceError(
      415,
      "json_required",
      "Use Content-Type: application/json",
    );
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 65536) chunks.push(chunk);
  }
  if (size > 65536)
    throw new ServiceError(
      413,
      "body_too_large",
      "Request body exceeds 64 KiB",
    );
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new ServiceError(400, "invalid_json", "Invalid JSON body");
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function bearer(request: IncomingMessage) {
  return (
    /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "")?.[1] ?? ""
  );
}

export function createHttpServer(
  registry: SessionRegistry,
  options: { token?: string; publicUrl: string; identity?: IdentityStore; defaultStartUrl?: string; demo?: boolean; publicBrowser?: boolean; publicMaxSessionsPerIp?: number; trustProxy?: boolean },
) {
  const publicDemo = options.demo && options.identity ? new PublicDemo(options.identity, registry) : undefined;
  const guestMode = options.demo || options.publicBrowser;
  const privateMcp = options.identity && !guestMode ? new PrivateMcp(options.identity) : undefined;
  const remoteMcp = options.publicBrowser && options.identity ? new RemoteMcp(registry, options.identity, { maxSessionsPerIp: options.publicMaxSessionsPerIp, trustProxy: options.trustProxy }) : undefined;
  const remoteReaper = remoteMcp ? setInterval(() => { void remoteMcp.reap().catch(() => {}); }, 5000).unref() : undefined;
  const mirrorGrants = options.identity ? new MirrorGrants() : undefined;
  const pendingWaits = new Map<string, number>();
  const server = createServer(async (request, response) => {
    let principal: Principal | undefined;
    let resourceGuard: (() => void) | undefined;
    const authorize = () => { if (principal) options.identity!.assertCurrent(principal); resourceGuard?.(); };
    const readBody = async (request: IncomingMessage) => { const body = await readJson(request); authorize(); return body; };
    const respond = (response: ServerResponse, status: number, body: unknown) => {
      if (status < 400 && principal) options.identity!.assertCurrent(principal);
      return json(response, status, body);
    };
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const origin = requestOrigin(request, options.publicUrl);
      const url = new URL(request.url ?? "/", origin);
      const method = request.method;
      if (privateMcp && url.pathname === '/mcp') {
        if (url.search) throw new ServiceError(400, 'invalid_request', 'MCP credentials must not be placed in URLs.');
        const address = server.address();
        if (!address || typeof address === 'string') throw new ServiceError(503, 'not_ready', 'The service is not ready.');
        const host = address.family === 'IPv6' ? '[::1]' : '127.0.0.1';
        return await privateMcp.handle(request, response, origin, `http://${host}:${address.port}`);
      }
      if (remoteMcp && url.pathname === '/mcp') {
        if (url.search) throw new ServiceError(400, 'invalid_request', 'MCP credentials must not be placed in URLs.');
        return await remoteMcp.handle(request, response, origin);
      }
      if (remoteMcp && url.pathname === '/api/public/claim' && method === 'POST') {
        checkBrowserRequest(request, origin);
        const { sessionId, ticket } = z.object({ sessionId: z.string().uuid(), ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(await readJson(request));
        return respond(response, 200, await remoteMcp.claim(sessionId, ticket, origin, response));
      }
      if (method === "GET" && url.pathname === "/health")
        return respond(response, 200, { status: "ok" });
      if (remoteMcp && method === 'GET' && url.pathname === '/api/public/capacity')
        return respond(response, 200, registry.capacity());
      if (method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const vendor =
        /^\/vendor\/novnc\/((?:core|vendor)\/[A-Za-z0-9_./-]+\.js)$/.exec(
          url.pathname,
        );
      if (method === "GET" && vendor && !vendor[1].split("/").includes("..")) {
        try {
          const body = await readFile(
            new URL(
              `../node_modules/@novnc/novnc/${vendor[1]}`,
              import.meta.url,
            ),
          );
          response.writeHead(200, {
            "Content-Type": "text/javascript; charset=utf-8",
          });
          response.end(body);
          return;
        } catch {
          throw new ServiceError(404, "not_found", "Asset not found");
        }
      }
      const asset = guestMode && ["/", "/login"].includes(url.pathname) ? [options.publicBrowser ? "public-browser.html" : "public-demo.html", "text/html; charset=utf-8"] : assets.get(url.pathname);
      if (method === "GET" && asset) {
        const body = await readFile(
          new URL(`../web/${asset[0]}`, import.meta.url),
        );
        response.writeHead(200, { "Content-Type": asset[1] });
        response.end(body);
        return;
      }
      if (url.pathname === "/api/auth/config" && method === "GET")
        return respond(response, 200, { mode: options.publicBrowser ? "public" : options.demo ? "demo" : options.identity ? "team" : "legacy", defaultStartUrl: options.defaultStartUrl ?? `${origin}/demo`, ...(options.publicBrowser ? { mcpUrl: `${origin}/mcp` } : {}) });
      if (publicDemo && url.pathname === '/api/demo/start' && method === 'POST') {
        checkBrowserRequest(request, origin);
        z.object({}).strict().parse(await readJson(request));
        return respond(response, 201, await publicDemo.start(request, response, origin));
      }
      if (guestMode && (url.pathname === '/api/auth/login' || url.pathname.startsWith('/api/credentials')))
        throw new ServiceError(403, 'demo_restricted', 'The public demo does not provide member login or Agent credentials.');
      if (options.identity) {
        const result = await teamAuthRoute(options.identity, request, response, url.pathname, origin, readJson, registry.profiles);
        if (result !== undefined) return respond(response, 200, result);
      }
      const isHuman = url.pathname.startsWith("/api/human/");
      const token = bearer(request);
      if (options.identity) {
        principal = options.identity.request(request, isHuman);
        if (guestMode && !principal.guest) throw new ServiceError(403, "demo_restricted", "Only temporary guests can use the demo.");
        if (principal.kind === "human" && method !== "GET") checkBrowserRequest(request, origin);
      }
      const ownerId = principal?.ownerId;
      const agentHash = principal?.kind === "agent" ? principal.credentialHash : undefined;
      const humanUrl = (id: string, humanToken: string) => options.identity ? `${origin}/view#${id}` : `${origin}/view#${id}.${humanToken}`;
      if (!options.identity && !isHuman && (!options.token || !sameToken(token, options.token))) {
        throw new ServiceError(
          401,
          "unauthorized",
          "A valid agent bearer token is required",
        );
      }
      if (guestMode && url.pathname.startsWith('/api/profiles')) {
        if (method === 'GET' && url.pathname === '/api/profiles') return respond(response, 200, { available: false, profiles: [] });
        throw new ServiceError(403, 'demo_restricted', 'The public demo does not save or reuse login profiles.');
      }
      if (url.pathname === "/api/profiles") {
        if (method === "GET") return respond(response, 200, {
          available: !!registry.profiles,
          profiles: (await registry.profiles?.list(ownerId) ?? []).filter(profile => !agentHash || principal!.profileIds!.includes(profile.id)),
        });
        if (method === "POST") {
          if (agentHash) throw new ServiceError(403, "human_required", "The member must create saved profiles from their own account.");
          if (!registry.profiles) throw new ServiceError(400, "profiles_unavailable", "Saving login state requires desktop mode.");
          const { name } = z.object({ name: profileName }).strict().parse(await readBody(request));
          return respond(response, 201, await registry.profiles.create(name, ownerId));
        }
      }
      const profileMatch = /^\/api\/profiles\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (profileMatch && method === "DELETE") {
        if (agentHash) throw new ServiceError(403, "human_required", "The member must delete saved profiles from their own account.");
        if (!registry.profiles) throw new ServiceError(400, "profiles_unavailable", "Saving login state requires desktop mode.");
        await registry.profiles.remove(profileMatch[1], ownerId);
        return respond(response, 200, { id: profileMatch[1], deleted: true });
      }
      if (url.pathname === "/api/sessions") {
        if (method === "GET")
          return respond(response, 200, { sessions: registry.list(ownerId, agentHash) });
        if (method === "POST") {
          if (guestMode) throw new ServiceError(403, "demo_restricted", "Create a session through the entry point provided by this demo mode.");
          const body = createSessionSchema.parse(await readBody(request));
          if (agentHash && body.profileId && !principal!.profileIds!.includes(body.profileId)) throw new ServiceError(404, "profile_not_found", "The login profile does not exist or is not authorized.");
          const session = await registry.create(body.purpose, body.profileId, ownerId, agentHash);
          try {
            if (principal) options.identity!.assertCurrent(principal);
            if (body.url)
              await session.run("agent", (workspace) => { authorize(); return workspace.perform({ type: "navigate", url: body.url! }); });
            if (principal?.kind === "human") await session.transfer("human", "", authorize);
          } catch (error) {
            await registry.remove(session.id, ownerId);
            throw error;
          }
          return respond(response, 201, {
            ...session.info(),
            humanUrl: humanUrl(session.id, session.humanToken),
          });
        }
      }
      const match =
        /^\/api\/(sessions|human)\/([a-f0-9-]{36})(?:\/(actions|screen|handoff|takeover|resume|extend|human-link|desktop-grant|bind-agent|wait))?$/.exec(
          url.pathname,
        );
      if (!match)
        throw new ServiceError(404, "not_found", "Endpoint not found");
      const [, scope, id, operation] = match;
      const session = registry.get(id, ownerId, agentHash);
      resourceGuard = () => { registry.get(id, ownerId, agentHash); };
      const actor: Actor = scope === "human" ? "human" : "agent";
      if (!options.identity && actor === "human" && !sameToken(token, session.humanToken)) {
        throw new ServiceError(
          401,
          "unauthorized",
          "A valid human session token is required",
        );
      }
      if (method === 'POST' && operation === 'wait' && actor === 'agent') {
        const args = z.object({ control: z.enum(['agent', 'human']).default('agent'), timeoutMs: z.number().int().min(1).max(25000).default(20000), afterRevision: z.number().int().nonnegative().optional() }).strict().parse(await readBody(request));
        const key = principal?.credentialHash ?? 'legacy';
        if ((pendingWaits.get(key) ?? 0) >= 2 || [...pendingWaits.values()].reduce((a, b) => a + b, 0) >= 64)
          throw new ServiceError(429, 'wait_limit', 'A wait request is already pending. Cancel it or wait for it to finish.');
        pendingWaits.set(key, (pendingWaits.get(key) ?? 0) + 1);
        const cancel = new AbortController();
        const disconnected = () => { if (!response.writableEnded) cancel.abort(); };
        response.once('close', disconnected);
        try {
          const result = await waitForSession(session, { ...args, signal: cancel.signal }, () => {
            if (principal) options.identity!.assertCurrent(principal);
            registry.get(id, ownerId, agentHash);
          });
          return respond(response, 200, result);
        } finally {
          response.off('close', disconnected);
          const count = (pendingWaits.get(key) ?? 1) - 1;
          if (count) pendingWaits.set(key, count); else pendingWaits.delete(key);
        }
      }
      if (method === "POST" && operation === "bind-agent" && actor === "human" && principal) {
        const { credentialId } = z.object({ credentialId: z.string().uuid() }).strict().parse(await readBody(request));
        const binding = options.identity!.agentHash(principal, credentialId);
        await session.transfer("human", "Agent connected. Hand back control when you have finished.", authorize);
        options.identity!.assertCurrent(principal);
        session.agentCredentialHash = binding;
        return respond(response, 200, session.info());
      }
      if (principal?.kind === "human" && actor === "agent" && ["actions", "screen"].includes(operation))
        throw new ServiceError(403, "human_route_required", "Take control from the handoff page first.");
      if (method === "POST" && operation === "desktop-grant" && actor === "human" && principal && mirrorGrants) {
        z.object({}).strict().parse(await readBody(request));
        const current = session.info();
        if (current.control !== "human" || current.transport !== "desktop")
          throw new ServiceError(409, "control_unavailable", "Take control of the remote desktop first.");
        return respond(response, 200, mirrorGrants.issue(id, current.revision, principal));
      }
      if (method === "POST" && operation === "extend") {
        z.object({}).strict().parse(await readBody(request));
        return respond(response, 200, session.extend());
      }
      if (method === "POST" && actor === "agent" && operation === "human-link") {
        z.object({}).strict().parse(await readBody(request));
        return respond(response, 200, { humanUrl: humanUrl(session.id, session.humanToken) });
      }
      if (method === "GET" && !operation)
        return respond(response, 200, session.info());
      if (method === "DELETE" && !operation) {
        await registry.remove(id, ownerId);
        return respond(response, 200, { id, control: "closed" });
      }
      if (method === "GET" && operation === "screen") {
        const screen = await session.run(actor, (workspace) =>
          (authorize(), workspace.screenshot(actor === "agent")),
        );
        if (principal) options.identity!.assertCurrent(principal);
        response.writeHead(200, { "Content-Type": "image/jpeg" });
        response.end(screen);
        return;
      }
      if (method === "POST" && operation === "actions") {
        const action = actionSchema.parse(await readBody(request));
        return respond(response, 200, {
          result: await session.run(actor, (workspace) =>
            (authorize(), workspace.perform(action)),
          ),
        });
      }
      if (
        method === "POST" &&
        ((actor === "agent" && operation === "handoff") ||
          (actor === "human" && operation === "takeover"))
      ) {
        const { reason } = handoffSchema.parse(await readBody(request));
        return respond(response, 200, await session.transfer("human", reason, authorize));
      }
      if (method === "POST" && actor === "human" && operation === "resume") {
        await readBody(request);
        const resumed = await session.transfer("agent", "", authorize);
        return respond(response, 200, publicDemo ? await publicDemo.complete(session, authorize) : resumed);
      }
      throw new ServiceError(
        405,
        "method_not_allowed",
        "This operation is not available to this actor",
      );
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof ServiceError)
        return respond(response, error.status, {
          error: error.code,
          message: error.message,
        });
      if (error instanceof ZodError)
        return respond(response, 400, {
          error: "invalid_request",
          message: "Request fields do not match the API schema",
        });
      // Playwright errors may embed text supplied to fill(); never echo or log them.
      respond(response, 502, {
        error: "browser_operation_failed",
        message:
          "Browser operation failed or timed out; check the page and try again",
      });
    }
  });
  attachDesktopGateway(server, registry, { ...options, mirrorGrants });
  server.once('close', () => { clearInterval(remoteReaper); void remoteMcp?.close(); void privateMcp?.close(); });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return Object.assign(server, { async closeRemoteMcp() { clearInterval(remoteReaper); await remoteMcp?.close(); await privateMcp?.close(); } });
}
