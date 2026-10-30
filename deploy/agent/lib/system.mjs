import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export class Failure extends Error {}
export const sleep = delay;
export const id = () => randomUUID().replaceAll('-', '');
export const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const sha = value => createHash('sha256').update(value).digest('hex');
export const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value; }
export const mainModule = name => process.argv[1] && path.basename(process.argv[1]) === name;
export function privatePath(file, directory = false) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw new Failure('private_path_permissions_required');
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Failure('invalid_private_path');
}
export function readPrivate(file) { privatePath(file); return json(file); }
export function atomic(file, value) {
  if (exists(file)) privatePath(file);
  const pending = path.join(path.dirname(file), '.' + path.basename(file) + '.' + id());
  let fd;
  try {
    fd = fs.openSync(pending, 'wx', 0o600);
    fs.writeFileSync(fd, typeof value === 'string' || ArrayBuffer.isView(value) ? value : JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(pending, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(pending, { force: true }); }
}
export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return [file, ...(entry.isDirectory() ? walk(file) : [])];
  });
}
export function safeEnvironment() { return Object.fromEntries(['PATH', 'HOME', 'TERM'].filter(k => process.env[k]).map(k => [k, process.env[k]])); }

// Never echo child arguments or stderr by default: either can contain credentials.
// Explicit descriptors stream images/backups or opt-in sanitized CI diagnostics.
export async function run(args, { input, timeout = 120_000, cwd, env = process.env, binary = false, stdout, stderr, stdin, maxBuffer = 16 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd, env, signal, stdio: [stdin ?? 'pipe', stdout ?? 'pipe', stderr ?? 'pipe'] });
    const chunks = []; let size = 0, failure;
    const timer = timeout ? setTimeout(() => { failure = new Failure('command_unavailable_or_timeout'); child.kill('SIGKILL'); }, timeout) : undefined;
    child.on('error', () => { failure = new Failure('command_unavailable_or_timeout'); });
    child.stderr?.resume();
    child.stdout?.on('data', chunk => { size += chunk.length; if (size > maxBuffer) { failure = new Failure('command_output_too_large'); child.kill('SIGKILL'); } else chunks.push(chunk); });
    child.stdin?.on('error', () => {});
    if (child.stdin) child.stdin.end(input);
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(failure ?? new Failure('command_failed; check configuration, Docker access and service readiness'));
      else { const output = Buffer.concat(chunks); resolve(binary ? output : output.toString('utf8').trim()); }
    });
  });
}

export function argumentsFor(options, argv = process.argv.slice(2)) {
  return parseArgs({ args: argv, allowPositionals: true, strict: true, options: { ...options, help: { type: 'boolean' } } });
}
export function cli(main) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Failure('Node.js 24 or newer is required');
  Promise.resolve().then(main).catch(error => {
    console.error(error instanceof Failure ? error.message : 'Operation failed; inspect local configuration and prerequisites. No secret values were logged.');
    process.exitCode = 1;
  });
}

// flock owns the kernel lock until this process closes the pipe. SIGKILL or
// power loss releases it too; no stale PID files or unsafe stale-lock deletion.
export async function operationLock(file) {
  privatePath(path.dirname(file), true);
  if (exists(file)) privatePath(file);
  const fd = fs.openSync(file, 'a', 0o600); fs.closeSync(fd);
  const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', file, '/bin/sh', '-c', 'printf "locked\\n"; /bin/cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'], env: safeEnvironment() });
  child.stderr.resume(); child.stdin.on('error', () => {});
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Failure('flock_unavailable')));
    child.once('exit', () => reject(new Failure('operation_in_progress; retry later')));
    child.stdout.once('data', data => data.toString() === 'locked\n' ? resolve() : reject(new Failure('lock_unavailable')));
  });
  return async () => { const done = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); await done; };
}
