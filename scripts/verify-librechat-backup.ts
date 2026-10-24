import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { availableMiB, command, deployment, privateFile, root, saveReport } from './librechat-ops.js';

export function backupName(args: string[]) {
  if (args.length !== 2 || args[0] !== '--run' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(args[1])) throw new Error('invalid_arguments');
  return args[1];
}

// stdin is an already opened private archive; no host paths or database sockets
// are mounted. mongorestore output can contain user data and is never printed.
async function restore(container: string, fd: number) {
  await new Promise<void>((resolve, reject) => {
    let diagnostic = '';
    const child = spawn('docker', ['exec', '-i', container, 'mongorestore', '--archive', '--gzip', '--stopOnError',
      '--nsInclude=LibreChatBrowserDemo.*', '--nsFrom=LibreChatBrowserDemo.*', '--nsTo=restore_verification.*'],
    { stdio: [fd, 'ignore', 'pipe'] });
    child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-16384); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('restore_failed')); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) { resolve(); return; }
      // Classify known failures without returning raw tool output (which may
      // include document values, collection names, or other private metadata).
      const reasons: [RegExp, string][] = [
        [/read.only file system|permission denied/i, 'restore_filesystem'],
        [/invalid.*header|not a.*archive|unexpected EOF|gzip|corrupt/i, 'restore_archive_format'],
        [/connection refused|server selection|connect to server/i, 'restore_connection'],
        [/unknown option|unrecognized option|error parsing command line/i, 'restore_arguments'],
        [/duplicate key|E11000/i, 'restore_duplicate_key'],
        [/out of memory|cannot allocate|resource temporarily unavailable/i, 'restore_resources'],
        [/OutOfDiskSpace|no space left/i, 'restore_disk_space'],
      ];
      reject(new Error(reasons.find(([pattern]) => pattern.test(diagnostic))?.[1] ?? 'restore_failed'));
    });
  });
}

