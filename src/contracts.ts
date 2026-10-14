import { z } from "zod";
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

export const webUrl = z
  .string()
  .max(8192)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Use an HTTP(S) URL without embedded credentials");

const selector = z.string().min(1).max(2000);
const coordinate = z.number().finite().min(0).max(10000);
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: webUrl }).strict(),
  z.object({ type: z.literal("click"), selector }).strict(),
  z
    .object({ type: z.literal("pointer"), x: coordinate, y: coordinate })
    .strict(),
  z
    .object({ type: z.literal("fill"), selector, text: z.string().max(16000) })
    .strict(),
  z.object({ type: z.literal("type"), text: z.string().max(16000) }).strict(),
  z
    .object({ type: z.literal("press"), key: z.string().min(1).max(80) })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: z.number().finite().min(-5000).max(5000),
      y: z.number().finite().min(-5000).max(5000),
    })
    .strict(),
  z.object({ type: z.literal("back") }).strict(),
  z.object({ type: z.literal("forward") }).strict(),
  z.object({ type: z.literal("reload") }).strict(),
  z.object({ type: z.literal("snapshot") }).strict(),
  z.object({ type: z.literal("tabs") }).strict(),
  z.object({ type: z.literal("selectTab"), tabId: z.string().uuid() }).strict(),
]);
export type BrowserAction = z.infer<typeof actionSchema>;
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
