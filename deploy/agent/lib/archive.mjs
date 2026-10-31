import fs from 'node:fs';
import * as tar from 'tar';
import { id, run, safeEnvironment, Failure } from './system.mjs';

const docker = ['docker', '--host', 'unix:///var/run/docker.sock'];
const execute = (args, options = {}) => run(args, { env: safeEnvironment(), ...options });

export async function transferVolume(image, volume, project, file, restore = false, command = execute) {
  const name = project + '-archive-' + id().slice(0, 12);
  const args = [...docker, 'run', '--rm', '--name', name, '--label', 'dev.agentic-browser.operation=' + project, '--network=none', '--read-only', '--user=0:0', '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE', '--security-opt=no-new-privileges', '--memory=256m', '--cpus=1'];
  if (restore) args.push('-i', '--cap-add=CHOWN', '--cap-add=FOWNER');
  args.push('--mount', `type=volume,src=${volume},dst=/volume${restore ? '' : ',readonly'}`, '--entrypoint=tar', image, '--numeric-owner', ...(restore ? ['--same-owner', '-xzf'] : ['-czf']), '-', '-C', '/volume', ...(restore ? [] : ['.']));
  const fd = fs.openSync(file, restore ? 'r' : 'wx', 0o600);
  try { await command(args, { timeout: 300_000, ...(restore ? { stdin: fd } : { stdout: fd }) }); }
  finally { fs.closeSync(fd); await command([...docker, 'rm', '-f', name], { timeout: 30_000 }).catch(() => {}); }
}

export async function verifyArchive(file, browser = false) {
  let failure;
  await tar.t({ file, strict: true, onReadEntry(entry) {
    const parts = entry.path.split('/').filter(p => p && p !== '.');
    if (entry.path.startsWith('/') || parts.includes('..') || !['File', 'Directory'].includes(entry.type)) failure = 'unsafe_backup_archive_entry';
    if (browser && parts.length === 2 && parts[0] === 'runtimes' && parts[1].endsWith('.json')) failure = 'backup_contains_runtime_records';
  } });
  if (failure) throw new Failure(failure);
}
