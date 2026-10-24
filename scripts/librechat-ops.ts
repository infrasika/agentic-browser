import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const root = resolve(import.meta.dirname, '..');
export const deployment = join(root, '.deployment/librechat');
export type Check = { name: string; status: 'ok' | 'warning' | 'error'; metrics?: Record<string, number | boolean> };
const exec = promisify(execFile);

// Never propagate stdout, stderr, environment or command errors into reports.
export async function command(file: string, args: string[], timeout = 8000): Promise<string> {
  try {
    const result = await exec(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch { throw new Error('command_failed'); }
}

export async function probe(name: string, work: () => Promise<Omit<Check, 'name'>>): Promise<Check> {
  try { return { name, ...await work() }; }
  catch { return { name, status: 'error' }; }
}

export function exitCode(checks: Check[]) {
  return checks.some(check => check.status === 'error') ? 2 : checks.some(check => check.status === 'warning') ? 1 : 0;
}

export async function privateFile(path: string) {
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error('symlink_directory');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024 * 1024) throw new Error('unsafe_file');
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function saveReport(name: string, report: unknown) {
  const directory = join(root, 'output/librechat');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error('unsafe_output');
  const temporary = join(directory, `.${name}-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); }
    finally { await handle.close(); }
    await rename(temporary, join(directory, name));
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function availableMiB() {
  const match = /MemAvailable:\s+(\d+)/.exec(await readFile('/proc/meminfo', 'utf8'));
  if (!match) throw new Error('memory_unknown');
  return Math.floor(Number(match[1]) / 1024);
}
