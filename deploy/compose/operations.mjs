import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { digest, Failure, operationLock, run, sleep } from '../agent/lib/system.mjs';
import { transferVolume, verifyArchive } from '../agent/lib/archive.mjs';

export const FORMAT = 'agentic-browser-compose-backup-v1';
export const VOLUMES = ['config', 'browser-config', 'gateway-config', 'browser-data', 'mongo-data', 'redis-data', 'uploads', 'images', 'logs'];
const SERVICES = ['mongo', 'redis', 'browser', 'agent', 'gateway'];
const WRITERS = ['agent', 'browser', 'redis', 'mongo'];
const INPUTS = ['compose.yaml', 'settings.json', 'secrets.env'];
const DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock'];
const BROWSER_IDLE = `const fs=require('fs'), db=new(require('node:sqlite').DatabaseSync)('/data/scheduler.sqlite',{readOnly:true});const live=db.prepare("SELECT COUNT(*) n FROM leases WHERE state IN ('queued','starting','active','closing','cleanup_pending')").get().n;const events=db.prepare("SELECT COUNT(*) n FROM events WHERE id>COALESCE((SELECT cursor FROM consumers WHERE name='librechat'),0)").get().n;const records=fs.readdirSync('/data/runtimes').filter(x=>x.endsWith('.json')).length;console.log(JSON.stringify({idle:!live&&!events&&!records}));`;

export function scheduledDay(now, hour, timeZone, lastDay) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Failure('backup_hour_must_be_0_to_23');
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const day = fields.year + '-' + fields.month + '-' + fields.day;
  return Number(fields.hour) >= hour && day !== lastDay ? day : null;
}

export function childPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Failure('use_a_relative_path_inside_the_deployment');
  const file = path.join(root, relative);
  let current = root;
  for (const part of relative.split('/')) { current = path.join(current, part); if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Failure('symlinks_not_allowed'); }
  return file;
}
function plainFile(file) { if (!fs.lstatSync(file).isFile()) throw new Failure('regular_file_required'); }
function readJSON(file) { plainFile(file); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, value, owner) {
  if (fs.existsSync(file)) plainFile(file);
  const temporary = file + '.' + randomUUID();
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); if (owner) fs.fchownSync(fd, owner.uid, owner.gid); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
export async function verifyBackup(directory) {
  const manifest = readJSON(childPath(directory, 'manifest.json'));
  const required = [...INPUTS, ...VOLUMES.map(name => name + '.tar.gz')].sort();
  if (manifest.format !== FORMAT || JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(required)) throw new Failure('invalid_compose_backup_manifest');
  for (const [name, checksum] of Object.entries(manifest.files)) {
    const file = childPath(directory, name); plainFile(file);
    if (!/^[a-f0-9]{64}$/.test(checksum) || await digest(file) !== checksum) throw new Failure('backup_checksum_mismatch');
    if (name.endsWith('.tar.gz')) await verifyArchive(file, name === 'browser-data.tar.gz');
  }
  return manifest;
}

