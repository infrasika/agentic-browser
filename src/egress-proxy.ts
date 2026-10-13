// One small proxy sidecar per Runtime. Its only listener is a private Unix
// socket. The browser container has no network interface except loopback.
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { resolvePublicTarget } from './egress-policy.js';
const denyHosts: string[] = JSON.parse(process.env.AGENTIC_DENY_HOSTS ?? '[]');
const targetFor = (url: URL) => resolvePublicTarget(url, undefined, denyHosts);

function headers(request: IncomingMessage) {
  const result = { ...request.headers };
  for (const name of ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...(request.headers.connection ?? '').split(',').map(s => s.trim().toLowerCase())]) delete result[name];
  return result;
}
const clients = new Set<Socket>();
const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
  try {
    const url = new URL(request.url!);
    if (url.protocol !== 'http:') throw new Error('Use CONNECT for TLS');
    const target = await targetFor(url);
    const upstream = httpRequest({ hostname: target.address, family: target.family, port: target.port, method: request.method, path: url.pathname + url.search, headers: { ...headers(request), host: url.host }, timeout: 30000 }, remote => {
      response.writeHead(remote.statusCode ?? 502, remote.headers); remote.pipe(response);
      remote.on('error', () => response.destroy());
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => upstream.destroy()); request.on('error', () => upstream.destroy());
    request.pipe(upstream);
  } catch { response.writeHead(403); response.end('Network target is not allowed'); }
});
server.maxConnections = 64; server.requestTimeout = 30000; server.headersTimeout = 10000;
server.on('connection', socket => { clients.add(socket); socket.on('close', () => clients.delete(socket)); socket.setTimeout(300000, () => socket.destroy()); });
server.on('clientError', (_error, socket) => socket.destroy());
server.on('connect', async (request, client, head) => {
  let upstream: Socket | undefined;
  const stop = () => { client.destroy(); upstream?.destroy(); };
  client.on('error', stop); client.on('close', () => upstream?.destroy());
  try {
    const url = new URL(`https://${request.url}`);
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid CONNECT authority');
    const target = await targetFor(url);
    if (client.destroyed) return;
    upstream = connect({ host: target.address, port: target.port, family: target.family });
    upstream.setTimeout(300000, stop); upstream.on('error', stop);
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream!.write(head);
      client.pipe(upstream!); upstream!.pipe(client);
    });
  } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
});
server.on('upgrade', async (request, client, head) => {
  let upstream: Socket | undefined;
  const stop = () => { client.destroy(); upstream?.destroy(); };
  client.on('error', stop); client.on('close', () => upstream?.destroy());
  try {
    const url = new URL(request.url!);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol !== 'http:' || request.headers.upgrade?.toLowerCase() !== 'websocket') throw new Error('Upgrade denied');
    const target = await targetFor(url);
    if (client.destroyed) return;
    upstream = connect({ host: target.address, port: target.port, family: target.family });
    upstream.setTimeout(300000, stop); upstream.on('error', stop);
    upstream.once('connect', () => {
      const forwarded = { ...headers(request), host: url.host, connection: 'Upgrade', upgrade: 'websocket' };
      upstream!.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\n` + Object.entries(forwarded).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`).join('') + '\r\n');
      if (head.length) upstream!.write(head);
      client.pipe(upstream!); upstream!.pipe(client);
    });
  } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
});
const path = '/proxy/egress.sock';
await rm(path, { force: true });
server.listen(path, async () => { await chmod(path, 0o600); });
process.on('SIGTERM', () => { for (const socket of clients) socket.destroy(); server.close(() => process.exit()); });
