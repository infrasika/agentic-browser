import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { atomic, digest, KIND, VOLUMES } from '../../deploy/agent/agentctl.mjs';
export async function temporary(action) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-')));
  try { return await action(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
export function archive(file, name = 'safe', type = 'File') {
  const header = new Header({ path: name, type, mode: 0o600, size: 0, uid: process.getuid(), gid: process.getgid(), mtime: new Date(0), linkpath: type === 'SymbolicLink' ? '/outside' : '' });
  header.encode(); atomic(file, gzipSync(Buffer.concat([header.block, Buffer.alloc(1024)])));
}
export async function backupFixture(directory, bad) {
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  const names = [...VOLUMES.map(k => k + '.tar.gz'), 'settings.json', 'secrets.env', 'browser-token', 'release.json', 'compose.yaml'], files = {};
  for (const name of names) {
    const file = path.join(directory, name);
    if (name.endsWith('.tar.gz')) archive(file, name === 'browser-data.tar.gz' && bad ? bad : 'safe', bad === 'link' && name === 'browser-data.tar.gz' ? 'SymbolicLink' : 'File');
    else atomic(file, '{}');
    files[name] = await digest(file);
  }
  atomic(path.join(directory, 'manifest.json'), { kind: KIND, files, uid: process.getuid(), gid: process.getgid() });
  return directory;
}
export function fakeInstall(root) {
  fs.mkdirSync(path.join(root, 'state'), { mode: 0o700, recursive: true }); fs.mkdirSync(path.join(root, 'config'), { mode: 0o700, recursive: true });
  return { root, configDirectory: path.join(root, 'config'), meta: { project: 'agent-0123456789ab' }, intent: path.join(root, 'intent'), gate: path.join(root, 'gate') };
}