export class ComposeOperations {
  constructor({ directory = '/deployment', input = directory, state = '/state', command = run } = {}) {
    this.root = directory; this.input = input; this.state = state; this.command = command;
    this.owner = fs.statSync(directory); this.gate = path.join(state, 'active');
    this.inputOwner = fs.statSync(input);
    this.private = path.join(state, 'private'); fs.mkdirSync(this.private, { recursive: true, mode: 0o700 });
    this.intent = path.join(this.private, 'operation.json');
  }
  docker(args, options) { return this.command([...DOCKER, ...args], options); }
  async connect() {
    const self = JSON.parse(await this.docker(['inspect', process.env.HOSTNAME]))[0];
    this.project = self.Config.Labels['com.docker.compose.project'];
    if (!['ops', 'backup'].includes(self.Config.Labels['com.docker.compose.service']) || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(this.project)) throw new Failure('run_through_docker_compose_ops');
    this.host = self.Mounts.find(m => m.Type === 'bind' && m.Destination === this.root)?.Source;
    this.inputHost = self.Mounts.find(m => m.Type === 'bind' && m.Destination === this.input)?.Source;
    if ([this.host, this.inputHost].some(value => !value || /[\r\n,]/.test(value))) throw new Failure('deployment_and_configuration_bind_mounts_required');
    process.env.COMPOSE_PROJECT_NAME = this.project;
    this.config = await this.render();
    this.image = this.config.services.agent.image;
    return this;
  }
  async render(file = path.join(this.root, 'compose.yaml')) {
    const args = ['compose', '--project-directory', this.root, '-p', this.project, '-f', file];
    const override = path.join(this.root, 'compose.override.yaml');
    if (fs.existsSync(override)) args.push('-f', override);
    // Keep optional services in the rendered model; otherwise Compose silently
    // drops backup and a later explicit `up backup` cannot recreate it.
    args.push('--profile', '*', 'config', '--format', 'json');
    const config = JSON.parse(await this.docker(args));
    for (const name of [...SERVICES, 'init', 'runtime-image', 'ops', 'backup']) if (!config.services[name]?.image) throw new Failure('unsupported_compose_release');
    for (const name of [...SERVICES, 'init', 'runtime-image', 'ops', 'backup']) if (!/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(config.services[name].image) && process.env.AGENT_ALLOW_LOCAL_IMAGES !== '1') throw new Failure('immutable_release_images_required');
    for (const name of VOLUMES) {
      const volume = config.volumes[name];
      if (!volume || volume.external || volume.driver_opts || volume.name !== (name === 'browser-data' ? this.project + '-browser' : this.project + '_' + name)) throw new Failure('dedicated_compose_volumes_required');
    }
    // Compose runs inside a container, while bind sources are resolved by the
    // host daemon. Preserve the real project path for every bind source.
    for (const service of Object.values(config.services)) for (const volume of service.volumes ?? []) if (volume.type === 'bind') {
      for (const [source, host] of [[this.input, this.inputHost], [this.root, this.host]]) {
        if (volume.source === source || volume.source.startsWith(source + '/')) { volume.source = host + volume.source.slice(source.length); break; }
      }
    }
    return config;
  }
  async compose(args, config = this.config, options = {}) {
    const file = '/tmp/agent-compose-' + randomUUID() + '.json';
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    try { return await this.docker(['compose', '--project-directory', this.root, '-p', this.project, '-f', file, ...args], { timeout: 360_000, ...options }); }
    finally { fs.rmSync(file, { force: true }); }
  }
  volume(name) { return this.config.volumes[name].name; }
  inputFile(name) { return childPath(name === 'compose.yaml' ? this.root : this.input, name); }
  async backupRunning() {
    const cid = (await this.compose(['ps', '--all', '-q', 'backup'])).trim();
    return Boolean(cid && JSON.parse(await this.docker(['inspect', cid]))[0].State.Running);
  }
  async probe(status = 200) {
    const host = new URL(readJSON(this.inputFile('settings.json')).origin).host;
    await this.compose(['exec', '-T', 'agent', 'node', '-e', `const q=require('http').get('http://gateway:8080/api/config',{headers:{Host:${JSON.stringify(host)}}},r=>{r.resume();process.exit(r.statusCode===${status}${status === 503 ? "&&r.headers['x-agent-maintenance']==='1'" : ''}?0:1)});q.setTimeout(4000,()=>q.destroy());q.on('error',()=>process.exit(1));`]);
  }
  async health(maintenance = false) {
    const raw = await this.compose(['ps', '--all', '--format', 'json']);
    const rows = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').filter(Boolean).map(JSON.parse);
    const byName = Object.fromEntries(rows.map(row => [row.Service, row]));
    if (SERVICES.some(name => byName[name]?.State !== 'running' || name !== 'gateway' && byName[name]?.Health !== 'healthy')) throw new Failure('services_not_healthy');
    for (let n = 0; ; n++) { try { await this.probe(maintenance ? 503 : 200); break; } catch (error) { if (n === 10) throw error; await sleep(1000); } }
    return { healthy: true, maintenance, version: this.config.services.ops.environment.AGENT_RELEASE };
  }
  async idle(drain = false) {
    const browser = JSON.parse(await this.compose(['exec', '-T', '--user', '1000:1000', 'browser', 'node', '-e', BROWSER_IDLE]));
    const agent = JSON.parse(await this.compose(['exec', '-T', 'agent', 'node', '/app/selfhost/idle.mjs']));
    return browser.idle && agent.idle && (!drain || agent.connections === 0);
  }
  pending() { return fs.existsSync(this.intent) ? readJSON(this.intent) : null; }
  requireReady() { if (this.pending() || fs.existsSync(this.gate)) throw new Failure('maintenance_pending; use recover or rollback'); }
  async stop() {
    for (const name of WRITERS) {
      await this.compose(['stop', '-t', '60', name]);
      const cid = await this.compose(['ps', '--all', '-q', name]);
      const state = JSON.parse(await this.docker(['inspect', cid]))[0].State;
      if (state.Running || state.OOMKilled || ![0, 143].includes(state.ExitCode)) throw new Failure('unclean_stop; inspect services before recover');
    }
  }
  async enter(operation) {
    this.requireReady(); await this.health();
    if (!await this.idle()) throw new Failure('busy; finish active tasks before maintenance');
    write(this.intent, { operation, phase: 'drain' }); write(this.gate, 'maintenance\n');
    await this.probe(503);
    for (let n = 0; !await this.idle(true); n++) {
      if (n === 60) { fs.unlinkSync(this.intent); fs.unlinkSync(this.gate); throw new Failure('busy; wait for requests to finish'); }
      await sleep(500);
    }
    write(this.intent, { operation, phase: 'stopping' }); await this.stop();
  }
  async resume({ backup = false } = {}) {
    // The maintenance gate remains visible until all writers and the gateway
    // are healthy. Power loss or an exception never silently opens the site.
    await this.compose(['up', '-d', '--wait', '--wait-timeout', '240', ...SERVICES]);
    if (backup) {
      await this.compose(['up', '-d', '--no-deps', 'backup']);
      if (!await this.backupRunning()) throw new Failure('backup_service_not_running');
    }
    await this.health(true); fs.rmSync(this.gate, { force: true });
    try { await this.health(); } catch (error) { write(this.gate, 'maintenance\n'); throw error; }
    fs.rmSync(this.intent, { force: true }); return { status: 'recovered' };
  }
  async recover() {
    const intent = this.pending();
    if (!intent) { this.requireReady(); return this.health(); }
    if (!['drain', 'stopping', 'backup', 'restored'].includes(intent.phase)) throw new Failure('unsafe_to_restart; use rollback or restore a verified backup');
    const helpers = (await this.docker(['ps', '-aq', '--filter', 'label=dev.agentic-browser.operation=' + this.project])).split(/\s+/).filter(Boolean);
    if (helpers.length) await this.docker(['rm', '-f', ...helpers]);
    const result = await this.resume({ backup: intent.phase === 'restored' && intent.backupEnabled });
    if (/^backups\/\.pending-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(intent.partial ?? '')) fs.rmSync(childPath(this.root, intent.partial), { recursive: true, force: true });
    return result;
  }
  async archive() {
    const parent = path.join(this.root, 'backups'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.chownSync(parent, this.owner.uid, this.owner.gid);
    const name = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + randomUUID().slice(0, 8);
    const temporary = path.join(parent, '.pending-' + name), destination = path.join(parent, name);
    fs.mkdirSync(temporary, { mode: 0o700 });
    write(this.intent, { ...this.pending(), partial: 'backups/.pending-' + name });
    for (const file of INPUTS) { const source = this.inputFile(file); plainFile(source); write(path.join(temporary, file), fs.readFileSync(source)); }
    for (const volume of VOLUMES) await transferVolume(this.image, this.volume(volume), this.project, path.join(temporary, volume + '.tar.gz'));
    const files = {};
    for (const file of fs.readdirSync(temporary)) files[file] = await digest(path.join(temporary, file));
    write(path.join(temporary, 'manifest.json'), { format: FORMAT, createdAt: new Date().toISOString(), version: this.config.services.ops.environment.AGENT_RELEASE, files });
    await verifyBackup(temporary);
    for (const file of fs.readdirSync(temporary)) fs.chownSync(path.join(temporary, file), this.owner.uid, this.owner.gid);
    fs.chownSync(temporary, this.owner.uid, this.owner.gid); fs.renameSync(temporary, destination);
    return 'backups/' + name;
  }
  async backup({ stay = false, keep } = {}) {
    await this.enter('backup'); write(this.intent, { operation: 'backup', phase: 'backup' });
    let backup;
    try { backup = await this.archive(); }
    finally { if (!stay || !backup) await this.recover(); }
    if (keep !== undefined) await this.prune(keep);
    return { status: 'backed_up', backup };
  }
  async prune(keep) {
    if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Failure('keep_must_be_1_to_365');
    const parent = path.join(this.root, 'backups');
    const names = fs.readdirSync(parent).filter(name => /^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) { const folder = childPath(parent, name); await verifyBackup(folder); fs.rmSync(folder, { recursive: true }); }
  }
  async pull(config) {
    for (const image of new Set(Object.values(config.services).map(s => s.image))) {
      if (!image) throw new Failure('builds_not_supported_in_release');
      if (image.includes('@sha256:')) await this.docker(['pull', image], { timeout: 900_000 });
      const info = JSON.parse(await this.docker(['image', 'inspect', image]))[0];
      if (info.Os !== 'linux' || info.Architecture !== (process.arch === 'arm64' ? 'arm64' : 'amd64')) throw new Failure('image_platform_mismatch');
    }
  }
  async upgrade(relative) {
    this.requireReady(); const file = childPath(this.root, relative); plainFile(file);
    const target = await this.render(file); await this.pull(target);
    const backupEnabled = await this.backupRunning();
    const { backup } = await this.backup({ stay: true });
    write(this.intent, { operation: 'upgrade', phase: 'upgrading', backup, backupEnabled });
    try {
      write(path.join(this.root, 'compose.yaml'), fs.readFileSync(file), this.owner); this.config = target; this.image = target.services.agent.image;
      await this.compose(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '240', ...SERVICES]);
      await this.resume({ backup: backupEnabled });
      return { status: 'upgraded', backup, version: target.services.ops.environment.AGENT_RELEASE };
    } catch { write(this.gate, 'maintenance\n'); write(this.intent, { operation: 'upgrade', phase: 'upgrade_failed', backup, backupEnabled }); throw new Failure('upgrade_failed; maintenance retained; run ops rollback'); }
  }
  async restore(relative, replace = false) {
    const folder = childPath(this.root, relative); await verifyBackup(folder);
    const target = await this.render(path.join(folder, 'compose.yaml')); await this.pull(target);
    const containers = (await this.docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + this.project, '--filter', 'label=com.docker.compose.oneoff=False'])).trim();
    const existing = await this.docker(['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + this.project]);
    if (!replace && (containers || VOLUMES.some(n => existing.split('\n').includes(this.volume(n))))) throw new Failure('restore_requires_fresh_project; explicit --replace overwrites current data');
    const backupEnabled = this.pending()?.backupEnabled ?? await this.backupRunning();
    if (replace && !this.pending()) await this.enter('restore');
    write(this.gate, 'maintenance\n'); write(this.intent, { operation: 'restore', phase: 'restoring', backup: relative, backupEnabled });
    // Remove the old containers, never the ops container or its state volume.
    await this.compose(['stop', '-t', '60', ...SERVICES]);
    await this.compose(['rm', '-f', 'init', 'runtime-image', ...SERVICES]);
    for (const name of VOLUMES) {
      const volume = this.volume(name);
      const exists = await this.docker(['volume', 'ls', '-q', '--filter', 'name=^' + volume + '$']);
      if (exists.trim()) await this.docker(['volume', 'rm', volume]);
    }
    for (const file of INPUTS) write(this.inputFile(file), fs.readFileSync(path.join(folder, file)), file === 'compose.yaml' ? this.owner : this.inputOwner);
    this.config = target; this.image = target.services.agent.image;
    await this.compose(['create', 'init', 'runtime-image', ...SERVICES]);
    for (const volume of VOLUMES) await transferVolume(this.image, this.volume(volume), this.project, path.join(folder, volume + '.tar.gz'), true);
    await this.docker(['run', '--rm', '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--mount', 'type=volume,src=' + this.volume('browser-data') + ',dst=/volume', '--entrypoint=node', this.image, '-e', "require('fs').writeFileSync('/volume/runtimes/instance-id',require('crypto').randomUUID(),{mode:0o600})"]);
    write(this.intent, { operation: 'restore', phase: 'restored', backup: relative, backupEnabled });
    return { status: 'restored_stopped', next: 'Review settings.json and secrets.env, then run ops recover. Target project name and port come from its own .env.' };
  }
  async rollback() {
    const intent = this.pending();
    if (intent?.operation !== 'upgrade' || !['upgrading', 'upgrade_failed'].includes(intent.phase) || !intent.backup) throw new Failure('no_failed_upgrade_to_roll_back');
    const restored = await this.restore(intent.backup, true); await this.recover(); return { ...restored, status: 'rolled_back' };
  }
  async operator(action, value) {
    this.requireReady(); await this.health();
    const output = await this.compose(['exec', '-T', 'agent', 'node', '/app/selfhost/operator.mjs', action], this.config, { input: JSON.stringify(value), timeout: 90_000 });
    const line = output.split('\n').find(line => line.startsWith('AGENT_RESULT='));
    if (!line) throw new Failure('operator_result_missing');
    const result = JSON.parse(line.slice(13));
    if (action === 'mail-test') await this.docker(['run', '--rm', '-i', '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL', '--mount', 'type=volume,src=' + this.volume('config') + ',dst=/config', '--entrypoint=node', this.image, '-e', "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').writeFileSync('/config/smtp-verified.json',s,{mode:0o600}));"], { input: JSON.stringify(result) });
    return result;
  }
}

