import { z } from "zod";
import { webUrl } from "./api/actions.js";
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

export type SessionCapacity = {
  currentSessions: number;
  maxSessions: number;
  availableSessions: number;
  full: boolean;
};

export class SessionCapacityError extends ServiceError {
  readonly retryAfterSeconds = 30;
  constructor(readonly capacity: SessionCapacity, readonly source?: { currentSessions: number; maxSessions: number }) {
    const total = `Current total sessions ${capacity.currentSessions} / ${capacity.maxSessions} (including sessions starting or being cleaned up)`;
    super(429, source ? 'source_limit' : 'session_limit', source
      ? `This network has reached its concurrent browser limit (${source.currentSessions} / ${source.maxSessions}). ${total}. Close your own idle sessions or try again later (suggested wait: 30 seconds).`
      : `All browser slots are in use. ${total}. Please try again later (suggested wait: 30 seconds; availability is not guaranteed).`);
  }
  payload() {
    return { error: this.code, status: this.status, message: this.message, userMessage: this.message,
      capacity: this.capacity, retryAfterSeconds: this.retryAfterSeconds,
      ...(this.source ? { sourceCapacity: this.source } : {}) };
  }
}

export type Actor = "agent" | "human";
export type ControlState = Actor | "switching" | "closed";

export interface BrowserWorkspace {
  readonly transport?: "desktop";
  readonly profile?: { id: string; name: string };
  readonly runtime?: { id: string; state: 'allocating' | 'ready' | 'closing' | 'cleanup_pending' | 'closed' };
  setControl?(actor: Actor): Promise<void>;
  revokeHumanInput?(): void;
  openDesktop?(): Duplex;
  perform(action: BrowserAction): Promise<unknown>;
  screenshot(maskPasswords?: boolean): Promise<Buffer>;
  close(): Promise<void>;
}

export interface BrowserEngine {
  readonly profiles?: import("./profiles.js").ProfileStore;
  create(options?: { profileId?: string; ownerId?: string }): Promise<BrowserWorkspace>;
  close(): Promise<void>;
}

// A failed launch can still own resources if cleanup failed. The registry must
// keep its reservation until this workspace is confirmed closed.
export class BrowserAllocationError extends Error {
  constructor(readonly workspace: BrowserWorkspace) {
    super('Browser startup failed and cleanup is pending');
  }
}

export const createSessionSchema = z
  .object({
    purpose: z.string().trim().min(1).max(300).default("Browser task"),
    url: webUrl.optional(),
    profileId: z.string().uuid().optional(),
  })
  .strict();

export const handoffSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .default("Please complete this step, then return control to the agent."),
  })
  .strict();
