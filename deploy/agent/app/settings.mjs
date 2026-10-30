import { z } from 'zod';

const safeOrigin = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === '/' && /^[a-zA-Z0-9.:[\]-]+$/.test(url.host) &&
    (url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}, 'Use HTTPS, or HTTP on loopback only');
const endpoint = z.string().url().refine(value => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});
export const settingsSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(100).default('Agentic Browser'),
  origin: safeOrigin,
  trustedProxyIPs: z.array(z.string().ip()).max(8).default([]),
  adminEmail: z.string().email(),
  registration: z.enum(['closed', 'public']).default('closed'),
  turnstileSiteKey: z.string().default(''),
  model: z.object({
    name: z.string().min(1), baseURL: endpoint,
    promptRate: z.number().nonnegative(), completionRate: z.number().nonnegative(),
  }).strict(),
  credits: z.object({
    initial: z.number().int().nonnegative().max(1e9).default(200000),
    daily: z.number().int().nonnegative().max(1e12).default(20000000),
    timeZone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }).default('Asia/Shanghai'),
  }).strict(),
  browser: z.object({ maximum: z.number().int().min(1).max(10).default(1) }).strict(),
  smtp: z.object({
    host: z.string().regex(/^[a-zA-Z0-9.-]+$/), port: z.number().int().min(1).max(65535),
    encryption: z.enum(['tls', 'starttls']), from: z.string().email(),
    username: z.string().default(''),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.registration === 'public' && (!value.turnstileSiteKey || !value.origin.startsWith('https://'))) {
    ctx.addIssue({ code: 'custom', path: ['registration'], message: 'Public registration requires HTTPS and Turnstile' });
  }
});
export const secretsSchema = z.object({
  QWEN_API_KEY: z.string().min(1),
  DEMO_ADMIN_PASSWORD: z.string().min(12).max(256),
  JWT_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
  JWT_REFRESH_SECRET: z.string().regex(/^[a-f0-9]{64}$/),
  CREDS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  CREDS_IV: z.string().regex(/^[a-f0-9]{32}$/),
  TURNSTILE_SECRET_KEY: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
}).strict();
export function validateSettings(settings, secrets) {
  const config = settingsSchema.parse(settings), credentials = secretsSchema.parse(secrets);
  if (Boolean(config.turnstileSiteKey) !== Boolean(credentials.TURNSTILE_SECRET_KEY)) throw new Error('Both Turnstile keys are required together');
  if (config.smtp && Boolean(config.smtp.username) !== Boolean(credentials.SMTP_PASSWORD)) throw new Error('Both SMTP credentials are required together');
  return { config, credentials };
}