async function watch(ops) {
  const hour = Number(process.env.AGENT_BACKUP_HOUR ?? 4), keep = Number(process.env.AGENT_BACKUP_KEEP ?? 7), zone = process.env.AGENT_BACKUP_TIMEZONE ?? 'Asia/Shanghai';
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Failure('keep_must_be_1_to_365');
  scheduledDay(new Date(), hour, zone);
  const receipt = path.join(ops.private, 'daily-backup.json'), controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
  while (!controller.signal.aborted) {
    let unlock;
    try {
      unlock = await operationLock(path.join(ops.private, 'operation.lock'));
      const previous = fs.existsSync(receipt) ? readJSON(receipt) : {};
      const day = scheduledDay(new Date(), hour, zone, previous.day);
      if (day && !ops.pending() && !fs.existsSync(ops.gate)) {
        ops.config = await ops.render(); ops.image = ops.config.services.agent.image;
        if (await ops.idle()) { const result = await ops.backup({ keep }); write(receipt, { day, completedAt: new Date().toISOString(), backup: result.backup }); console.log(JSON.stringify({ status: 'daily_backup_completed', ...result })); }
      }
    } catch { console.error('Scheduled backup deferred; check ops status and retry when services are healthy and idle.'); }
    finally { if (unlock) await unlock(); }
    await sleep(60_000, undefined, { signal: controller.signal }).catch(() => {});
  }
}