export async function main() {
  if (process.argv.length === 2 || process.argv.includes('--help')) {
    console.log('Usage: npm run verify:librechat-backup -- --run BACKUP_DIRECTORY_NAME\nReads an existing .deployment/librechat/backups archive; restores only into a temporary, network-isolated Mongo container, then removes it.');
    return;
  }
  const name = backupName(process.argv.slice(2));
  const backup = join(deployment, 'backups', name);
  if (await realpath(backup) !== backup) throw new Error('unsafe_backup');
  const path = join(backup, 'production-mongo.archive.gz');
  const bytes = await privateFile(path);
  // This drill intentionally bounds the local demo archive size/resources.
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) throw new Error('archive_size');
  const archiveSHA256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.parse((await privateFile(join(backup, 'manifest.json'))).toString());
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('backup_time');
  const compose = await readFile(join(root, 'deploy/librechat/compose.infrastructure.yaml'), 'utf8');
  const image = /^\s+image: (mongo:[\w.-]+@sha256:[a-f0-9]{64})\s*$/m.exec(compose)?.[1];
  if (!image) throw new Error('unpinned_image');
  await command('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
  if (await availableMiB() < 4096) throw new Error('memory_reserve');

  const runId = randomUUID();
  const container = `librechat-restore-${runId}`;
  const label = `dev.agentic-browser.restore-check=${runId}`;
  const startedAt = new Date().toISOString();
  const checks: string[] = [];
  let phase = 'create_container';
  let passed = false;
  let failureCode = 'verification_failed';
  let collections = 0;
  let documents = 0;
  let stopped = false;
  const interrupted = () => { stopped = true; };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  const guard = async () => {
    if (stopped || await availableMiB() < 3072) throw new Error('guard_stopped');
  };
  let cleanup = { passed: false, remainingContainers: -1 };
  try {
    await command('docker', ['run', '--detach', '--pull=never', '--name', container, '--label', label,
      '--network=none', '--read-only', '--user=999:999', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--memory=1g', '--memory-swap=1g', '--cpus=0.5', '--pids-limit=128', '--log-driver=none',
      '--tmpfs=/data/db:rw,nosuid,nodev,size=2g,uid=999,gid=999,mode=0700',
      '--tmpfs=/data/configdb:rw,nosuid,nodev,size=16m,uid=999,gid=999,mode=0700',
      '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m', '--env=HOME=/tmp', '--env=MONGOSH_DISABLE_TELEMETRY=1',
      image, 'mongod', '--bind_ip', '127.0.0.1', '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'ttlMonitorEnabled=false', '--quiet'], 15000);
    const topology = JSON.parse(await command('docker', ['inspect', container, '--format', '{{json .HostConfig}}']));
    if (topology.NetworkMode !== 'none' || Object.keys(topology.PortBindings ?? {}).length || topology.Binds?.length) throw new Error('isolation_failed');
    checks.push('no_network_ports_or_host_bind_mounts');
    phase = 'wait_for_mongo';
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      await guard();
      try { ready = await command('docker', ['exec', container, 'mongosh', '--quiet', '--eval', 'print(db.adminCommand({ping:1}).ok)']) === '1'; }
      catch { /* Container startup is bounded; raw logs remain unexposed. */ }
      if (ready) break;
      await delay(1000);
    }
    if (!ready) throw new Error('mongo_not_ready');
    phase = 'restore_archive';
    await guard();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Recheck the exact bytes to be restored, without leaving the FD at EOF.
      const size = (await handle.stat()).size;
      if (size !== bytes.length) throw new Error('archive_changed');
      const current = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(current, offset, size - offset, offset);
        if (!bytesRead) throw new Error('archive_changed');
        offset += bytesRead;
      }
      if (createHash('sha256').update(current).digest('hex') !== archiveSHA256) throw new Error('archive_changed');
      await restore(container, handle.fd);
    } finally { await handle.close(); }
    checks.push('mongorestore_succeeded');
    phase = 'validate_restored_collections';
    await guard();
    const result = JSON.parse(await command('docker', ['exec', container, 'mongosh', '--quiet', '--eval', `
      const target = db.getSiblingDB('restore_verification');
      const names = target.getCollectionNames();
      let documents = 0;
      let valid = names.length > 0;
      for (const name of names) {
        const result = target.runCommand({validate:name, full:true});
        valid = valid && result.ok === 1 && result.valid === true;
        documents += target.getCollection(name).countDocuments({});
      }
      const users = names.includes('users') && target.users.countDocuments({}) > 0;
      const sourceAbsent = db.getSiblingDB('LibreChatBrowserDemo').getCollectionNames().length === 0;
      print(JSON.stringify({valid, users, sourceAbsent, collections:names.length, documents}));
    `], 30000));
    if (!result.valid || !result.users || !result.sourceAbsent) throw new Error('validation_failed');
    collections = Number(result.collections);
    documents = Number(result.documents);
    checks.push('collections_and_indexes_valid', 'restored_users_present', 'only_remapped_database_created');
    // Changes while restoring invalidate the evidence even if Mongo accepted it.
    if (createHash('sha256').update(await privateFile(path)).digest('hex') !== archiveSHA256) throw new Error('archive_changed');
    await guard();
    passed = true;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (/^restore_(filesystem|archive_format|connection|arguments|duplicate_key|resources|disk_space|failed)$/.test(code)) failureCode = code;
  }
  finally {
    try {
      const ids = (await command('docker', ['ps', '-aq', '--filter', `label=${label}`])).split('\n').filter(Boolean);
      for (const id of ids) {
        const owner = await command('docker', ['inspect', id, '--format', '{{index .Config.Labels "dev.agentic-browser.restore-check"}}']);
        if (owner !== runId) throw new Error('cleanup_owner_mismatch');
        await command('docker', ['rm', '--force', '--volumes', id], 15000);
      }
      const remaining = await command('docker', ['ps', '-aq', '--filter', `label=${label}`]);
      cleanup = { passed: remaining === '', remainingContainers: remaining ? remaining.split('\n').length : 0 };
    } catch { passed = false; }
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
  const report = {
    startedAt, completedAt: new Date().toISOString(), passed: passed && cleanup.passed, checks, cleanup,
    archiveSHA256, backupCreatedAt: new Date(manifest.createdAt).toISOString(), collections, documents,
    ...(passed ? {} : { failedPhase: phase, failureCode }), ...(cleanup.passed ? {} : { recoveryContainer: container }),
    scope: 'Existing Mongo archive restored and validated in a disposable network-isolated container. No production writes. Does not prove archive freshness, cross-service consistency, secret backup, Redis/browser recovery, or full application recovery. No jobs are resumed.',
  };
  await saveReport(`backup-restore-${runId}.json`, report);
  await saveReport('backup-restore-latest.json', report);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch(() => { console.error('Backup verification preflight failed; no secret-bearing error details were emitted.'); process.exitCode = 2; });
}
