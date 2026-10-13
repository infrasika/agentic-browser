import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ServiceError,
  type Actor,
  type BrowserEngine,
  type BrowserWorkspace,
  type ControlState,
} from "./contracts.js";

export function sameToken(received: string, expected: string) {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class BrowserSession {
  readonly id = randomUUID();
  readonly humanToken = randomBytes(32).toString("base64url");
  readonly createdAt: number;
  private deadline: number;
  get expiresAt() { return this.deadline; }
  private state: ControlState = "agent";
  private revision = 0;
  private reason = "";
  private tail: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(
    readonly purpose: string,
    private workspace: BrowserWorkspace,
    private ttlMs: number,
    private now = Date.now,
    readonly ownerId?: string,
    public agentCredentialHash?: string,
    private maxLifetimeMs = Infinity,
  ) {
    this.createdAt = now();
    this.deadline = this.createdAt + Math.min(ttlMs, maxLifetimeMs);
  }

  info() {
    return {
      id: this.id,
      purpose: this.purpose,
      control: this.state,
      revision: this.revision,
      transport: this.workspace.transport ?? "page",
      reason: this.reason,
      profile: this.workspace.profile ?? null,
      runtime: this.workspace.runtime ?? null,
      serverTime: new Date(this.now()).toISOString(),
      ttlSeconds: this.ttlMs / 1000,
      createdAt: new Date(this.createdAt).toISOString(),
      expiresAt: new Date(this.expiresAt).toISOString(),
    };
  }

  extend() {
    this.assertAlive();
    this.deadline = Math.min(this.createdAt + this.maxLifetimeMs, Math.max(this.deadline, this.now() + this.ttlMs));
    return this.info();
  }

  assertAlive() {
    if (this.state === "closed" || this.now() >= this.expiresAt) {
      throw new ServiceError(410, "session_ended", "This session has ended");
    }
    if (['cleanup_pending', 'closed'].includes(this.workspace.runtime?.state ?? '')) {
      void this.close().catch(() => {});
      throw new ServiceError(503, 'runtime_stopped', '浏览器环境已停止，请创建新会话。');
    }
  }

  private assertControl(actor: Actor, revision: number) {
    this.assertAlive();
    if (this.state !== actor || this.revision !== revision) {
      throw new ServiceError(
        409,
        "control_unavailable",
        "Control changed; check session status before continuing",
      );
    }
  }

  async run<T>(
    actor: Actor,
    operation: (workspace: BrowserWorkspace) => Promise<T>,
  ): Promise<T> {
    const revision = this.revision;
    this.assertControl(actor, revision);
    const work = this.tail.then(async () => {
      this.assertControl(actor, revision);
      let timer: NodeJS.Timeout | undefined;
      let result: T;
      try {
        result = await Promise.race([
          operation(this.workspace),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              void this.close().catch(() => {});
              reject(
                new ServiceError(
                  504,
                  "operation_timeout",
                  "Browser did not respond; this session has been closed",
                ),
              );
            }, 20000).unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      // An observation begun before takeover must not escape after control changes.
      this.assertControl(actor, revision);
      return result;
    });
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }

  async transfer(target: Actor, reason = "", authorize = () => {}) {
    authorize();
    this.assertAlive();
    if (this.state === target) return this.info();
    if (this.state === "switching")
      throw new ServiceError(
        409,
        "control_switching",
        "A control transfer is already in progress",
      );
    this.state = "switching";
    const revision = ++this.revision;
    this.reason = reason;
    this.workspace.revokeHumanInput?.();
    // Fence queued actions immediately, then drain the one already executing.
    await this.tail;
    this.assertAlive();
    if (this.revision !== revision)
      throw new ServiceError(
        409,
        "control_changed",
        "The session changed during transfer",
      );
    try {
      authorize();
      await this.workspace.setControl?.(target);
      authorize();
      this.assertAlive();
      if (this.revision !== revision)
        throw new ServiceError(
          409,
          "control_changed",
          "Control changed during transfer",
        );
      this.state = target;
    } catch (error) {
      // A failed detach/attach must never leave either side able to operate.
      await this.close();
      throw error;
    }
    return this.info();
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.state = "closed";
      this.revision++;
      this.workspace.revokeHumanInput?.();
      // Closing the context interrupts browser operations instead of waiting for them.
      this.closing = this.workspace.close().catch(error => { this.closing = undefined; throw error; });
    }
    return this.closing;
  }
}

export class SessionRegistry {
  private sessions = new Map<string, BrowserSession>();
  private pending = new Set<Promise<BrowserSession>>();
  private pendingOwners = new Map<string, number>();
  private stopping = false;

  constructor(
    private engine: BrowserEngine,
    private options: { ttlMs: number; maxSessions: number; maxSessionsPerOwner?: number; maxLifetimeMs?: number },
    private now = Date.now,
  ) {}

  get profiles() { return this.engine.profiles; }

  create(purpose: string, profileId?: string, ownerId?: string, agentCredentialHash?: string): Promise<BrowserSession> {
    if (profileId && !this.profiles)
      return Promise.reject(new ServiceError(400, "profiles_unavailable", "保存登录状态需要远程桌面模式。"));
    if (this.stopping)
      return Promise.reject(
        new ServiceError(503, "shutting_down", "Service is shutting down"),
      );
    if (this.sessions.size + this.pending.size >= this.options.maxSessions ||
      (ownerId && this.list(ownerId).length + (this.pendingOwners.get(ownerId) ?? 0) >= (this.options.maxSessionsPerOwner ?? this.options.maxSessions))) {
      return Promise.reject(
        new ServiceError(
          429,
          "session_limit",
          "Close an existing session before creating another",
        ),
      );
    }
    if (ownerId) this.pendingOwners.set(ownerId, (this.pendingOwners.get(ownerId) ?? 0) + 1);
    const work = Promise.resolve().then(() => this.engine.create({ profileId, ownerId })).then(async (workspace) => {
      if (this.stopping) {
        await workspace.close();
        throw new ServiceError(
          503,
          "shutting_down",
          "Service is shutting down",
        );
      }
      const session = new BrowserSession(
        purpose,
        workspace,
        this.options.ttlMs,
        this.now,
        ownerId,
        agentCredentialHash,
        this.options.maxLifetimeMs,
      );
      this.sessions.set(session.id, session);
      return session;
    });
    this.pending.add(work);
    const finished = () => {
      this.pending.delete(work);
      if (ownerId) { const remaining = (this.pendingOwners.get(ownerId) ?? 1) - 1; if (remaining) this.pendingOwners.set(ownerId, remaining); else this.pendingOwners.delete(ownerId); }
    };
    void work.then(finished, finished);
    return work;
  }

  get(id: string, ownerId?: string, agentCredentialHash?: string) {
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== ownerId || (agentCredentialHash !== undefined && session.agentCredentialHash !== agentCredentialHash))
      throw new ServiceError(404, "session_not_found", "Session not found");
    session.assertAlive();
    return session;
  }

  list(ownerId?: string, agentCredentialHash?: string) {
    return [...this.sessions.values()].filter(session => session.ownerId === ownerId && (agentCredentialHash === undefined || session.agentCredentialHash === agentCredentialHash)).map((session) => session.info());
  }

  async remove(id: string, ownerId?: string) {
    const current = this.sessions.get(id);
    if (current && current.ownerId !== ownerId) throw new ServiceError(404, "session_not_found", "Session not found");
    return this.removeAny(id);
  }

  private async removeAny(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      await session.close();
      this.sessions.delete(id);
    }
  }

  async closeInactiveMembers(active: (owner: string) => boolean) {
    await Promise.allSettled([...this.sessions.values()]
      .filter(session => session.ownerId && !active(session.ownerId))
      .map(session => this.removeAny(session.id)));
  }

  async reap() {
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter((session) => session.expiresAt <= this.now() || session.info().control === 'closed')
        .map((session) => this.removeAny(session.id)),
    );
  }

  async close() {
    this.stopping = true;
    await Promise.allSettled(this.pending);
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.removeAny(id)),
    );
    await this.engine.close();
  }
}
