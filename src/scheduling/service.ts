import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BrowserAllocationError, ServiceError, type Actor, type BrowserAction, type BrowserEngine, type BrowserWorkspace } from '../contracts.js';
import { BrowserSession } from '../sessions.js';
import { SchedulerStore, terminalStates, type Lease, type LeaseState, type Principal } from './store.js';

type Runtime = { workspace: BrowserWorkspace; session?: BrowserSession };
type Options = { ttlMs: number; maxLifetimeMs: number; queueTtlMs: number; maxQueued: number };

export class BrowserService extends EventEmitter {
  private runtimes = new Map<string, Runtime>();
  private launches = new Map<string, Promise<void>>();
  private removals = new Map<string, Promise<void>>();
  private stopping = false;
  private ticking?: Promise<void>;

  constructor(readonly store: SchedulerStore, private engine: BrowserEngine, private options: Options, private now = Date.now) { super(); }

  status(id: string, principal: Principal) {
    const lease = this.store.owned(id, principal);
    return { ...lease, position: this.store.position(lease), capacity: this.store.capacity() };
  }

  acquire(principal: Principal, input: { acquisitionId: string; purpose: string; url: string }) {
    if (this.stopping) throw new ServiceError(503, 'shutting_down', 'Browser service is restarting');
    // Existing users may still replay their request when the queue is full.
    const live = this.store.live();
    if (!live.some(lease => lease.userId === principal.userId) && live.filter(lease => lease.state === 'queued').length >= this.options.maxQueued) {
      throw new ServiceError(429, 'queue_full', 'The browser queue is full. Try again later');
    }
    const lease = this.store.acquire(principal, input);
    this.pump();
    return this.status(lease.id, principal);
  }

  private pump() {
    if (this.stopping) return;
    let lease: Lease | undefined;
    while ((lease = this.store.reserve())) {
      const id = lease.id;
      const launch = this.start(lease).finally(() => { this.launches.delete(id); this.pump(); });
      this.launches.set(id, launch);
    }
  }

  private async start(lease: Lease) {
    try {
      const workspace = await this.engine.create({ ownerId: lease.userId });
      const runtime: Runtime = { workspace };
      this.runtimes.set(lease.id, runtime);
      if (this.stopping || this.store.get(lease.id).state !== 'starting') {
        await this.cleanup(lease.id); return;
      }
      const session = new BrowserSession(lease.purpose, workspace, this.options.ttlMs, this.now, lease.userId, undefined, this.options.maxLifetimeMs);
      runtime.session = session;
      await session.run('agent', workspace => workspace.perform({ type: 'navigate', url: lease.url }));
      if (this.stopping || this.store.get(lease.id).state !== 'starting') {
        await this.cleanup(lease.id); return;
      }
      this.store.update(lease.id, { state: 'active', sessionId: session.id, expiresAt: session.expiresAt }, 'slot_ready');
      this.emit('changed', lease.id);
    } catch (error) {
      if (error instanceof BrowserAllocationError) this.runtimes.set(lease.id, { workspace: error.workspace });
      if (this.runtimes.has(lease.id)) {
        this.store.update(lease.id, { state: 'cleanup_pending', error: 'startup_failed', control: 'closed' });
        await this.cleanup(lease.id);
      } else {
        this.store.update(lease.id, { state: 'failed', error: 'startup_failed', control: 'closed' }, 'session_ended');
      }
      this.emit('changed', lease.id);
    }
  }

  private active(id: string, principal: Principal) {
    const lease = this.store.owned(id, principal);
    if (lease.state !== 'active') throw new ServiceError(409, 'browser_not_ready', 'The browser is not ready');
    const runtime = this.runtimes.get(id);
    if (!runtime?.session) throw new ServiceError(410, 'session_ended', 'The browser session has ended');
    runtime.session.assertAlive();
    return { lease, runtime, session: runtime.session };
  }

  async action(id: string, principal: Principal, operationId: string, revision: number, action: BrowserAction) {
    const { session } = this.active(id, principal);
    if (session.info().control !== 'agent') throw new ServiceError(409, 'control_unavailable', 'The user currently controls this browser');
    // Revision fences a fresh execution; retries of the same intent return the original result.
    const fingerprint = createHash('sha256').update(JSON.stringify({ action })).digest('hex');
    const operation = this.store.beginOperation(id, operationId, fingerprint);
    if (!operation.fresh) return operation.result;
    if (session.info().revision !== revision) throw new ServiceError(409, 'stale_revision', 'Browser control has changed');
    const result = await session.run('agent', workspace => workspace.perform(action));
    this.store.finishOperation(id, operationId, result);
    return result;
  }

  async snapshot(id: string, principal: Principal, screenshot: boolean) {
    const { session } = this.active(id, principal);
    return session.run('agent', async workspace => screenshot
      ? { image: (await workspace.screenshot(true)).toString('base64'), mimeType: 'image/jpeg' }
      : workspace.perform({ type: 'snapshot' }));
  }

