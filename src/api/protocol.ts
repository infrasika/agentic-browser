import { z } from 'zod';
import { actionSchema, webUrl } from './actions.js';

export const identitySchema = z.string().regex(/^[A-Za-z0-9_:@.-]{1,128}$/);
export const operationIdSchema = z.string().regex(/^[A-Za-z0-9_:-]{1,256}$/);
export const acquireSchema = z.object({
  acquisitionId: operationIdSchema,
  purpose: z.string().trim().min(1).max(300),
  url: webUrl,
}).strict();
export const actionRequestSchema = z.object({
  operationId: operationIdSchema, revision: z.number().int().nonnegative(), action: actionSchema,
}).strict();
export const controlRequestSchema = z.object({
  operationId: operationIdSchema, revision: z.number().int().nonnegative(),
  target: z.enum(['agent', 'human']), reason: z.string().max(500).default(''),
}).strict();
export const snapshotRequestSchema = z.object({ screenshot: z.boolean().default(false) }).strict();
export const viewerRequestSchema = z.object({ role: z.enum(['observe', 'input']), revision: z.number().int().nonnegative() }).strict();
export const releaseRequestSchema = z.object({ outcome: z.enum(['completed', 'cancelled']).default('cancelled') }).strict();

export const principalSchema = z.object({ userId: identitySchema, conversationId: identitySchema, taskId: identitySchema });
export const leaseSchema = principalSchema.extend({
  id: z.string().uuid(), acquisitionId: operationIdSchema, purpose: z.string(), url: z.string(),
  state: z.enum(['queued', 'starting', 'active', 'closing', 'cleanup_pending', 'completed', 'cancelled', 'failed', 'expired']),
  sessionId: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(), expiresAt: z.number().nullable(),
  revision: z.number().int(), control: z.enum(['agent', 'human', 'switching', 'closed']), error: z.string().nullable(),
  position: z.number().nullable().optional(), capacity: z.object({ occupied: z.number(), maximum: z.number() }).optional(),
});
export const eventSchema = principalSchema.extend({
  id: z.number().int(), leaseId: z.string().uuid(),
  type: z.enum(['slot_ready', 'control_taken', 'control_returned', 'session_ended']),
  revision: z.number().int(), createdAt: z.number(),
});
export const grantSchema = z.object({ grant: z.string(), expiresAt: z.number(), path: z.string() });
export type BrowserPrincipal = z.infer<typeof principalSchema>;
export type BrowserLease = z.infer<typeof leaseSchema>;
export type ResourceEvent = z.infer<typeof eventSchema>;