export async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean' }, replace: { type: 'boolean' }, keep: { type: 'string' }, to: { type: 'string' } } });
  const [command, argument] = positionals;
  if (values.help || !command) return console.log('docker compose run --rm ops status|backup [--keep 7]|verify-backup backups/ID|restore backups/ID [--replace]|recover|upgrade releases/VERSION/compose.yaml|rollback|user-create|user-reset|mail-test --to ADDRESS\nAccount commands read private JSON from stdin. Restore keeps maintenance until recover.');
  if (!['status', 'backup', 'verify-backup', 'restore', 'recover', 'upgrade', 'rollback', 'user-create', 'user-reset', 'mail-test', 'watch'].includes(command) || positionals.length > 2) throw new Failure('unknown_command');
  if (['verify-backup', 'restore', 'upgrade'].includes(command) !== Boolean(argument)) throw new Failure('unexpected_or_missing_path');
  if (values.keep !== undefined && (!/^\d+$/.test(values.keep) || +values.keep < 1 || +values.keep > 365)) throw new Failure('keep_must_be_1_to_365');
  const ops = await new ComposeOperations({ input: '/input' }).connect();
  if (command === 'watch') return watch(ops);
  const unlock = await operationLock(path.join(ops.private, 'operation.lock'));
  try {
    let result;
    if (command === 'status') result = { project: ops.project, operation: ops.pending(), maintenance: fs.existsSync(ops.gate), dailyBackup: fs.existsSync(path.join(ops.private, 'daily-backup.json')) ? readJSON(path.join(ops.private, 'daily-backup.json')) : null, ...(!ops.pending() ? await ops.health() : {}) };
    else if (command === 'backup') result = await ops.backup({ keep: values.keep === undefined ? undefined : +values.keep });
    else if (command === 'verify-backup') { await verifyBackup(childPath(ops.root, argument)); result = { verified: true }; }
    else if (command === 'restore') result = await ops.restore(argument, values.replace);
    else if (command === 'recover' || command === 'rollback') result = await ops[command]();
    else if (command === 'upgrade') result = await ops.upgrade(argument);
    else {
      let input = '';
      if (command !== 'mail-test') for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 16384) throw new Failure('input_too_large'); }
      result = await ops.operator(command, command === 'mail-test' ? { to: values.to } : JSON.parse(input));
    }
    console.log(JSON.stringify(result));
  } finally { await unlock(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Failure ? error.message : 'Operation failed; inspect configuration and service readiness. No private values were logged.'); process.exitCode = 1; });
