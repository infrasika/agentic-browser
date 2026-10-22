import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { ServiceError } from '../contracts.js';
import type { BrowserService } from '../scheduling/service.js';
import type { ViewerGrants } from '../streaming/grants.js';
import { acquireSchema, actionRequestSchema, controlRequestSchema, identitySchema, releaseRequestSchema, snapshotRequestSchema, viewerRequestSchema } from './protocol.js';

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new ServiceError(415, 'json_required', 'JSON is required');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new ServiceError(413, 'request_too_large', 'Request is too large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError(400, 'invalid_json', 'Invalid JSON'); }
}

export function createControlServer(service: BrowserService, grants: ViewerGrants, token: string) {
  if (token.length < 32) throw new Error('Service token is too short');
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 8192 }, async (request, response) => {
    try {
      if (request.url === '/health' && request.method === 'GET') { send(response, 200, { status: 'ok' }); return; }
      const supplied = createHash('sha256').update(request.headers.authorization ?? '').digest();
      if (!timingSafeEqual(expected, supplied) || request.headers.origin) throw new ServiceError(401, 'unauthorized', 'Service authentication required');
      const url = new URL(request.url ?? '/', 'http://browser.internal');
      if (url.pathname === '/internal/v1/events' && request.method === 'GET') {
        const after = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('after') ?? service.store.cursor());
        send(response, 200, { events: service.store.events(after), cursor: service.store.cursor() }); return;
      }
      if (url.pathname === '/internal/v1/events/ack' && request.method === 'POST') {
        const body = z.object({ cursor: z.number().int().nonnegative() }).strict().parse(await readBody(request));
        service.store.ack(body.cursor); send(response, 200, { cursor: service.store.cursor() }); return;
      }
      if (url.pathname === '/internal/v1/leases' && request.method === 'GET') {
        send(response, 200, { leases: service.store.live() }); return;
      }
      const principal = {
        userId: identitySchema.parse(request.headers['x-user-id']),
        conversationId: identitySchema.parse(request.headers['x-conversation-id']),
        taskId: identitySchema.parse(request.headers['x-task-id']),
      };
      const actor = z.enum(['agent', 'human']).parse(request.headers['x-actor']);
      if (url.pathname === '/internal/v1/task' && request.method === 'GET') {
        const lease = service.store.forTask(principal);
        send(response, 200, { lease: lease ? service.status(lease.id, principal) : null }); return;
      }
      if (url.pathname === '/internal/v1/leases' && request.method === 'POST') {
        if (actor !== 'agent') throw new ServiceError(403, 'agent_required', 'Only an Agent task can allocate a browser');
        send(response, 202, service.acquire(principal, acquireSchema.parse(await readBody(request)))); return;
      }
      if (url.pathname === '/internal/v1/revoke' && request.method === 'POST') {
        grants.revokeUser(principal.userId);
        service.emit('revokeUser', principal.userId);
        await Promise.all(service.store.live().filter(lease => lease.userId === principal.userId).map(lease => service.release(lease.id, lease)));
        send(response, 200, { revoked: true }); return;
      }
      const match = /^\/internal\/v1\/leases\/([a-f0-9-]{36})(?:\/(actions|snapshot|control|viewer-grants))?$/.exec(url.pathname);
      if (!match) throw new ServiceError(404, 'not_found', 'Not found');
      const [, id, operation] = match;
      service.store.owned(id, principal);
      if (!operation && request.method === 'GET') { send(response, 200, service.status(id, principal)); return; }
      if (!operation && request.method === 'DELETE') {
        const input = releaseRequestSchema.parse(await readBody(request));
        send(response, 200, await service.release(id, principal, input.outcome)); return;
      }
      if (request.method !== 'POST') throw new ServiceError(405, 'method_not_allowed', 'Method not allowed');
      const body = await readBody(request);
      if (operation === 'actions') {
        if (actor !== 'agent') throw new ServiceError(403, 'agent_required', 'Use the browser input channel');
        const input = actionRequestSchema.parse(body);
        send(response, 200, { result: await service.action(id, principal, input.operationId, input.revision, input.action) }); return;
      }
      if (operation === 'snapshot') {
        if (actor !== 'agent') throw new ServiceError(403, 'agent_required', 'Use the browser viewing channel');
        send(response, 200, { result: await service.snapshot(id, principal, snapshotRequestSchema.parse(body).screenshot) }); return;
      }
      if (operation === 'control') {
        const input = controlRequestSchema.parse(body);
        send(response, 200, await service.control(id, principal, actor, input.operationId, input.revision, input.target, input.reason)); return;
      }
      if (operation === 'viewer-grants') {
        if (actor !== 'human') throw new ServiceError(403, 'human_required', 'Only the user may view the browser');
        const input = viewerRequestSchema.parse(body);
        service.validateViewer(id, principal, input.revision, input.role);
        send(response, 200, grants.issue({ ...principal, leaseId: id, ...input })); return;
      }
      throw new ServiceError(404, 'not_found', 'Not found');
    } catch (error) {
      if (error instanceof z.ZodError) send(response, 400, { error: 'invalid_request', message: 'Invalid request fields' });
      else if (error instanceof ServiceError) send(response, error.status, { error: error.code, message: error.message });
      else send(response, 500, { error: 'internal_error', message: 'Browser service could not complete this request' });
    }
  });
}
