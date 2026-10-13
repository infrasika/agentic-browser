import type { IncomingMessage, ServerResponse } from 'node:http';
import { IdentityStore, type Principal } from './identity.js';
import { SessionRegistry, type BrowserSession } from './sessions.js';
import { ServiceError } from './contracts.js';

// A fixed, local-only demonstration of an Agent. No model, account, payment or
// arbitrary task is needed, and no Agent credential is sent to the visitor.
export class PublicDemo {
  constructor(private identity: IdentityStore, private registry: SessionRegistry) {}
  async start(request: IncomingMessage, response: ServerResponse, origin: string) {
    if (request.headers.authorization) throw new ServiceError(403, 'demo_restricted', '请在演示页面开始体验。');
    let principal: Principal | undefined;
    try { principal = this.identity.request(request, true); }
    catch (error) { if (!(error instanceof ServiceError && error.status === 401)) throw error; }
    if (principal && !principal.guest) throw new ServiceError(403, 'demo_restricted', '该入口仅供临时访客演示。');
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
      session = await this.registry.create('体验 Agent 与人工协作', undefined, ownerId);
      if (response.destroyed || !this.identity.isActive(ownerId)) throw new ServiceError(499, 'request_cancelled', '演示启动已取消。');
      await session.run('agent', async workspace => {
        await workspace.perform({ type: 'navigate', url: 'https://agentic-browser.invalid/demo' });
        await workspace.perform({ type: 'click', selector: '#username' });
      });
      await session.transfer('human', '请使用虚构用户名和密码完成演示登录，然后点击交还。');
      if (response.destroyed || !this.identity.isActive(ownerId)) throw new ServiceError(499, 'request_cancelled', '演示启动已取消。');
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
      if (snapshot.url !== 'http://127.0.0.1:8080/demo' || !snapshot.text.includes('已登录：')) return false;
      authorize();
      await workspace.perform({ type: 'click', selector: '#continue' });
      return true;
    });
    // Show the visitor what the fixed demo Agent completed in the same browser.
    return session.transfer('human', completed ? '演示完成：Agent 已在同一会话继续任务。你可以查看结果或关闭这个临时环境。' : '演示登录尚未完成，请回到演示页面使用虚构账号登录，再交还。', authorize);
  }
}
