#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import * as tar from 'tar';
import { argumentsFor, atomic, cli, digest, exists, Failure, id, json, mainModule, operationLock, privatePath, readPrivate, run, safeEnvironment, sleep } from './lib/system.mjs';
export { atomic, digest, exists, Failure, operationLock, privatePath, readPrivate };
export const KIND = 'agentic-browser-installation-v1';
export const VOLUMES = ['browser-data', 'mongo-data', 'redis-data', 'uploads', 'images', 'logs'];
export const SERVICES = ['mongo', 'redis', 'browser', 'agent', 'gateway'];
export const DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock'];
export const SOURCE = import.meta.dirname;
export const execute = (args, options = {}) => run(args, { env: safeEnvironment(), ...options });
const BROWSER_IDLE = `const db=new(require('node:sqlite').DatabaseSync)('/data/scheduler.sqlite',{readOnly:true});const n=db.prepare("SELECT COUNT(*) n FROM leases WHERE state IN ('queued','starting','active','closing','cleanup_pending')").get().n;const events=db.prepare("SELECT COUNT(*) n FROM events WHERE id>COALESCE((SELECT cursor FROM consumers WHERE name='librechat'),0)").get().n;db.close();const records=require('fs').readdirSync('/data/runtimes').filter(n=>n.endsWith('.json')).length;console.log(JSON.stringify({idle:n===0&&events===0&&records===0,leases:n,events,records}));`;
const keys = value => Object.keys(value ?? {}).sort().join(',');
export function releaseFile(file, development = false) {
  const value = json(file);
  if (keys(value) !== 'images,version' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value.version)) throw new Failure('invalid_release_manifest');
  if (keys(value.images) !== 'agent,browser,gateway,mongo,redis,runtime') throw new Failure('invalid_release_images');
  for (const ref of Object.values(value.images)) if (typeof ref !== 'string' || !(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(ref) || development && /^sha256:[a-f0-9]{64}$/.test(ref))) throw new Failure('immutable_release_images_required');
  return value;
}
export function hostPlatform(platform = process.platform, arch = process.arch) {
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) throw new Failure('supported_linux_host_required');
  return 'linux/' + (arch === 'x64' ? 'amd64' : 'arm64');
}
export async function pullImages(release) {
  const platform = hostPlatform();
  for (const ref of Object.values(release.images)) {
    if (ref.includes('@sha256:')) await execute([...DOCKER, 'pull', '--platform', platform, ref], { timeout: 900_000 });
    try { await execute([...DOCKER, 'image', 'inspect', ref]); } catch { await execute([...DOCKER, 'pull', ref], { timeout: 900_000 }); }
    const info = JSON.parse(await execute([...DOCKER, 'image', 'inspect', ref]))[0];
    if (info.Os + '/' + info.Architecture !== platform) throw new Failure('host_image_architecture_mismatch');
  }
}
export async function transferVolume(image, volume, project, file, restore = false, command = execute) {
  const name = project + '-archive-' + id().slice(0, 12);
  const args = [...DOCKER, 'run', '--rm', '--name', name, '--label', 'dev.agentic-browser.operation=' + project, '--network=none', '--read-only', '--user=0:0', '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE', '--security-opt=no-new-privileges', '--memory=256m', '--cpus=1'];
  if (restore) args.push('-i', '--cap-add=CHOWN', '--cap-add=FOWNER');
  args.push('--mount', `type=volume,src=${volume},dst=/volume${restore ? '' : ',readonly'}`, '--entrypoint=tar', image, '--numeric-owner', ...(restore ? ['--same-owner', '-xzf'] : ['-czf']), '-', '-C', '/volume', ...(restore ? [] : ['.']));
  const fd = fs.openSync(file, restore ? 'r' : 'wx', 0o600);
  try { await command(args, { timeout: 300_000, ...(restore ? { stdin: fd } : { stdout: fd }) }); }
  finally { fs.closeSync(fd); await command([...DOCKER, 'rm', '-f', name], { timeout: 30_000 }).catch(() => {}); }
}

