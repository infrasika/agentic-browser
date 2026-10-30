import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export async function temporary(action) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-')));
  try { return await action(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
