import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { IdentityStore, passwordSchema, usernameSchema } from './identity.js';
import type { ProfileStore } from './profiles.js';
import { ServiceError } from './contracts.js';

export function checkBrowserRequest(request: IncomingMessage, origin: string) {
  // Strict Origin plus a non-simple header prevents cross-site forms, fetches
  // and login CSRF. No wildcard CORS or trusted forwarded headers are enabled.
  if (request.headers.origin !== origin || request.headers['x-agentic-browser'] !== '1')
    throw new ServiceError(403, 'origin_rejected', '请从当前服务的页面发起操作。');
}
function setCookie(response: ServerResponse, token: string, origin: string, expire = false) {
  response.setHeader('Set-Cookie', `ab_login=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expire ? 0 : 43200}${origin.startsWith('https:') ? '; Secure' : ''}`);
}

export async function teamAuthRoute(
  store: IdentityStore, request: IncomingMessage, response: ServerResponse,
  pathname: string, origin: string, readJson: (request: IncomingMessage) => Promise<unknown>, profiles?: ProfileStore,
): Promise<unknown | undefined> {
  const method = request.method;
  if (pathname === '/api/auth/login' && method === 'POST') {
    checkBrowserRequest(request, origin);
    const body = z.object({ username: usernameSchema, password: passwordSchema }).strict().parse(await readJson(request));
    const login = await store.login(body.username, body.password, request.socket.remoteAddress ?? 'unknown');
    setCookie(response, login.token, origin);
    return { username: login.username, expiresAt: login.expiresAt };
  }
  if (pathname === '/api/auth/me' && method === 'GET') return store.memberInfo(store.request(request, true));
  if (pathname === '/api/auth/logout' && method === 'POST') {
    checkBrowserRequest(request, origin);
    store.logout(store.request(request, true));
    setCookie(response, '', origin, true);
    return { loggedOut: true };
  }
  if (pathname === '/api/credentials') {
    const human = store.request(request, true);
    if (method === 'GET') return { credentials: store.listAgents(human) };
    if (method === 'POST') {
      checkBrowserRequest(request, origin);
      const { name, profileIds } = z.object({ name: z.string().trim().min(1).max(80), profileIds: z.array(z.string().uuid()).max(100).default([]) }).strict().parse(await readJson(request));
      for (const id of profileIds) {
        if (!profiles) throw new ServiceError(400, 'profiles_unavailable', '保存配置不可用。');
        await profiles.get(id, human.ownerId);
      }
      return store.issueAgent(human, name, profileIds);
    }
  }
  const credential = /^\/api\/credentials\/([a-f0-9-]{36})$/.exec(pathname);
  if (credential && method === 'DELETE') {
    checkBrowserRequest(request, origin);
    store.revokeAgent(store.request(request, true), credential[1]);
    return { revoked: true };
  }
  return undefined;
}
