import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { actionSchema, ServiceError, webUrl } from './contracts.js';
import { IdentityStore } from './identity.js';
import { SessionRegistry, type BrowserSession, sameToken } from './sessions.js';
import { waitForSession } from './session-wait.js';

const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const output = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function humanLinkOutput(value: { humanUrl: string; linkExpiresAt: string }): CallToolResult {
  const userMessage = `请打开本次会话的接管链接：

[打开浏览器并接管](${value.humanUrl})

如果链接无法点击，请复制下面的完整地址到浏览器：
${value.humanUrl}

进入后点击“连接并接管”，完成登录或其他操作，再点击“完成，交还给 Agent”。请在 2 分钟内打开并领取链接；已使用或过期时，让我重新获取。`;
  const payload = { ...value, userMessage };
  const json = output(payload);
  return {
    // Keep the JSON text first for existing clients, alongside structured data
    // and a ready-to-send message for clients that only surface text blocks.
    structuredContent: payload,
    content: [...json.content, { type: 'text', text: `ACTION REQUIRED: Send the following userMessage to the current user NOW, before calling browser_wait. Include the actual clickable link and full URL, including its # fragment. Do not merely say "click Connect". Never open or claim this link yourself.\n\n${userMessage}` }],
  };
}
const credentials = {
  sessionId: z.string().uuid(),
  sessionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).describe('Private capability returned by browser_create. Keep it in tool calls; never publish it.'),
};
type Access = { sessionId: string; sessionKey: string };
type Lease = { owner: string; keyHash: string; humanToken: string; expires: number; source: string; claimHash?: string; claimExpires?: number; pending: number };

