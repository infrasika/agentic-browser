import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { availableMiB, command, deployment, exitCode, privateFile, probe, root, saveReport, type Check } from './librechat-ops.js';

const occupied = "'starting','active','closing','cleanup_pending'";

// A read transaction gives one consistent WAL snapshot. No SchedulerStore or
// DockerEngine is initialized: those constructors have production side effects.
export function ledgerHealth(path: string, maximum: number, queueTtlSeconds = 600, now = Date.now()): Check {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000; BEGIN');
    const integrity = db.prepare('PRAGMA quick_check').get()?.quick_check === 'ok';
    const count = (sql: string, ...params: number[]) => Number(db.prepare(sql).get(...params)?.n ?? 0);
    const metrics = {
      integrity,
      maximum,
      occupied: count(`SELECT COUNT(*) AS n FROM leases WHERE state IN (${occupied})`),
      queued: count("SELECT COUNT(*) AS n FROM leases WHERE state='queued'"),
      cleanupPending: count("SELECT COUNT(*) AS n FROM leases WHERE state='cleanup_pending'"),
      overdue: count(`SELECT COUNT(*) AS n FROM leases WHERE
        (state='queued' AND createdAt < ?) OR
        (state IN (${occupied}) AND expiresAt IS NOT NULL AND expiresAt < ?) OR
        (state='starting' AND updatedAt < ?) OR (state='closing' AND updatedAt < ?)`,
      now - (queueTtlSeconds + 60) * 1000, now - 60000, now - 120000, now - 120000),
      duplicateUsers: count(`SELECT COUNT(*) AS n FROM (SELECT userId FROM leases WHERE state IN ('queued',${occupied}) GROUP BY userId HAVING COUNT(*)>1)`),
      unacknowledgedEvents: count("SELECT COUNT(*) AS n FROM events WHERE id > COALESCE((SELECT cursor FROM consumers WHERE name='librechat'),0)"),
      delayedEvents: count("SELECT COUNT(*) AS n FROM events WHERE id > COALESCE((SELECT cursor FROM consumers WHERE name='librechat'),0) AND createdAt < ?", now - 120000),
    };
    const invalid = !Number.isInteger(maximum) || maximum < 1 || maximum > 10;
    const failed = invalid || !integrity || metrics.occupied > maximum || metrics.duplicateUsers > 0 || metrics.overdue > 0 || metrics.delayedEvents > 0;
    return { name: 'browser_ledger', status: failed ? 'error' : metrics.cleanupPending ? 'warning' : 'ok', metrics };
  } finally { db.close(); }
}

export async function httpHealth(url: string, expected: number, kind: 'json' | 'html' | 'status' = 'status') {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 BrowserDemoHealth/1.0' } });
  try {
    let valid = response.status === expected;
    if (kind === 'json') {
      const data = await response.json() as Record<string, unknown>;
      valid &&= response.headers.get('content-type')?.includes('application/json') === true && data !== null && typeof data === 'object' && !Array.isArray(data);
      if (url.endsWith('/health')) valid &&= data.status === 'ok';
    } else if (kind === 'html') {
      valid &&= response.headers.get('content-type')?.includes('text/html') === true;
    }
    return { status: valid ? 'ok' as const : 'error' as const, metrics: { httpStatus: response.status } };
  } finally { if (!response.bodyUsed) await response.body?.cancel(); }
}

