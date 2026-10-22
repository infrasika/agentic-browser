import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const values = parseEnv(await readFile(resolve(root, '.deployment/librechat/private.env'), 'utf8'));
const secrets = Object.entries(values).filter(([key, value]) => value && /KEY|SECRET|PASSWORD|TOKEN|DEMO_ADMIN_EMAIL/.test(key)).map(([, value]) => value).sort((a, b) => b.length - a.length);
for (const file of process.argv.slice(2)) {
  let text = await readFile(file, 'utf8');
  for (const value of secrets) text = text.replaceAll(value, '[redacted]');
  console.log(text.split('\n').slice(-35).join('\n'));
}
