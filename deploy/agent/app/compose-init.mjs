import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateSettings } from './settings.mjs';
import { gatewayConfiguration } from './gateway.mjs';

const keys = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDS_KEY', 'CREDS_IV'];
const userKeys = ['QWEN_API_KEY', 'DEMO_ADMIN_PASSWORD', 'TURNSTILE_SECRET_KEY', 'SMTP_PASSWORD'];
async function atomic(file, data) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
// Persist identity before publishing derived files. Interrupted setup never rotates
// an existing identity; a corrupt identity must be restored, never regenerated.
export async function initializeCompose({ input = '/input', config = '/config', browser = '/browser-config', gateway = '/gateway-config', storage = ['/state/browser', '/state/uploads', '/state/images', '/state/logs'], owner = 1000 } = {}) {
  const settings = JSON.parse(await fs.readFile(path.join(input, 'settings.json'), 'utf8'));
  const supplied = parseEnv(await fs.readFile(path.join(input, 'secrets.env'), 'utf8'));
  if (Object.keys(supplied).some(key => !userKeys.includes(key))) throw new Error('Only documented user credentials are accepted');
  if (!supplied.DEMO_ADMIN_PASSWORD || supplied.DEMO_ADMIN_PASSWORD === 'CHANGE_ME_BEFORE_START') throw new Error('Set DEMO_ADMIN_PASSWORD (at least 12 characters)');
  if (!supplied.QWEN_API_KEY || supplied.QWEN_API_KEY === 'CHANGE_ME_BEFORE_START') throw new Error('Set QWEN_API_KEY');
  let identity;
  try { identity = JSON.parse(await fs.readFile(path.join(config, 'identity.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Stored identity is unreadable; restore the configuration volume'); }
  if (!identity) identity = { ...Object.fromEntries(keys.map(key => [key, randomBytes(key === 'CREDS_IV' ? 16 : 32).toString('hex')])), browserToken: randomBytes(32).toString('hex') };
  if (!/^[a-f0-9]{64}$/.test(identity.browserToken) || Object.keys(identity).sort().join() !== [...keys, 'browserToken'].sort().join()) throw new Error('Invalid stored identity');
  let validated;
  try { validated = validateSettings(settings, { ...supplied, ...Object.fromEntries(keys.map(key => [key, identity[key]])) }); }
  catch (error) {
    // Validation messages can contain supplied values. Print field paths only.
    const fields = error.issues?.map(issue => issue.path.join('.')).filter(Boolean);
    throw new Error('Invalid configuration' + (fields?.length ? ': ' + [...new Set(fields)].join(', ') : '; check paired Turnstile/SMTP credentials'));
  }
  const { config: parsed, credentials } = validated;
  // Pick a delimiter absent from the value. No shell/Compose interpolation and
  // no JSON escaping (parseEnv intentionally keeps backslashes literal).
  const env = Object.entries(credentials).map(([key, value]) => {
    const quote = ['"', "'", '`'].find(mark => !value.includes(mark));
    if (!quote || /[\r\n\0]/.test(value)) throw new Error('Credentials contain unsupported quoting or newline characters');
    return key + '=' + quote + value + quote;
  }).join('\n') + '\n';
  if (Object.entries(credentials).some(([key, value]) => parseEnv(env)[key] !== value)) throw new Error('Credentials cannot be encoded safely');
  for (const directory of [config, browser, gateway, ...storage]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Expected a configuration or data volume');
    await fs.chmod(directory, 0o700);
  }
  try { await fs.writeFile(path.join(config, 'identity.json'), JSON.stringify(identity), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await fs.readFile(path.join(config, 'identity.json'), 'utf8') !== JSON.stringify(identity)) throw new Error('Concurrent initialization or inconsistent identity');
  }
  await atomic(path.join(config, 'settings.json'), JSON.stringify(parsed, null, 2) + '\n');
  await atomic(path.join(config, 'agent'), env);
  await atomic(path.join(config, 'browser_token'), identity.browserToken + '\n');
  await atomic(path.join(browser, 'browser_token'), identity.browserToken + '\n');
  await atomic(path.join(browser, 'settings.json'), JSON.stringify({ origin: parsed.origin, maximum: parsed.browser.maximum }));
  await atomic(path.join(gateway, 'nginx.conf'), gatewayConfiguration(parsed.origin, parsed.trustedProxyIPs));
  if (owner !== false) {
    for (const directory of [config, browser, gateway, ...storage]) {
      await fs.chown(directory, owner, owner);
      // Do not recursively change user data; only generated configuration files.
      if ([config, browser, gateway].includes(directory)) for (const name of await fs.readdir(directory)) {
        const file = path.join(directory, name);
        if (!(await fs.lstat(file)).isFile()) throw new Error('Unexpected configuration entry');
        await fs.chown(file, owner, owner);
      }
    }
  }
  return { ready: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await initializeCompose(); console.log('Configuration ready. Existing application keys were preserved.'); }
  catch (error) {
    // JSON and filesystem exceptions may contain input text or sensitive paths.
    const message = error instanceof SyntaxError || error.code ? 'Check settings.json, secrets.env and configuration volumes.' : error.message;
    console.error('Compose initialization failed: ' + message); process.exitCode = 1;
  }
}