export async function backupHealth(directory: string, verificationPath: string, now = Date.now()): Promise<Check[]> {
  const candidates: { createdAt: number; archive: string; private: boolean }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const backup = join(directory, entry.name);
    try {
      // Agent-only dumps and frontend bundles are deliberately not data backups.
      const archive = join(backup, 'production-mongo.archive.gz');
      const info = await lstat(archive);
      const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
      const createdAt = Date.parse(manifest.createdAt);
      if (!info.isFile() || info.isSymbolicLink() || !info.size || !Number.isFinite(createdAt) || createdAt > now) continue;
      candidates.push({ createdAt, archive, private: (info.mode & 0o077) === 0 && ((await lstat(backup)).mode & 0o077) === 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  candidates.sort((a, b) => b.createdAt - a.createdAt);
  const latest = candidates[0];
  if (!latest) return [{ name: 'data_backup', status: 'warning', metrics: { found: false } }, { name: 'backup_restore', status: 'warning', metrics: { verified: false } }];
  const ageHours = Math.round((now - latest.createdAt) / 3600000 * 10) / 10;
  let verified = false;
  try {
    const evidence = JSON.parse(await readFile(verificationPath, 'utf8'));
    const hash = createHash('sha256').update(await privateFile(latest.archive)).digest('hex');
    verified = evidence.passed === true && evidence.cleanup?.passed === true && evidence.archiveSHA256 === hash;
  } catch { /* Missing or mismatched evidence is a warning, never assumed success. */ }
  return [
    { name: 'data_backup', status: !latest.private ? 'error' : ageHours > 24 ? 'warning' : 'ok', metrics: { found: true, ageHours, private: latest.private } },
    { name: 'backup_restore', status: verified ? 'ok' : 'warning', metrics: { verified } },
  ];
}

export async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run health:librechat\nRead-only probes; no accounts, browsers or model calls. Exit 0=healthy, 1=warning, 2=error.');
    return;
  }
  if (process.argv.length !== 2) throw new Error('invalid_arguments');
  const startedAt = new Date().toISOString();
  const checks: Check[] = [];
  let maximum = 0;
  let queueTtlSeconds = 600;
  checks.push(await probe('private_configuration', async () => {
    const directory = await lstat(deployment);
    const config = parseEnv((await privateFile(join(deployment, 'private.env'))).toString());
    maximum = Number(config.BROWSER_MAX_SESSIONS ?? 5);
    queueTtlSeconds = Number(config.BROWSER_QUEUE_TTL_SECONDS ?? 600);
    const production = JSON.parse((await privateFile(join(deployment, 'production.yaml'))).toString());
    const valid = directory.isDirectory() && (directory.mode & 0o077) === 0 && Number.isInteger(maximum) && maximum >= 1 && maximum <= 10 &&
      Number.isInteger(queueTtlSeconds) && queueTtlSeconds >= 30 && queueTtlSeconds <= 1800 &&
      production.turnstile?.verification?.required === true && production.turnstile.verification.hostname === 'agentic-browser.zkpass.org' &&
      production.balance?.enabled === true && production.balance.autoRefillEnabled === false;
    return { status: valid ? 'ok' : 'error', metrics: { maximum } };
  }));
  const probes: Promise<Check>[] = ['agentic-browser-service', 'librechat-browser-demo'].map(name => probe(name, async () => {
    const state = Object.fromEntries((await command('systemctl', ['show', name, '--property=ActiveState,SubState,MainPID,NRestarts'])).split('\n').map(line => line.split('=')));
    let healthy = state.ActiveState === 'active' && state.SubState === 'running' && Number(state.MainPID) > 0;
    let runningMaximum = 0;
    if (name === 'agentic-browser-service' && healthy) {
      const environment = (await readFile(`/proc/${Number(state.MainPID)}/environ`, 'utf8')).split('\0');
      runningMaximum = Number(environment.find(value => value.startsWith('BROWSER_MAX_SESSIONS='))?.slice('BROWSER_MAX_SESSIONS='.length));
      healthy &&= runningMaximum === maximum;
    }
    return { status: healthy ? 'ok' : 'error', metrics: { restarts: Number(state.NRestarts), ...(name === 'agentic-browser-service' ? { runningMaximum } : {}) } };
  }));
  for (const [name, url, expected, kind] of [
    ['librechat_http', 'http://127.0.0.1:3080/api/config', 200, 'json'],
    ['browser_control_http', 'http://127.0.0.1:8081/health', 200, 'json'],
    ['browser_data_http', 'http://127.0.0.1:8082/health', 200, 'json'],
    ['public_home', 'https://agentic-browser.zkpass.org/', 200, 'html'],
    ['public_mcp_closed', 'https://agentic-browser.zkpass.org/mcp', 404, 'status'],
    ['public_control_closed', 'https://agentic-browser.zkpass.org/internal/v1/leases', 404, 'status'],
    ['public_anonymous_retired', 'https://agentic-browser.zkpass.org/connect', 410, 'status'],
  ] as const) probes.push(probe(name, () => httpHealth(url, expected, kind)));
  probes.push(probe('mongo', async () => ({ status: await command('docker', ['exec', 'librechat-browser-demo-mongo-1', 'mongosh', '--quiet', '--eval', "print(db.adminCommand({ping:1}).ok)"]) === '1' ? 'ok' : 'error' })));
  probes.push(probe('redis', async () => ({ status: await command('docker', ['exec', 'librechat-browser-demo-redis-1', 'redis-cli', 'ping']) === 'PONG' ? 'ok' : 'error' })));
  probes.push(probe('browser_ledger', async () => ledgerHealth(join(root, '.data/librechat-browser/scheduler.sqlite'), maximum, queueTtlSeconds)));
  probes.push(probe('host_resources', async () => {
    const disk = await statfs(root);
    const availableMemoryMiB = await availableMiB();
    const availableDiskMiB = Math.floor(disk.bavail * disk.bsize / 1048576);
    return { status: availableDiskMiB < 1024 || availableMemoryMiB < 1024 ? 'error' : availableDiskMiB < 5120 || availableMemoryMiB < 3072 ? 'warning' : 'ok', metrics: { availableMemoryMiB, availableDiskMiB } };
  }));
  checks.push(...await Promise.all(probes));
  try { checks.push(...await backupHealth(join(deployment, 'backups'), join(root, 'output/librechat/backup-restore-latest.json'))); }
  catch { checks.push({ name: 'data_backup', status: 'error' }); }
  const code = exitCode(checks);
  const report = {
    startedAt, completedAt: new Date().toISOString(), status: ['healthy', 'warning', 'error'][code], checks,
    scope: 'Read-only liveness/configuration/queue/storage checks. Does not verify Qwen, Turnstile success, browser execution or a full disaster recovery. Backup recovery evidence applies only to the matching Mongo archive.',
  };
  await saveReport('health-latest.json', report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch(() => { console.error('Health check failed; no secret-bearing error details were emitted.'); process.exitCode = 2; });
}
