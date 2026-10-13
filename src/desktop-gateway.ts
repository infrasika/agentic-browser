import type { MirrorGrants } from "./mirror-grants.js";
import type { IdentityStore } from "./identity.js";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { requestOrigin } from "./http-origin.js";
import { sameToken, type SessionRegistry } from "./sessions.js";

export function attachDesktopGateway(
  server: Server,
  registry: SessionRegistry,
  options: { publicUrl: string; identity?: IdentityStore; mirrorGrants?: MirrorGrants },
) {
  const inputOwners = new Map<string, WebSocket>();
  const validators = new Map<WebSocket, () => void>();
  const revalidate = () => { for (const validate of validators.values()) validate(); };
  options.identity?.on("revoked", revalidate);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    try {
      const origin = requestOrigin(request, options.publicUrl);
      // Browsers always supply Origin for WebSocket handshakes.
      if (request.headers.origin !== origin || wss.clients.size >= 64)
        throw new Error("rejected");
      const url = new URL(request.url ?? "/", origin);
      const match = /^\/api\/human\/([a-f0-9-]{36})\/desktop$/.exec(
        url.pathname,
      );
      if (!match || url.search) throw new Error("rejected");
      const principal = options.identity?.request(request, true);
      const session = registry.get(match[1], principal?.ownerId);
      wss.handleUpgrade(request, socket, head, (ws) => {
        let native: Duplex | undefined;
        let authenticated = false;
        let authenticating = false;
        const timer = setTimeout(() => ws.terminate(), 5000).unref();
        let expiry: NodeJS.Timeout;
        const checkExpiry = () => {
          try { session.assertAlive(); if (principal) options.identity!.assertCurrent(principal); }
          catch { ws.terminate(); return; }
          expiry = setTimeout(checkExpiry, Math.max(1, Math.min(principal ? 1000 : Infinity, session.expiresAt - Date.now()))).unref();
        };
        checkExpiry();
        if (principal) validators.set(ws, () => {
          try { options.identity!.assertCurrent(principal); } catch { ws.terminate(); }
        });
        const stop = () => {
          validators.delete(ws);
          if (inputOwners.get(session.id) === ws) inputOwners.delete(session.id);
          clearTimeout(timer);
          clearTimeout(expiry);
          native?.destroy();
        };
        ws.on("error", () => ws.terminate());
        ws.on("close", stop);
        ws.on("message", async (data, binary) => {
          if (authenticated) {
            try { session.assertAlive(); if (principal) options.identity!.assertCurrent(principal); }
            catch { ws.terminate(); return; }
            if (!binary || session.info().control !== "human") {
              ws.terminate();
              return;
            }
            if (!native?.write(data as Buffer)) {
              ws.pause();
              native?.once("drain", () => ws.resume());
            }
            return;
          }
          if (authenticating || binary) {
            ws.terminate();
            return;
          }
          authenticating = true;
          try {
            // Bearer token stays out of URLs, access logs and VNC frames.
            const auth = JSON.parse(data.toString());
            if (principal) options.identity!.assertCurrent(principal);
            const current = session.info();
            if (
              (!principal && (typeof auth.token !== "string" || !sameToken(auth.token, session.humanToken))) ||
              auth.revision !== current.revision ||
              current.transport !== "desktop"
            )
              throw new Error("rejected");
            if (principal) {
              if (!options.mirrorGrants) throw new Error("No mirror grant provider");
              options.mirrorGrants.consume(auth.ticket, session.id, current.revision, principal);
              if (inputOwners.has(session.id)) { stop(); ws.close(4409, 'Desktop input already in use'); return; }
              inputOwners.set(session.id, ws);
            }
            await session.run("human", async (workspace) => {
              if (principal) options.identity!.assertCurrent(principal);
              if (!workspace.openDesktop) throw new Error("unsupported");
              native = workspace.openDesktop();
              native.pause();
              native.on("close", () => ws.terminate());
              native.on("error", () => ws.terminate());
            });
            if (ws.readyState !== WebSocket.OPEN) {
              stop();
              return;
            }
            authenticated = true;
            clearTimeout(timer);
            native!.on("data", (chunk) => {
              try { if (principal) options.identity!.assertCurrent(principal); } catch { ws.terminate(); return; }
              if (
                ws.readyState !== WebSocket.OPEN ||
                ws.bufferedAmount > 4 * 1024 * 1024
              ) {
                ws.terminate();
                return;
              }
              ws.send(chunk, { binary: true });
            });
            // Ordering is significant: the client attaches noVNC before RFB bytes arrive.
            ws.send("ready", () => native?.resume());
          } catch {
            stop();
            ws.close(1008, "Desktop session unavailable");
          }
        });
      });
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("close", () => {
    options.identity?.off("revoked", revalidate);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
}
