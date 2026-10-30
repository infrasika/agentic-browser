import { spawn } from 'node:child_process';
import { loadRuntime } from './environment.mjs';
let child, stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; child?.kill(signal); });
function run(file) {
  return new Promise((resolve, reject) => {
    if (stopping) { resolve(); return; }
    child = spawn(process.execPath, [file], { cwd: '/app', env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 || stopping ? resolve() : reject(new Error('Application child failed')));
  });
}
try {
  await loadRuntime();
  await run('/app/selfhost/bootstrap.cjs');
  await run('/app/api/server/index.js');
} catch {
  console.error('Agent startup failed. Check settings, private credential files and database readiness.');
  process.exitCode = 1;
}
