import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { DockerEngine } from './docker-runtime.js';
import { SchedulerStore } from './scheduling/store.js';
import { BrowserService } from './scheduling/service.js';
import { ViewerGrants } from './streaming/grants.js';
import { createControlServer } from './api/server.js';
import { createDataServer } from './streaming/server.js';

const envPath = process.env.BROWSER_ENV_FILE ?? '.deployment/librechat/private.env';
if (existsSync(envPath)) process.loadEnvFile(envPath);
if (process.env.BROWSER_SERVICE_TOKEN_FILE) {
  try { process.env.BROWSER_SERVICE_TOKEN = readFileSync(process.env.BROWSER_SERVICE_TOKEN_FILE, 'utf8').trim(); }
  catch { console.error('Browser service credential file is not readable.'); process.exit(1); }
}
const parsed = z.object({
  BROWSER_SERVICE_TOKEN: z.string().min(32),
  BROWSER_CONTROL_HOST: z.string().default('127.0.0.1'),
  BROWSER_CONTROL_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  BROWSER_DATA_HOST: z.string().default('127.0.0.1'),
  BROWSER_DATA_PORT: z.coerce.number().int().min(1).max(65535).default(8082),
  DOMAIN_CLIENT: z.string().url(),
  BROWSER_DATA_DIR: z.string().default('.data/librechat-browser'),
  BROWSER_DATA_VOLUME: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/).optional(),
  BROWSER_RUNTIME_IMAGE: z.string().min(1),
  BROWSER_MAX_SESSIONS: z.coerce.number().int().min(1).max(10).default(10),
  BROWSER_MAX_QUEUED: z.coerce.number().int().min(1).max(1000).default(100),
  BROWSER_SESSION_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(300),
  BROWSER_QUEUE_TTL_SECONDS: z.coerce.number().int().min(30).max(1800).default(600),
  BROWSER_RECORD_RETENTION_HOURS: z.coerce.number().int().min(24).max(720).default(24),
}).safeParse(process.env);
if (!parsed.success) { console.error('Invalid Browser Service configuration. Check required service token, runtime image, domain, limits and listener ports.'); process.exit(1); }
const config = parsed.data;
const engine = new DockerEngine({ dataDirectory: config.BROWSER_DATA_DIR, image: config.BROWSER_RUNTIME_IMAGE,
  ...(config.BROWSER_DATA_VOLUME ? { volume: { name: config.BROWSER_DATA_VOLUME, root: config.BROWSER_DATA_DIR } } : {}),
  network: 'public', denyHosts: [new URL(config.DOMAIN_CLIENT).hostname] });
try { await engine.initialize(); }
catch { console.error('Runtime initialization failed; old resource records were retained.'); process.exit(1); }
const store = new SchedulerStore(join(config.BROWSER_DATA_DIR, 'scheduler.sqlite'), config.BROWSER_MAX_SESSIONS);
// initialize() confirms old runtimes are gone before their persistent slots are released.
store.recover();
const service = new BrowserService(store, engine, { ttlMs: config.BROWSER_SESSION_TTL_SECONDS * 1000,
  maxLifetimeMs: 600000, queueTtlMs: config.BROWSER_QUEUE_TTL_SECONDS * 1000, maxQueued: config.BROWSER_MAX_QUEUED });
const grants = new ViewerGrants();
const control = createControlServer(service, grants, config.BROWSER_SERVICE_TOKEN);
const data = createDataServer(service, grants, config.DOMAIN_CLIENT);
const timer = setInterval(() => { void service.tick().catch(() => { console.error('Browser maintenance failed; capacity remains reserved.'); }); }, 1000).unref();
const historyTimer = setInterval(() => {
  try { store.prune(config.BROWSER_RECORD_RETENTION_HOURS * 3600000); }
  catch { console.error('Browser history cleanup failed; records retained.'); }
}, 60000).unref();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true; clearInterval(timer); clearInterval(historyTimer);
  control.close(); data.closeViewers(); data.close();
  await service.close(); control.closeAllConnections(); data.closeAllConnections();
}
for (const server of [control, data]) server.on('error', () => { process.exitCode = 1; void shutdown().catch(() => { console.error('Cleanup pending; persistent records retained.'); }); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown().catch(() => { process.exitCode = 1; console.error('Cleanup pending; persistent records retained.'); }); });
control.listen(config.BROWSER_CONTROL_PORT, config.BROWSER_CONTROL_HOST);
data.listen(config.BROWSER_DATA_PORT, config.BROWSER_DATA_HOST);
