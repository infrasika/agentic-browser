import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args.shift();
const directoryFlag = args.indexOf('--config-dir');
const directory = resolve(directoryFlag < 0 ? resolve(root, '.deployment/librechat') : args[directoryFlag + 1] ?? '');
const path = resolve(directory, 'private.env');
const required = ['QWEN_API_KEY', 'QWEN_BASE_URL', 'QWEN_MODEL', 'QWEN_PROMPT_RATE', 'QWEN_COMPLETION_RATE',
  'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'DEMO_ADMIN_EMAIL', 'DEMO_ADMIN_PASSWORD'];
const generated = ['BROWSER_SERVICE_TOKEN', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDS_KEY', 'CREDS_IV'];

async function privateDirectory() {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('unsafe_directory');
  }
  if (await fs.realpath(directory) !== directory) throw new Error('symlink_directory');
  await fs.chmod(directory, 0o700);
}

async function readPrivate() {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) throw new Error('unsafe_file');
    await handle.chmod(0o600);
    return parseEnv(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function setup() {
  await privateDirectory();
  const content = [
    '# Private configuration. Edit once on the server; never paste secrets into chat or commit this file.',
    '# Prices are USD per million tokens; use the selected Qwen endpoint/model rates.',
    'DOMAIN_CLIENT=https://agentic-browser.zkpass.org',
    'DOMAIN_SERVER=https://agentic-browser.zkpass.org',
    'QWEN_API_KEY=', 'QWEN_BASE_URL=', 'QWEN_MODEL=', 'QWEN_PROMPT_RATE=', 'QWEN_COMPLETION_RATE=',
    'TURNSTILE_SITE_KEY=', 'TURNSTILE_SECRET_KEY=', 'DEMO_ADMIN_EMAIL=', 'DEMO_ADMIN_PASSWORD=',
    '# Provisional starting credits; calibrate using the actual demo before public release.',
    'DEMO_START_CREDITS=200000',
    ...generated.map(key => `${key}=${randomBytes(key === 'CREDS_IV' ? 16 : 32).toString('hex')}`),
    '',
  ].join('\n');
  let handle;
  try {
    handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    console.log(`Created private configuration: ${path}`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await readPrivate();
    console.log(`Preserved existing configuration: ${path}`);
  } finally { await handle?.close(); }
  console.log(`Fill once: ${required.join(', ')}`);
}

async function check() {
  const values = await readPrivate();
  const missing = [...required, ...generated].filter(key => !values[key]?.trim());
  const invalid = [];
  for (const key of generated) {
    if (values[key] && !new RegExp(`^[a-f0-9]{${key === 'CREDS_IV' ? 32 : 64}}$`).test(values[key])) invalid.push(key);
  }
  if (values.QWEN_BASE_URL) {
    try { const url = new URL(values.QWEN_BASE_URL); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalid.push('QWEN_BASE_URL'); }
    catch { invalid.push('QWEN_BASE_URL'); }
  }
  for (const key of ['QWEN_PROMPT_RATE', 'QWEN_COMPLETION_RATE', 'DEMO_START_CREDITS']) {
    if (values[key] && (!Number.isFinite(Number(values[key])) || Number(values[key]) <= 0)) invalid.push(key);
  }
  if (values.DEMO_ADMIN_PASSWORD && values.DEMO_ADMIN_PASSWORD.length < 12) invalid.push('DEMO_ADMIN_PASSWORD');
  if (values.DEMO_ADMIN_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.DEMO_ADMIN_EMAIL)) invalid.push('DEMO_ADMIN_EMAIL');
  const report = { ready: !missing.length && !invalid.length, file: path, missing, invalid };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ready ? 0 : 2;
}

try {
  if (command === 'setup') await setup();
  else if (command === 'check') await check();
  else { console.error('Usage: node scripts/librechat-config.mjs setup|check [--config-dir DIRECTORY]'); process.exitCode = 2; }
} catch {
  console.error('Private configuration could not be accessed safely. Check the path, ownership, and permissions. No secret values were logged.');
  process.exitCode = 1;
}