  async control(id: string, principal: Principal, actor: Actor, operationId: string, revision: number, target: Actor, reason: string) {
    const { session } = this.active(id, principal);
    if (target === 'agent' && actor !== 'human') throw new ServiceError(403, 'human_required', 'Only the user may return browser control');
    const fingerprint = createHash('sha256').update(JSON.stringify({ actor, target, reason })).digest('hex');
    const operation = this.store.beginOperation(id, operationId, fingerprint);
    if (!operation.fresh) return operation.result;
    if (session.info().revision !== revision) throw new ServiceError(409, 'stale_revision', 'Browser control has changed');
    const transition = session.transfer(target, reason, () => { this.active(id, principal); });
    this.emit('changed', id);
    const info = await transition;
    const lease = this.store.update(id, { control: info.control, revision: info.revision }, target === 'agent' ? 'control_returned' : 'control_taken');
    const result = { leaseId: id, control: lease.control, revision: lease.revision };
    this.store.finishOperation(id, operationId, result);
    this.emit('changed', id);
    return result;
  }

  /** Viewer-only transport; caller has validated an observe grant. Never routes user frames to the model. */
  async frame(id: string, principal: Principal, revision: number) {
    const { session } = this.active(id, principal);
    if (session.info().revision !== revision) throw new ServiceError(409, 'stale_revision', 'Browser control has changed');
    return session.run('agent', workspace => workspace.screenshot(true));
  }

  async desktop(id: string, principal: Principal, revision: number) {
    const { session } = this.active(id, principal);
    if (session.info().revision !== revision) throw new ServiceError(409, 'stale_revision', 'Browser control has changed');
    return session.run('human', async workspace => {
      if (!workspace.openDesktop) throw new ServiceError(409, 'desktop_unavailable', 'Interactive browser is not available');
      return workspace.openDesktop();
    });
  }

  validateViewer(id: string, principal: Principal, revision: number, role: 'observe' | 'input') {
    const { session } = this.active(id, principal);
    const info = session.info();
    if (info.revision !== revision || info.control !== (role === 'input' ? 'human' : 'agent')) {
      throw new ServiceError(409, 'control_unavailable', 'Browser control has changed');
    }
  }

  async release(id: string, principal: Principal, outcome: 'completed' | 'cancelled' | 'expired' = 'cancelled') {
    const lease = this.store.owned(id, principal);
    if (terminalStates.includes(lease.state)) return this.status(id, principal);
    if (lease.state === 'queued') {
      this.store.update(id, { state: outcome, control: 'closed' }, 'session_ended');
    } else {
      this.store.update(id, { state: 'closing', control: 'closed', error: outcome });
      this.emit('changed', id);
      if (!this.launches.has(id)) await this.cleanup(id);
    }
    this.pump();
    return this.status(id, principal);
  }

  private cleanup(id: string): Promise<void> {
    const pending = this.removals.get(id);
    if (pending) return pending;
    const work = Promise.resolve().then(async () => {
      const runtime = this.runtimes.get(id);
      if (!runtime) return;
      try {
        await (runtime.session ? runtime.session.close() : runtime.workspace.close());
        this.runtimes.delete(id);
        const previous = this.store.get(id);
        const state: LeaseState = previous.error === 'startup_failed' ? 'failed'
          : previous.error === 'expired' ? 'expired' : previous.error === 'completed' ? 'completed' : 'cancelled';
        this.store.update(id, { state, control: 'closed' }, 'session_ended');
      } catch {
        this.store.update(id, { state: 'cleanup_pending', control: 'closed' });
      }
      this.emit('changed', id);
    }).finally(() => { this.removals.delete(id); this.pump(); });
    this.removals.set(id, work);
    return work;
  }

  tick(): Promise<void> {
    return this.ticking ??= this.reap().finally(() => { this.ticking = undefined; });
  }

  private async reap() {
    for (const lease of this.store.live()) {
      if (lease.state === 'queued' && lease.createdAt + this.options.queueTtlMs <= this.now()) {
        await this.release(lease.id, lease, 'expired');
      } else if (lease.state === 'cleanup_pending' || lease.state === 'closing') {
        if (!this.launches.has(lease.id)) await this.cleanup(lease.id);
      } else if (lease.state === 'active') {
        try { this.runtimes.get(lease.id)?.session?.assertAlive(); }
        catch { await this.release(lease.id, lease, 'expired'); }
      }
    }
    this.pump();
  }

  async idle() { await Promise.all([...this.launches.values(), ...this.removals.values()]); }

  async close() {
    this.stopping = true;
    await this.ticking;
    await this.idle();
    for (const lease of this.store.live()) await this.release(lease.id, lease);
    await this.idle();
    await this.engine.close();
    this.store.close();
  }
}
