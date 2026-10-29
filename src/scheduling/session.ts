import { randomUUID } from "node:crypto";
import { ServiceError, type Actor, type BrowserWorkspace, type ControlState } from "../contracts.js";

export class BrowserSession {
  readonly id = randomUUID();
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
    maxLifetimeMs = Infinity,
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
      runtime: this.workspace.runtime ?? null,
      serverTime: new Date(this.now()).toISOString(),
      ttlSeconds: this.ttlMs / 1000,
      createdAt: new Date(this.createdAt).toISOString(),
      expiresAt: new Date(this.expiresAt).toISOString(),
    };
  }

  assertAlive() {
    if (this.state === "closed" || this.now() >= this.expiresAt) {
      throw new ServiceError(410, "session_ended", "This session has ended");
    }
    if (['cleanup_pending', 'closed'].includes(this.workspace.runtime?.state ?? '')) {
      void this.close().catch(() => {});
      throw new ServiceError(503, 'runtime_stopped', 'The browser environment has stopped. Create a new session.');
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
