import fs from 'node:fs';
import path from 'node:path';
import { id } from './lib/system.mjs';
import * as ctl from './agentctl.mjs';
export const POLICY = 'agentic-browser-backup-policy-v1';
const NAME = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
export function validate(value, root, configDirectory = path.join(root, 'config')) {
  if (Object.keys(value).sort().join(',') !== 'copyTo,hour,keep,kind,retryMinutes,timeZone' || value.kind !== POLICY) throw new ctl.Failure('invalid_backup_policy');
  for (const [key, low, high] of [['hour', 0, 23], ['keep', 1, 365], ['retryMinutes', 1, 1440]]) if (!Number.isInteger(value[key]) || value[key] < low || value[key] > high) throw new ctl.Failure('invalid_backup_policy');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(); } catch { throw new ctl.Failure('invalid_backup_timezone'); }
  if (typeof value.timeZone !== 'string') throw new ctl.Failure('invalid_backup_timezone');
  if (value.copyTo !== null) {
    const dest = value.copyTo;
    if (typeof dest !== 'string' || !path.isAbsolute(dest) || fs.realpathSync(dest) !== dest || [root, configDirectory].some(source => dest === source || dest.startsWith(source + path.sep) || source.startsWith(dest + path.sep))) throw new ctl.Failure('backup_copy_requires_separate_absolute_directory');
  }
  return value;
}
export function status(install) {
  const policy = path.join(install.configDirectory, 'backup.json'), state = path.join(install.root, 'state/backup-status.json');
  return { configured: ctl.exists(policy), policy: ctl.exists(policy) ? validate(ctl.readPrivate(policy), install.root, install.configDirectory) : null, state: ctl.exists(state) ? ctl.readPrivate(state) : {}, maintenancePending: ctl.exists(install.intent) || ctl.exists(install.gate) };
}
export function unitQuote(value) { return JSON.stringify(String(value).replaceAll('%', '%%').replaceAll('$', '$$')); }
export async function configure(install, args) {
  const policy = validate({ kind: POLICY, timeZone: args.timezone ?? 'UTC', hour: Number(args.hour ?? 4), keep: Number(args.keep ?? 7), retryMinutes: Number(args['retry-minutes'] ?? 60), copyTo: args['copy-to'] ? path.resolve(args['copy-to']) : null }, install.root, install.configDirectory);
  if (policy.copyTo) ctl.privatePath(policy.copyTo, true);
  await ctl.installTools(install.root); ctl.atomic(path.join(install.configDirectory, 'backup.json'), policy);
  const units = path.join(install.root, 'state/systemd'); fs.mkdirSync(units, { mode: 0o700, recursive: true }); ctl.privatePath(units, true);
  const name = 'agentic-backup-' + install.meta.project;
  const command = [process.execPath, path.join(install.root, 'agentctl.mjs'), '--directory', install.root, 'maintain'].map(unitQuote).join(' ');
  ctl.atomic(path.join(units, name + '.service'), `[Unit]\nDescription=Private Agent idle backup and recovery\nWants=docker.service\nAfter=docker.service\nRequiresMountsFor=${unitQuote(install.root)} ${unitQuote(install.configDirectory)}\n[Service]\nType=oneshot\nUser=${process.getuid()}\nGroup=${process.getgid()}\nUMask=0077\nExecStart=${command}\nTimeoutStartSec=60min\nTimeoutStopSec=5min\nKillMode=control-group\n`);
  ctl.atomic(path.join(units, name + '.timer'), '[Unit]\nDescription=Check private Agent backup and recovery each minute\n[Timer]\nOnCalendar=*-*-* *:*:00 UTC\nPersistent=true\nRandomizedDelaySec=10\n[Install]\nWantedBy=timers.target\n');
  return { configured: true, unitDirectory: units, timer: name + '.timer', next: 'As a host administrator, link both units with systemctl link and enable --now the timer. The service runs as the installation owner, not root.' };
}
export async function mirror(install, policy, backup) {
  if (!policy.copyTo) return;
  const base = policy.copyTo; ctl.privatePath(base, true);
  if (fs.realpathSync(base) !== base) throw new ctl.Failure('backup_copy_path_changed');
  const target = path.join(base, install.meta.project); fs.mkdirSync(target, { mode: 0o700, recursive: true }); ctl.privatePath(target, true);
  const final = path.join(target, path.basename(backup));
  if (ctl.exists(final)) { await ctl.verifyBackup(final); if (await ctl.digest(path.join(final, 'manifest.json')) !== await ctl.digest(path.join(backup, 'manifest.json'))) throw new ctl.Failure('backup_copy_collision'); return; }
  const pending = path.join(target, '.pending-' + path.basename(backup) + '-' + id());
  try { fs.cpSync(backup, pending, { recursive: true, dereference: false, verbatimSymlinks: true }); await ctl.verifyBackup(pending); fs.renameSync(pending, final); }
  finally { fs.rmSync(pending, { recursive: true, force: true }); }
}
export async function prune(install, policy, state) {
  const names = state.managedBackups ?? [];
  if (!Array.isArray(names) || new Set(names).size !== names.length || names.some(n => typeof n !== 'string' || !NAME.test(n))) throw new ctl.Failure('invalid_managed_backup_list');
  for (const name of names.slice(0, Math.max(0, names.length - policy.keep))) {
    for (const original of [path.join(install.root, 'backups', name), ...(policy.copyTo ? [path.join(policy.copyTo, install.meta.project, name)] : [])]) if (ctl.exists(original)) { await ctl.verifyBackup(original); fs.rmSync(original, { recursive: true }); }
  }
  state.managedBackups = names.slice(-policy.keep);
}
export async function tick(install, now = new Date()) {
  const file = path.join(install.root, 'state/backup-status.json'), state = ctl.exists(file) ? ctl.readPrivate(file) : {};
  function save(status, fields = {}) { Object.assign(state, fields, { status, checkedAt: now.toISOString() }); ctl.atomic(file, state); return { status, ...fields }; }
  try {
    if (ctl.exists(install.intent)) {
      const intent = ctl.readPrivate(install.intent);
      if (intent.kind !== ctl.KIND || intent.operation !== 'backup' || !['drain', 'stopping'].includes(intent.phase)) return save('operator_required');
      await install.recover(); return save('recovered_interrupted_backup');
    }
    if (ctl.exists(install.gate)) return save('operator_required');
    const policyPath = path.join(install.configDirectory, 'backup.json'); if (!ctl.exists(policyPath)) return save('not_configured');
    const policy = validate(ctl.readPrivate(policyPath), install.root, install.configDirectory);
    const local = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: policy.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
    const day = `${local.year}-${local.month}-${local.day}`;
    if (state.lastAttemptAt && now.getTime() < Date.parse(state.lastAttemptAt) + policy.retryMinutes * 60_000) return { status: 'retry_not_due' };
    let backup;
    if (state.copyPending) {
      if (typeof state.copyPending !== 'string' || !NAME.test(state.copyPending)) throw new ctl.Failure('invalid_pending_copy');
      backup = path.join(install.root, 'backups', state.copyPending); await ctl.verifyBackup(backup);
    } else {
      if (state.lastSuccessDay === day || Number(local.hour) < policy.hour) return { status: 'not_due' };
      save('checking_idle', { lastAttemptAt: now.toISOString() }); if (!await install.idle()) return save('deferred_busy');
      backup = await install.backup(); (state.managedBackups ??= []).push(path.basename(backup));
      save('local_backup_completed', { lastSuccessDay: day, lastBackup: path.basename(backup), copyPending: path.basename(backup) });
    }
    save('copying', { lastAttemptAt: now.toISOString() }); await mirror(install, policy, backup); await prune(install, policy, state);
    return save('completed', { copyPending: null, lastCompletedAt: now.toISOString() });
  } catch (error) { save('failed', { lastAttemptAt: now.toISOString(), failureCode: error instanceof ctl.Failure ? error.message.split(';')[0] : 'filesystem_or_configuration_error' }); throw new ctl.Failure('maintenance_failed; inspect private state and service readiness'); }
}
