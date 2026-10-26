import type { BrowserAction } from "./api/actions.js";
export { actionSchema, webUrl } from "./api/actions.js";
export type { BrowserAction } from "./api/actions.js";
import type { Duplex } from "node:stream";

export class ServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Actor = "agent" | "human";
export type ControlState = Actor | "switching" | "closed";

export interface BrowserWorkspace {
  readonly transport?: "desktop";
  readonly runtime?: { id: string; state: 'allocating' | 'ready' | 'closing' | 'cleanup_pending' | 'closed' };
  setControl?(actor: Actor): Promise<void>;
  revokeHumanInput?(): void;
  openDesktop?(): Duplex;
  perform(action: BrowserAction): Promise<unknown>;
  screenshot(maskPasswords?: boolean): Promise<Buffer>;
  close(): Promise<void>;
}

export interface BrowserEngine {
  create(options?: { ownerId?: string }): Promise<BrowserWorkspace>;
  close(): Promise<void>;
}

// A failed launch can still own resources if cleanup failed. The scheduler must
// keep its reservation until this workspace is confirmed closed.
export class BrowserAllocationError extends Error {
  constructor(readonly workspace: BrowserWorkspace) {
    super('Browser startup failed and cleanup is pending');
  }
}
