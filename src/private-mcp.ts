import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { IdentityStore } from './identity.js';
import { ServiceError } from './contracts.js';
import { apiRequester, createPrivateMcpServer } from './private-mcp-server.js';

// Stateless HTTP MCP. Every request and underlying API operation authenticates
// the personal credential; neither cookies nor MCP session IDs grant access.
export class PrivateMcp {
  private connections = new Set<() => void>();
  private pending = new Map<string, number>();
  private closing = false;
  constructor(private identity: IdentityStore) {}

  async handle(request: IncomingMessage, response: ServerResponse, origin: string, internalOrigin: string) {
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const principal = this.identity.authenticate(token, 'agent');
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
    if (this.closing) throw new ServiceError(503, 'shutting_down', 'The service is stopping.');
    const key = principal.credentialHash, count = this.pending.get(key) ?? 0;
    if (count >= 8 || this.connections.size >= 64)
      throw new ServiceError(429, 'request_limit', 'Too many concurrent requests. Try again later.');
    this.pending.set(key, count + 1);
    const abort = new AbortController();
    const mcp = createPrivateMcpServer(apiRequester(internalOrigin, token, new URL(origin).host, abort.signal), origin);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65536 });
    const stop = () => { abort.abort(); void mcp.close(); };
    this.connections.add(stop);
    const finished = new Promise<void>(resolve => response.once('close', () => { stop(); resolve(); }));
    try {
      await mcp.connect(transport);
      this.identity.assertCurrent(principal);
      await transport.handleRequest(request, response);
      await finished;
    } finally {
      this.connections.delete(stop);
      const left = (this.pending.get(key) ?? 1) - 1;
      if (left) this.pending.set(key, left); else this.pending.delete(key);
      await mcp.close();
    }
  }
  async close() {
    this.closing = true;
    for (const stop of this.connections) stop();
  }
}
