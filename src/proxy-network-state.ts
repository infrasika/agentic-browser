import { once } from 'node:events';
import WebSocket from 'ws';

const autoAttach = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: 'page' }, { type: 'iframe' }, { exclude: true }],
};

// Chromium's native network override is process-wide and is cleared by other
// CDP sessions on navigation/disconnect. Install this constant before site code
// instead, including after reload and during handoff. It reads no page data.
const proxyOnlineBootstrap = `Object.defineProperty(Navigator.prototype, 'onLine', {
  configurable: true, enumerable: true, get: () => true
});`;

/** Expose the configured proxy transport to pages without observing their data.
 * This connection only installs a fixed bootstrap and resumes new targets.
 * It never enables traffic logging, reads content, or runs Agent instructions.
 */
export class ProxyNetworkState {
  private nextId = 0;
  private closing = false;
  private sessions = new Set<string>();
  private configuring = new Set<Promise<void>>();
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(private socket: WebSocket, private onFailure: () => void) {
    socket.on('message', data => {
      try { this.receive(JSON.parse(data.toString())); }
      catch { this.fail(); }
    });
    socket.on('error', () => this.fail());
    socket.on('close', () => this.fail());
  }

  static async connect(endpoint: string, onFailure: () => void) {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Browser network state endpoint unavailable');
    const { webSocketDebuggerUrl } = await response.json() as { webSocketDebuggerUrl: string };
    const url = new URL(webSocketDebuggerUrl);
    const origin = new URL(endpoint);
    if (url.protocol !== 'ws:' || url.host !== origin.host || url.username || url.password)
      throw new Error('Unexpected browser network state endpoint');
    const socket = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
    const state = new ProxyNetworkState(socket, onFailure);
    try {
      await once(socket, 'open');
      await state.send('Target.setAutoAttach', autoAttach);
      // Existing pages are attached before setAutoAttach completes. New pages
      // and out-of-process frames pause until their state has been configured.
      while (state.configuring.size) await Promise.all(state.configuring);
      if (state.closing) throw new Error('Browser network state initialization failed');
      return state;
    } catch (error) { state.close(); throw error; }
  }

  private send(method: 'Target.setAutoAttach' | 'Page.enable' | 'Page.addScriptToEvaluateOnNewDocument' | 'Runtime.runIfWaitingForDebugger', params: object, sessionId?: string) {
    if (this.closing) return Promise.reject(new Error('Browser network state connection closed'));
    const id = ++this.nextId;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Browser network state command timed out'));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (error) this.fail();
      });
    });
  }

  private receive(message: { id?: number; error?: unknown; method?: string; params?: { sessionId: string } }) {
    if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error('Browser network state command failed'));
      else request.resolve();
    } else if (message.method === 'Target.attachedToTarget') {
      const sessionId = message.params!.sessionId;
      this.sessions.add(sessionId);
      const task = this.configure(sessionId).catch(() => {
        // Closing a tab while it is being attached is a normal lifecycle race.
        if (this.sessions.has(sessionId)) this.fail();
      }).finally(() => this.configuring.delete(task));
      this.configuring.add(task);
    } else if (message.method === 'Target.detachedFromTarget') {
      this.sessions.delete(message.params!.sessionId);
    }
  }

  private async configure(sessionId: string) {
    // Page.enable installs Chrome's document-start hook. Without it, the
    // bootstrap runs in the existing document but silently stops on navigation.
    // Page events are ignored; neither DOM nor Runtime observation is enabled.
    await this.send('Page.enable', {}, sessionId);
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: proxyOnlineBootstrap, runImmediately: true,
    }, sessionId);
    await this.send('Target.setAutoAttach', autoAttach, sessionId);
    await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }

  private fail() {
    if (this.closing) return;
    this.close();
    this.onFailure();
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new Error('Browser network state connection closed'));
    }
    this.pending.clear(); this.sessions.clear(); this.socket.terminate();
  }
}
