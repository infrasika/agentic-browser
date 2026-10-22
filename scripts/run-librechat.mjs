import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkout = resolve(process.env.LIBRECHAT_CHECKOUT ?? resolve(root, '../librechat-agent'));
const mode = process.argv.includes('--acceptance') ? 'acceptance' : 'production';
const command = process.argv[2];
if (!['serve', 'bootstrap'].includes(command)) throw new Error('Usage: node scripts/run-librechat.mjs serve|bootstrap [--acceptance]');
const directory = resolve(root, '.deployment/librechat');
const privateEnv = parseEnv(await readFile(resolve(directory, 'private.env'), 'utf8'));
const runtimeEnv = parseEnv(await readFile(resolve(directory, `${mode}.env`), 'utf8'));
const env = { ...process.env, ...privateEnv, ...runtimeEnv };
let child;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal));
function run(file) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [file], { cwd: checkout, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('LibreChat process failed; inspect its private logs')));
  });
}
// Bootstrap completes before the HTTP listener can admit the first public registrant.
await run('config/bootstrap-browser.cjs');
if (command === 'serve') await run('api/server/index.js');