export function publicClientAddress(request: IncomingMessage, trustProxy = false) {
  // Enable only behind one trusted proxy which overwrites X-Real-IP, with the
  // controller port bound to loopback. Never trust a client-provided XFF chain.
  const forwarded = request.headers['x-real-ip'];
  const address = trustProxy && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : request.socket.remoteAddress ?? 'unknown';
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

// The HTTP transport is stateless. Every browser operation carries an explicit
// per-session capability; a transport session ID is never authentication.
export class RemoteMcp {
  private leases = new Map<string, Lease>();
  private creating = new Map<string, number>();
  private requests = new Map<string, { count: number; until: number; active: number }>();
  private active = 0;
  private closing = false;
  private reaping?: Promise<void>;
  private connections = new Set<() => void>();
  constructor(private registry: SessionRegistry, private identity: IdentityStore,
    private options: { maxSessionsPerIp?: number; trustProxy?: boolean }, private now = Date.now) {}

  private access(args: Access) {
    const lease = this.leases.get(args.sessionId);
    if (!lease || !sameToken(hash(args.sessionKey), lease.keyHash)) throw new ServiceError(404, 'session_not_found', 'Session not found or key invalid.');
    if (lease.expires <= this.now() || !this.identity.isActive(lease.owner)) throw new ServiceError(410, 'session_ended', 'This public session has ended.');
    return { lease, session: this.registry.get(args.sessionId, lease.owner, lease.keyHash) };
  }
  private humanLink(session: BrowserSession, lease: Lease, origin: string) {
    const ticket = secret();
    lease.claimHash = hash(ticket); lease.claimExpires = Math.min(lease.expires, this.now() + 120000);
    return { humanUrl: `${origin}/connect#${session.id}.${ticket}`, linkExpiresAt: new Date(lease.claimExpires).toISOString() };
  }
  async claim(sessionId: string, ticket: string, origin: string, response: ServerResponse) {
    const lease = this.leases.get(sessionId);
    if (!lease?.claimHash || !sameToken(hash(ticket), lease.claimHash) || (lease.claimExpires ?? 0) <= this.now() || lease.expires <= this.now())
      throw new ServiceError(410, 'link_expired', '接管链接已使用或过期，请让 Agent 获取新链接。');
    const principal = this.identity.authenticate(lease.humanToken, 'human');
    const session = this.registry.get(sessionId, lease.owner, lease.keyHash);
    lease.claimHash = undefined; // Consume synchronously before any async work.
    await session.transfer('human', '你正在操作；完成后点击交还给 Agent。', () => this.identity.assertCurrent(principal));
    this.identity.assertCurrent(principal);
    response.setHeader('Set-Cookie', `ab_login=${lease.humanToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((lease.expires - this.now()) / 1000))}${origin.startsWith('https:') ? '; Secure' : ''}`);
    return { humanUrl: `${origin}/view#${sessionId}` };
  }
  private async create(source: string, origin: string, args: { purpose: string; url?: string }, signal: AbortSignal) {
    await this.reap(); signal.throwIfAborted();
    if (this.closing) throw new ServiceError(503, 'shutting_down', 'The service is stopping.');
    const count = [...this.leases.values()].filter(lease => lease.source === source).length + (this.creating.get(source) ?? 0);
    if (count >= (this.options.maxSessionsPerIp ?? 2)) throw new ServiceError(429, 'source_limit', 'This network has reached its demo session limit. Close an existing session first.');
    this.creating.set(source, (this.creating.get(source) ?? 0) + 1);
    let guest: ReturnType<IdentityStore['createGuest']> | undefined, session: BrowserSession | undefined;
    try {
      guest = this.identity.createGuest(source);
      const sessionKey = secret(), keyHash = hash(sessionKey);
      session = await this.registry.create(args.purpose, undefined, guest.ownerId, keyHash);
      signal.throwIfAborted();
      if (this.closing || !this.identity.isActive(guest.ownerId)) throw new ServiceError(410, 'session_ended', 'Creation cancelled or expired.');
      await session.run('agent', workspace => workspace.perform({ type: 'navigate', url: args.url ?? 'https://agentic-browser.invalid/demo' }));
      signal.throwIfAborted();
      const lease: Lease = { owner: guest.ownerId, keyHash, humanToken: guest.token, expires: Date.parse(guest.expiresAt), source, pending: 0 };
      this.leases.set(session.id, lease);
      return { ...session.info(), sessionId: session.id, sessionKey, ...this.humanLink(session, lease, origin),
        notice: 'Public temporary browser. Use test accounts. The operator administers the host; your Agent can read pages after handback. No saved profiles. Initially 5 minutes, maximum 10 minutes.' };
    } catch (error) {
      if (session && guest) {
        try { await this.registry.remove(session.id, guest.ownerId); }
        catch {
          // Failed creation still counts against its source until cleanup
          // succeeds. No capability/link was delivered for this abandoned lease.
          this.leases.set(session.id, { owner: guest.ownerId, keyHash: session.agentCredentialHash!, humanToken: guest.token,
            expires: this.now(), source, pending: 0 });
          throw error;
        }
      }
      if (guest) this.identity.deleteGuest(guest.ownerId);
      throw error;
    } finally {
      const left = (this.creating.get(source) ?? 1) - 1;
      if (left) this.creating.set(source, left); else this.creating.delete(source);
    }
  }
  reap(): Promise<void> {
    return this.reaping ??= this.reapOnce().finally(() => { this.reaping = undefined; });
  }
  private async reapOnce() {
    for (const [id, lease] of this.leases) {
      let expired = lease.expires <= this.now() || !this.identity.isActive(lease.owner);
      if (!expired) { try { this.registry.get(id, lease.owner, lease.keyHash); } catch { expired = true; } }
      if (expired) {
        // Retain bookkeeping when cleanup fails; retry without releasing quota.
        try { await this.registry.remove(id, lease.owner); this.identity.deleteGuest(lease.owner); this.leases.delete(id); } catch {}
      }
    }
  }
  async close() {
    this.closing = true;
    for (const close of this.connections) close();
    await this.reaping;
  }
  async handle(request: IncomingMessage, response: ServerResponse, origin: string) {
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
    if (this.closing) throw new ServiceError(503, 'shutting_down', 'The service is stopping.');
    const source = publicClientAddress(request, this.options.trustProxy);
    for (const [key, entry] of this.requests) if (entry.until <= this.now() && entry.active === 0) this.requests.delete(key);
    if (this.requests.size >= 4096 && !this.requests.has(source)) throw new ServiceError(429, 'rate_limit', 'Demo busy. Try later.');
    const entry = this.requests.get(source) ?? { count: 0, until: this.now() + 60000, active: 0 };
    if (entry.until <= this.now()) { entry.count = 0; entry.until = this.now() + 60000; }
    this.requests.set(source, entry);
    if (++entry.count > 120 || entry.active >= 8 || this.active >= 64) throw new ServiceError(429, 'rate_limit', 'Too many requests. Try later.');
    entry.active++; this.active++;
    const abort = new AbortController();
    const mcp = new McpServer({ name: 'agentic-browser-public', version: '0.1.0' }, {
      instructions: 'Public temporary remote Chrome. browser_create returns sessionId and private sessionKey; pass both to every subsequent tool. For manual work, call browser_handoff and immediately send its userMessage to the current user BEFORE calling browser_wait. Always include the returned humanUrl as a clickable Markdown link AND a full raw URL, preserving the # fragment. Saying "click Connect" without the actual URL is not a handoff. Only share the latest humanUrl with the current user; never expose sessionKey or claim the human link yourself. If a link is missing or expired, call browser_human_link for the same session and display the new userMessage. Ask the user to click 连接并接管, complete manual work, then 完成，交还给 Agent. Never collect passwords in chat. While human has control, only check status, refresh a link, or wait. Close when done. Tools and network are limited; do not retry submissions blindly.' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65536 });
    const stop = () => { abort.abort(); void mcp.close(); };
    this.connections.add(stop);
    const finished = new Promise<void>(resolve => response.once('close', () => { stop(); resolve(); }));
    const safe = async (work: () => Promise<CallToolResult>): Promise<CallToolResult> => {
      try { abort.signal.throwIfAborted(); return await work(); }
      catch (error) { return { ...output(error instanceof ServiceError ? { error: error.code, status: error.status, message: error.message } : { error: abort.signal.aborted ? 'cancelled' : 'browser_operation_failed', status: abort.signal.aborted ? 499 : 502, message: 'Operation cancelled or failed. Check session status before retrying.' }), isError: true }; }
    };
    const using = async (args: Access, work: (session: BrowserSession, lease: Lease, authorize: () => void) => Promise<CallToolResult>) => safe(async () => {
      const { session, lease } = this.access(args);
      if (lease.pending >= 4) throw new ServiceError(429, 'operation_limit', 'Too many concurrent operations for this session.');
      lease.pending++;
      const authorize = () => { abort.signal.throwIfAborted(); this.access(args); };
      try { return await work(session, lease, authorize); } finally { lease.pending--; }
    });
    mcp.registerTool('browser_create', { description: 'Create a separate temporary Chrome container. Optional HTTP(S) URL; defaults to the built-in fictional login demo. Returns sessionId, sessionKey and an initial humanUrl. For manual work call browser_handoff BEFORE showing any link: handoff replaces the initial URL, so only display the latest userMessage it returns. No saved profiles. Do not repeat an uncertain creation.', inputSchema: { purpose: z.string().min(1).max(300).default('Public browser demo'), url: webUrl.optional() } }, args => safe(async () => output(await this.create(source, origin, args, abort.signal))));
    mcp.registerTool('browser_status', { description: 'Read this session control state and expiry only.', inputSchema: credentials }, args => using(args, async session => output(session.info())));
    mcp.registerTool('browser_action', { description: 'Operate or inspect the page only when control is agent. HTTP(S) public sites are permitted; private networks and host management services are blocked.', inputSchema: { ...credentials, action: actionSchema } }, args => using(args, async (session, _lease, authorize) => {
      const result = await session.run('agent', workspace => { authorize(); return workspace.perform(args.action); }); authorize(); return output({ result });
    }));
    mcp.registerTool('browser_screenshot', { description: 'Screenshot with password fields masked. Unavailable during human control.', inputSchema: credentials }, args => using(args, async (session, _lease, authorize) => {
      const screen = await session.run('agent', workspace => { authorize(); return workspace.screenshot(true); }); authorize();
      return { content: [{ type: 'image', mimeType: 'image/jpeg', data: screen.toString('base64') }] };
    }));
    mcp.registerTool('browser_handoff', { description: 'Pause Agent observation/input and return a one-use humanUrl plus userMessage, valid for 2 minutes. Immediately display userMessage to the current user, including the actual clickable link and full URL with its # fragment, BEFORE browser_wait. Never just say "click Connect" without the URL; never open it yourself.', inputSchema: { ...credentials, reason: z.string().min(1).max(500).default('请完成操作后交还给 Agent。') } }, args => using(args, async (session, lease, authorize) => {
      await session.transfer('human', args.reason, authorize); authorize(); return humanLinkOutput({ ...session.info(), ...this.humanLink(session, lease, origin) });
    }));
    mcp.registerTool('browser_human_link', { description: 'Issue a fresh one-use humanUrl plus userMessage when the user needs a missing or expired link. Immediately send userMessage with the full clickable URL to the current user before waiting. Invalidates the previous unclaimed link without changing control. Never open or claim it yourself.', inputSchema: credentials }, args => using(args, async (session, lease) => humanLinkOutput(this.humanLink(session, lease, origin))));
    mcp.registerTool('browser_wait', { description: 'Only after displaying the latest humanUrl to the user, wait up to 25 seconds for human handback. Never takes control or replays actions. HTTP disconnect stops the wait; a client-only cancellation may leave it running until timeout.', inputSchema: { ...credentials, afterRevision: z.number().int().nonnegative().optional(), timeoutSeconds: z.number().int().min(1).max(25).default(20) } }, (args, extra) => using(args, async (session, _lease, authorize) => output(await waitForSession(session, { control: 'agent', timeoutMs: args.timeoutSeconds * 1000, afterRevision: args.afterRevision, signal: AbortSignal.any([abort.signal, extra.signal]) }, authorize))));
    mcp.registerTool('browser_extend', { description: 'Extend up to the public absolute 10-minute lifetime; does not revive ended sessions.', inputSchema: credentials }, args => using(args, async session => output(session.extend())));
    mcp.registerTool('browser_close', { description: 'End the session, discard temporary browser state, and revoke its human link. Waits for resource cleanup.', inputSchema: credentials }, args => using(args, async (session, lease) => {
      await this.registry.remove(session.id, lease.owner); this.identity.deleteGuest(lease.owner); this.leases.delete(session.id);
      return output({ id: session.id, control: 'closed' });
    }));
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
      await finished;
    } finally { stop(); this.connections.delete(stop); entry.active--; this.active--; }
  }
}
