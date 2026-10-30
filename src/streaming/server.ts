import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { BrowserService } from '../scheduling/service.js';
import type { ViewerGrant, ViewerGrants } from './grants.js';

export function createDataServer(service: BrowserService, grants: ViewerGrants, publicUrl: string) {
  service.setMaxListeners(100);
  const origin = new URL(publicUrl).origin;
  const server = createServer((request, response) => {
    const healthy = request.url === '/health' && request.method === 'GET';
    response.writeHead(healthy ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(healthy ? { status: 'ok' } : { error: 'not_found' }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    const match = /^\/browser\/v1\/(observe|input)$/.exec(request.url ?? '');
    if (!match || request.headers.origin !== origin || wss.clients.size >= 80) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const role = match[1] as 'observe' | 'input';
    wss.handleUpgrade(request, socket, head, ws => {
      let grant: ViewerGrant | undefined;
      let desktop: Duplex | undefined;
      let busy = false;
      let authenticating = false;
      const close = () => { desktop?.destroy(); if (ws.readyState !== WebSocket.CLOSED) ws.close(1008, 'Browser access changed'); };
      const validate = () => {
        if (!grant) return;
        try { service.validateViewer(grant.leaseId, grant, grant.revision, grant.role); }
        catch { close(); }
      };
      const revoke = (userId: string) => { if (grant?.userId === userId) close(); };
      const authenticationTimer = setTimeout(close, 5000).unref();
      const validationTimer = setInterval(validate, 250).unref();
      service.on('changed', validate); service.on('revokeUser', revoke);
      const frameTimer = role === 'observe' ? setInterval(() => {
        if (!grant || busy || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 2 * 1024 * 1024) { close(); return; }
        busy = true;
        void service.frame(grant.leaseId, grant, grant.revision)
          .then(frame => { if (ws.readyState === WebSocket.OPEN) ws.send(frame); })
          .catch(close).finally(() => { busy = false; });
      }, 750).unref() : undefined;
      ws.on('message', (data, isBinary) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!grant) {
          if (authenticating || isBinary || bytes.length > 512) { close(); return; }
          authenticating = true;
          void (async () => {
            try {
              const body = z.object({ grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(JSON.parse(bytes.toString()));
              grant = grants.consume(body.grant, role);
              service.validateViewer(grant.leaseId, grant, grant.revision, role);
              if (role === 'input') {
                desktop = await service.desktop(grant.leaseId, grant, grant.revision);
                if (ws.readyState !== WebSocket.OPEN) { desktop.destroy(); return; }
                desktop.on('data', chunk => {
                  if (ws.bufferedAmount > 2 * 1024 * 1024) { close(); return; }
                  if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
                });
                desktop.on('close', close); desktop.on('error', close);
              }
              clearTimeout(authenticationTimer);
            } catch { close(); }
          })();
          return;
        }
        if (role !== 'input' || !isBinary || !desktop || desktop.writableLength > 1024 * 1024) { close(); return; }
        validate();
        if (ws.readyState === WebSocket.OPEN) desktop.write(bytes);
      });
      ws.on('error', close);
      ws.on('close', () => {
        clearTimeout(authenticationTimer); clearInterval(validationTimer); clearInterval(frameTimer);
        service.off('changed', validate); service.off('revokeUser', revoke); desktop?.destroy();
      });
    });
  });
  return Object.assign(server, { closeViewers() { for (const ws of wss.clients) ws.terminate(); wss.close(); } });
}