export class Installation {
  constructor(directory) {
    this.root = fs.realpathSync(directory);
    if (path.resolve(directory) !== this.root) throw new Failure('installation_symlinks_not_allowed');
    privatePath(this.root, true); this.meta = readPrivate(path.join(this.root, 'installation.json'));
    if (this.meta.kind !== KIND || !/^agent-[a-f0-9]{12}$/.test(this.meta.project)) throw new Failure('invalid_installation');
    if (this.meta.uid !== process.getuid() || this.meta.gid !== process.getgid()) throw new Failure('installation_owner_changed');
    this.release = readPrivate(path.join(this.root, 'release.json')); this.gate = path.join(this.root, 'state/maintenance/active'); this.intent = path.join(this.root, 'state/operation.json');
  }
  compose(args, options) { return execute([...DOCKER, 'compose', '--project-directory', this.root, '--env-file', path.join(this.root, '.env'), '-p', this.meta.project, '-f', path.join(this.root, 'compose.yaml'), ...args], options); }
  async config(action) {
    return JSON.parse(await execute([...DOCKER, 'run', '--rm', '--network=none', '--user', `${this.meta.uid}:${this.meta.gid}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--volume', path.join(this.root, 'config') + ':/config', '--entrypoint', 'node', this.release.images.agent, '/app/selfhost/init.mjs', action, '/config']));
  }
  async render() {
    storageDirectory(this.root); const result = await this.config('render');
    const values = { AGENT_PROJECT: this.meta.project, AGENT_UID: this.meta.uid, AGENT_GID: this.meta.gid, DOCKER_GID: fs.statSync('/var/run/docker.sock').gid, AGENT_PORT: this.meta.port, AGENT_ORIGIN: result.origin, BROWSER_MAX_SESSIONS: result.maximum, AGENT_DATA_DIR: path.join(this.root, 'data'), ...Object.fromEntries(Object.entries(this.release.images).map(([k, v]) => [k.toUpperCase() + '_IMAGE', v])) };
    atomic(path.join(this.root, '.env'), Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
    await this.compose(['config', '--quiet']); return result;
  }
  async fingerprint() {
    const result = {};
    for (const name of ['settings.json', 'secrets.env', 'browser-token', 'smtp-verified.json']) { const file = path.join(this.root, 'config', name); if (exists(file)) result[name] = await digest(file); }
    return result;
  }
  async up() {
    if (exists(this.intent) || exists(this.gate)) throw new Failure('maintenance_pending; run recover after inspecting status');
    const applied = path.join(this.root, 'state/applied.json');
    if (exists(applied) && !isDeepStrictEqual(readPrivate(applied), await this.fingerprint())) throw new Failure('configuration_changed; use apply during idle time');
    await this.render();
    try { await this.compose(['up', '-d', '--wait', '--wait-timeout', '240'], { timeout: 300_000 }); }
    catch { throw new Failure('compose_start_failed; inspect local compose ps and logs'); }
    await this.doctor(); atomic(applied, await this.fingerprint());
  }
  async probe(status = 200) {
    const config = JSON.parse(await this.compose(['config', '--format', 'json'])), host = new URL(config.services.browser.environment.DOMAIN_CLIENT).host;
    await this.compose(['exec', '-T', 'agent', 'node', '-e', `const q=require('http').get('http://gateway:8080/api/config',{headers:{Host:${JSON.stringify(host)}}},r=>{r.resume();process.exit(r.statusCode===${status}${status === 503 ? "&&r.headers['x-agent-maintenance']==='1'" : ''}?0:1)});q.setTimeout(5000,()=>q.destroy());q.on('error',()=>process.exit(1));`]);
  }
  async doctor() {
    const result = await this.config('check'), raw = await this.compose(['ps', '--all', '--format', 'json']);
    const rows = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').filter(Boolean).map(JSON.parse), byName = Object.fromEntries(rows.map(r => [r.Service, r]));
    if (SERVICES.some(name => byName[name]?.State !== 'running')) throw new Failure('services_not_running');
    if (['agent', 'browser', 'mongo', 'redis'].some(name => byName[name]?.Health !== 'healthy')) throw new Failure('service_unhealthy');
    for (let attempt = 0; attempt < 6; attempt++) { try { await this.probe(); break; } catch { if (attempt === 5) throw new Failure('gateway_http_not_ready'); await sleep(1000); } }
    return { healthy: true, maintenance: exists(this.gate), origin: result.origin, maximum: result.maximum };
  }
  async idle(drain = false) {
    const browser = JSON.parse(await this.compose(['exec', '-T', 'browser', 'node', '-e', BROWSER_IDLE]));
    const agent = JSON.parse(await this.compose(['exec', '-T', 'agent', 'node', '/app/selfhost/idle.mjs']));
    return browser.idle && agent.idle && (!drain || agent.connections === 0);
  }
  async stopClean(service) {
    await this.compose(['stop', '-t', '60', service], { timeout: 75_000 });
    const cid = await this.compose(['ps', '--all', '-q', service]), state = JSON.parse(await execute([...DOCKER, 'inspect', cid]))[0].State;
    if (state.Running || state.OOMKilled || ![0, 143].includes(state.ExitCode)) throw new Failure('service_did_not_stop_cleanly');
  }
  async enter(operation) {
    if (exists(this.intent) || exists(this.gate)) throw new Failure('maintenance_pending');
    await this.doctor(); if (!await this.idle()) throw new Failure('busy; retry after all tasks finish');
    atomic(this.intent, { kind: KIND, operation, phase: 'drain' }); atomic(this.gate, 'maintenance\n'); await this.probe(503);
    const deadline = Date.now() + 30_000;
    while (!await this.idle(true)) { if (Date.now() > deadline) { fs.unlinkSync(this.gate); fs.unlinkSync(this.intent); throw new Failure('busy_or_inflight_requests; retry later'); } await sleep(500); }
    atomic(this.intent, { kind: KIND, operation, phase: 'stopping' });
    for (const name of ['agent', 'browser', 'redis', 'mongo']) await this.stopClean(name);
  }
  async recover() {
    if (!exists(this.intent)) { if (exists(this.gate)) throw new Failure('orphan_maintenance_gate'); return { status: 'nothing_to_recover' }; }
    const state = readPrivate(this.intent);
    if (state.kind !== KIND) throw new Failure('invalid_operation_state');
    if (['upgrading', 'upgrade_failed'].includes(state.phase)) throw new Failure('upgrade_incomplete; restore pre-upgrade backup into a fresh installation');
    if (['restoring', 'restore_failed'].includes(state.phase)) throw new Failure('incomplete_restore; use a fresh target');
    if (state.operation === 'restore' && state.phase === 'ready') await this.render();
    const helpers = (await execute([...DOCKER, 'ps', '-aq', '--filter', 'label=dev.agentic-browser.operation=' + this.meta.project])).split(/\s+/).filter(Boolean);
    if (helpers.length) await execute([...DOCKER, 'rm', '-f', ...helpers]);
    await this.compose(['up', '-d', '--wait', '--wait-timeout', '240'], { timeout: 300_000 });
    fs.rmSync(this.gate, { force: true });
    try { await this.doctor(); } catch (error) { atomic(this.gate, 'maintenance\n'); throw error; }
    fs.unlinkSync(this.intent); atomic(path.join(this.root, 'state/applied.json'), await this.fingerprint());
    return { status: 'services_recovered' };
  }
  async volumeNames() {
    const config = JSON.parse(await this.compose(['config', '--format', 'json']));
    const names = Object.fromEntries(VOLUMES.map(k => [k, config.volumes[k].name]));
    for (const name of Object.values(names)) { const value = JSON.parse(await execute([...DOCKER, 'volume', 'inspect', name]))[0]; if (value.Labels?.['com.docker.compose.project'] !== this.meta.project) throw new Failure('volume_ownership_mismatch'); }
    return names;
  }
  async archive(destination) {
    for (const [key, name] of Object.entries(await this.volumeNames())) await transferVolume(this.release.images.agent, name, this.meta.project, path.join(destination, key + '.tar.gz'));
    for (const name of ['settings.json', 'secrets.env', 'browser-token', 'smtp-verified.json', 'backup.json']) {
      const source = path.join(this.root, 'config', name);
      if (['smtp-verified.json', 'backup.json'].includes(name) && !exists(source)) continue;
      privatePath(source); atomic(path.join(destination, name), fs.readFileSync(source));
    }
    for (const name of ['release.json', 'compose.yaml']) atomic(path.join(destination, name), fs.readFileSync(path.join(this.root, name)));
    const files = {}; for (const name of fs.readdirSync(destination)) files[name] = await digest(path.join(destination, name));
    atomic(path.join(destination, 'manifest.json'), { kind: KIND, createdAt: new Date().toISOString(), uid: this.meta.uid, gid: this.meta.gid, release: this.release, files });
  }
  async backup(stay = false) {
    const folder = path.join(this.root, 'backups'); fs.mkdirSync(folder, { mode: 0o700, recursive: true }); privatePath(folder, true);
    const name = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') + '-' + id().slice(0, 8), pending = path.join(folder, '.pending-' + name);
    fs.mkdirSync(pending, { mode: 0o700 }); let completed = false;
    try { await this.enter(stay ? 'upgrade' : 'backup'); await this.archive(pending); await verifyBackup(pending); const complete = path.join(folder, name); fs.renameSync(pending, complete); completed = true; return complete; }
    finally { if ((!stay || !completed) && exists(this.intent)) await this.recover(); }
  }
  async operator(action, value) {
    if (exists(this.gate) || exists(this.intent)) throw new Failure('maintenance_pending');
    const output = await this.compose(['exec', '-T', 'agent', 'node', '/app/selfhost/operator.mjs', action], { input: JSON.stringify(value), timeout: 90_000 });
    const line = output.split('\n').find(row => row.startsWith('AGENT_RESULT=')); if (!line) throw new Failure('missing_operator_result');
    const result = JSON.parse(line.slice('AGENT_RESULT='.length));
    if (action === 'mail-test') atomic(path.join(this.root, 'config/smtp-verified.json'), result);
    return result;
  }
  async upgrade(releasePath, development) {
    const target = releaseFile(releasePath, development), template = fs.readFileSync(path.join(SOURCE, 'compose.yaml'), 'utf8');
    await pullImages(target); const previous = await this.backup(true);
    try {
      atomic(this.intent, { kind: KIND, operation: 'upgrade', phase: 'upgrading', backup: previous });
      atomic(path.join(this.root, 'release.json'), target); this.release = target; atomic(path.join(this.root, 'compose.yaml'), template);
      await this.render(); await this.compose(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '240'], { timeout: 300_000 });
      fs.unlinkSync(this.gate); await this.doctor(); fs.unlinkSync(this.intent); atomic(path.join(this.root, 'state/applied.json'), await this.fingerprint());
      await installTools(this.root); return { status: 'upgraded', backup: previous, version: target.version };
    } catch { atomic(this.gate, 'maintenance\n'); atomic(this.intent, { kind: KIND, operation: 'upgrade', phase: 'upgrade_failed', backup: previous }); throw new Failure('upgrade_failed; maintenance retained; restore the pre-upgrade backup into a fresh installation'); }
  }
}

export async function verifyBackup(directory) {
  privatePath(directory, true); const manifest = readPrivate(path.join(directory, 'manifest.json'));
  const required = [...VOLUMES.map(k => k + '.tar.gz'), 'settings.json', 'secrets.env', 'browser-token', 'release.json', 'compose.yaml'];
  if (manifest.kind !== KIND || required.some(k => !(k in (manifest.files ?? {}))) || Object.keys(manifest.files).some(k => ![...required, 'smtp-verified.json', 'backup.json'].includes(k))) throw new Failure('invalid_backup_manifest');
  for (const [name, checksum] of Object.entries(manifest.files)) {
    const file = path.join(directory, name); privatePath(file);
    if (await digest(file) !== checksum) throw new Failure('backup_checksum_mismatch');
    if (name.endsWith('.tar.gz')) {
      let failure;
      await tar.t({ file, strict: true, onReadEntry(entry) {
        const parts = entry.path.split('/').filter(p => p && p !== '.');
        if (entry.path.startsWith('/') || parts.includes('..') || !['File', 'Directory'].includes(entry.type)) failure = 'unsafe_backup_archive_entry';
        if (name === 'browser-data.tar.gz' && parts.length === 2 && parts[0] === 'runtimes' && parts[1].endsWith('.json')) failure = 'backup_contains_runtime_records';
      } });
      if (failure) throw new Failure(failure);
    }
  }
  return manifest;
}
export async function installTools(directory) {
  if (typeof AGENT_BUNDLED === 'undefined') {
    const tool = pathToFileURL(path.resolve(SOURCE, '../../scripts/build/bundle-tools.mjs'));
    const { bundleTools } = await import(tool.href); await bundleTools(directory, { source: path.resolve(SOURCE, '../..'), only: ['agentctl'] });
  } else {
    atomic(path.join(directory, 'agentctl.mjs'), fs.readFileSync(path.join(SOURCE, 'agentctl.mjs')));
    fs.mkdirSync(path.join(directory, 'LICENSES'), { recursive: true, mode: 0o700 });
    atomic(path.join(directory, 'LICENSES/TOOLS.txt'), fs.readFileSync(path.join(SOURCE, 'LICENSES/TOOLS.txt')));
  }
}
export function storageDirectory(root, create = false) {
  const directory = path.join(root, 'data');
  if (create) { fs.mkdirSync(directory, { mode: 0o700 }); for (const name of VOLUMES) fs.mkdirSync(path.join(directory, name), { mode: 0o700 }); }
  privatePath(directory, true);
  for (const name of VOLUMES) { const child = path.join(directory, name); if (!exists(child) || fs.lstatSync(child).isSymbolicLink() || !fs.statSync(child).isDirectory()) throw new Failure('storage_directory_missing_or_unsafe'); }
  return directory;
}
function realFuture(file) { if (exists(file)) return fs.realpathSync(file); return path.join(realFuture(path.dirname(file)), path.basename(file)); }
export async function initialize(directory, releasePath, port = 3333, development = false) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Failure('invalid_loopback_port'); hostPlatform();
  if (exists(directory)) throw new Failure('installation_directory_already_exists');
  if (path.resolve(directory) !== realFuture(path.resolve(directory))) throw new Failure('installation_symlinks_not_allowed');
  if (/[,$#'"\\\n\r]/.test(directory)) throw new Failure('unsupported_installation_path');
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', () => reject(new Failure('loopback_port_unavailable'))); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
  const release = releaseFile(releasePath, development); await pullImages(release); await execute([...DOCKER, 'compose', 'version']);
  const version = JSON.parse(await execute([...DOCKER, 'version', '--format', '{{json .Server}}']));
  if (Number(version.Version.split('.')[0]) < 26) throw new Failure('docker_engine_26_required');
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  for (const name of ['config', 'state', 'state/maintenance']) fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
  storageDirectory(directory, true); atomic(path.join(directory, 'compose.yaml'), fs.readFileSync(path.join(SOURCE, 'compose.yaml'))); await installTools(directory);
  const meta = { kind: KIND, project: 'agent-' + id().slice(0, 12), uid: process.getuid(), gid: process.getgid(), port };
  atomic(path.join(directory, 'installation.json'), meta); atomic(path.join(directory, 'release.json'), release);
  await execute([...DOCKER, 'run', '--rm', '--network=none', '--user', `${meta.uid}:${meta.gid}`, '--read-only', '--cap-drop=ALL', '--volume', path.join(directory, 'config') + ':/config', '--entrypoint=node', release.images.agent, '/app/selfhost/init.mjs', 'init', '/config']);
  const settings = readPrivate(path.join(directory, 'config/settings.json')); settings.origin = `http://127.0.0.1:${port}`; atomic(path.join(directory, 'config/settings.json'), settings);
  return { status: 'initialized', directory, next: 'Edit config/settings.json and config/secrets.env once, then run up.' };
}
export async function restore(source, directory, port, development) {
  const manifest = await verifyBackup(source);
  if (manifest.uid !== process.getuid() || manifest.gid !== process.getgid()) throw new Failure('restore_requires_same_numeric_uid_gid');
  await initialize(directory, path.join(source, 'release.json'), port, development); const install = new Installation(directory);
  for (const name of ['settings.json', 'secrets.env', 'browser-token', 'smtp-verified.json']) if (exists(path.join(source, name))) atomic(path.join(directory, 'config', name), fs.readFileSync(path.join(source, name)));
  const settings = readPrivate(path.join(directory, 'config/settings.json'));
  settings.origin = `http://127.0.0.1:${port}`; settings.registration = 'closed'; settings.turnstileSiteKey = ''; delete settings.trustedProxyIPs;
  atomic(path.join(directory, 'config/settings.json'), settings);
  const secretPath = path.join(directory, 'config/secrets.env'); atomic(secretPath, fs.readFileSync(secretPath, 'utf8').replace(/^TURNSTILE_SECRET_KEY=.*$/gm, 'TURNSTILE_SECRET_KEY='));
  await install.render(); atomic(install.gate, 'maintenance\n'); atomic(install.intent, { kind: KIND, operation: 'restore', phase: 'restoring' });
  try {
    await install.compose(['create']); const names = await install.volumeNames();
    for (const [key, name] of Object.entries(names)) await transferVolume(install.release.images.agent, name, install.meta.project, path.join(source, key + '.tar.gz'), true);
    await execute([...DOCKER, 'run', '--rm', '--network=none', '--read-only', '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop=ALL', '--mount', `type=volume,src=${names['browser-data']},dst=/volume`, '--entrypoint=node', install.release.images.agent, '-e', "require('fs').writeFileSync('/volume/runtimes/instance-id',require('crypto').randomUUID(),{mode:0o600})"]);
    atomic(install.intent, { kind: KIND, operation: 'restore', phase: 'ready' }); return { status: 'restored_stopped', directory, next: 'Review configuration, then run recover.' };
  } catch (error) { atomic(install.intent, { kind: KIND, operation: 'restore', phase: 'restore_failed' }); throw error; }
}
async function accountInput() {
  if (!process.stdin.isTTY) throw new Failure('Use --input-file for non-interactive account operations');
  const { createInterface } = await import('node:readline/promises'), { Writable } = await import('node:stream');
  let muted = false; const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  const password = async prompt => { process.stdout.write(prompt); muted = true; try { return await input.question(''); } finally { muted = false; process.stdout.write('\n'); } };
  return { input, password };
}
export async function main() {
  process.umask(0o077);
  const { values: args, positionals } = argumentsFor(Object.fromEntries(['directory', 'release', 'port', 'timezone', 'hour', 'keep', 'retry-minutes', 'copy-to', 'input-file', 'to'].map(k => [k, { type: 'string' }]).concat([['development', { type: 'boolean' }]])));
  const [command, backup] = positionals, commands = ['init', 'up', 'doctor', 'backup', 'recover', 'apply', 'maintain', 'maintenance-status', 'schedule', 'user-create', 'user-reset', 'mail-test', 'upgrade', 'verify-backup', 'restore'];
  if (args.help) return console.log('node agentctl.mjs --directory INSTALLATION ' + commands.join('|') + '\ninit/upgrade: --release FILE [--development]; init/restore: --port 3333\nschedule: --timezone UTC --hour 4 --keep 7 --retry-minutes 60 [--copy-to DIRECTORY]\nmail-test: --to EMAIL; user-create/user-reset: [--input-file PRIVATE_JSON]; restore/verify-backup: BACKUP');
  if (!args.directory || !commands.includes(command) || positionals.length > (['restore', 'verify-backup'].includes(command) ? 2 : 1)) throw new Failure('Use --directory and a supported command; see --help');
  if (['init', 'upgrade'].includes(command) && !args.release || ['restore', 'verify-backup'].includes(command) && !backup || command === 'mail-test' && !args.to) throw new Failure('Missing command argument; see --help');
  const directory = path.resolve(args.directory); let result;
  if (command === 'init') result = await initialize(directory, path.resolve(args.release), Number(args.port ?? 3333), args.development);
  else if (command === 'restore') result = await restore(path.resolve(backup), directory, Number(args.port ?? 3333), args.development);
  else if (command === 'verify-backup') { await verifyBackup(path.resolve(backup)); result = { verified: true }; }
  else {
    const install = new Installation(directory); let unlock;
    try { unlock = await operationLock(path.join(directory, 'state/lock')); }
    catch (error) { if (command === 'maintain' && error instanceof Failure && error.message.startsWith('operation_in_progress')) return console.log(JSON.stringify({ status: 'operation_in_progress' })); throw error; }
    try {
      if (command === 'up') { await install.up(); result = { status: 'running' }; }
      else if (['schedule', 'maintain', 'maintenance-status'].includes(command)) {
        const maintenance = await import('./maintenance.mjs');
        result = command === 'schedule' ? await maintenance.configure(install, args) : command === 'maintain' ? await maintenance.tick(install) : maintenance.status(install);
      } else if (command === 'doctor') result = await install.doctor();
      else if (command === 'recover') result = await install.recover();
      else if (command === 'backup') result = { backup: await install.backup() };
      else if (command === 'apply') result = await install.upgrade(path.join(directory, 'release.json'), true);
      else if (command === 'upgrade') result = await install.upgrade(path.resolve(args.release), args.development);
      else if (command === 'mail-test') { result = await install.operator(command, { to: args.to }); result = { accepted: result.accepted, next: 'Run apply during idle time to enable password recovery. Verify inbox delivery separately.' }; }
      else {
        let value;
        if (args['input-file']) value = readPrivate(path.resolve(args['input-file']));
        else {
          const { input, password } = await accountInput();
          try { value = { email: (await input.question('Email: ')).trim() }; if (command === 'user-create') Object.assign(value, { name: (await input.question('Name: ')).trim(), username: (await input.question('Username: ')).trim() }); value.password = await password('New password (12+ characters): '); if (value.password !== await password('Repeat password: ')) throw new Failure('password_mismatch'); }
          finally { input.close(); }
        }
        result = await install.operator(command, value);
      }
    } finally { await unlock(); }
  }
  console.log(JSON.stringify(result));
}
if (mainModule('agentctl.mjs')) cli(main);
