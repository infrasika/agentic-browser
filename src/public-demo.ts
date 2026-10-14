import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityStore, type Principal } from './identity.js';
import { SessionRegistry, type BrowserSession } from './sessions.js';
import { ServiceError } from './contracts.js';

// A fixed, local-only demonstration of an Agent. No model, account, payment or
// arbitrary task is needed, and no Agent credential is sent to the visitor.
export class PublicDemo {
  constructor(private identity: IdentityStore, private registry: SessionRegistry) {}
  async start(request: IncomingMessage, response: ServerResponse, origin: string) {
    if (request.headers.authorization) throw new ServiceError(403, 'demo_restricted', 'Start from the demo page.');
    let principal: Principal | undefined;
    try { principal = this.identity.request(request, true); }
    catch (error) { if (!(error instanceof ServiceError && error.status === 401)) throw error; }
    if (principal && !principal.guest) throw new ServiceError(403, 'demo_restricted', 'This entry point is only for temporary demo guests.');
    const guest = principal ? undefined : this.identity.createGuest(request.socket.remoteAddress ?? 'unknown');
    const ownerId = principal?.ownerId ?? guest!.ownerId;
    let session: BrowserSession | undefined;
    try {
      for (const previous of this.registry.list(ownerId)) {
        try {
          const live = this.registry.get(previous.id, ownerId);
          return { ...live.info(), humanUrl: `${origin}/view#${live.id}` };
        } catch { await this.registry.remove(previous.id, ownerId); }
      }
      session = await this.registry.create('Try Agent and human collaboration', undefined, ownerId);
      if (response.destroyed || !this.identity.isActive(ownerId)) throw new ServiceError(499, 'request_cancelled', 'Demo startup was cancelled.');
      await session.run('agent', async workspace => {
        await workspace.perform({ type: 'navigate', url: 'https://agentic-browser.invalid/demo' });
        await workspace.perform({ type: 'click', selector: '#username' });
      });
      await session.transfer('human', 'Sign in with a fictional username and password, then hand back control.');
      if (response.destroyed || !this.identity.isActive(ownerId)) throw new ServiceError(499, 'request_cancelled', 'Demo startup was cancelled.');
      if (guest) response.setHeader('Set-Cookie', `ab_login=${guest.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600${origin.startsWith('https:') ? '; Secure' : ''}`);
      return { ...session.info(), humanUrl: `${origin}/view#${session.id}` };
    } catch (error) {
      if (session) await this.registry.remove(session.id, ownerId);
      if (guest) this.identity.deleteGuest(guest.ownerId);
      throw error;
    }
  }
  async complete(session: BrowserSession, authorize: () => void) {
    const completed = await session.run('agent', async workspace => {
      authorize();
      const snapshot = await workspace.perform({ type: 'snapshot' }) as { url: string; text: string };
      if (snapshot.url !== 'http://127.0.0.1:8080/demo' || !snapshot.text.includes('Signed in: ')) return false;
      authorize();
      await workspace.perform({ type: 'click', selector: '#continue' });
      return true;
    });
    // Show the visitor what the fixed demo Agent completed in the same browser.
    return session.transfer('human', completed ? 'Demo complete: the Agent continued in the same session. Review the result or close this temporary browser.' : 'The demo login is incomplete. Return to the demo page, sign in with fictional details, then hand back control.', authorize);
  }
}
