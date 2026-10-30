import { randomBytes } from 'node:crypto';
import { mkdir, lstat, realpath, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { validateSettings } from './settings.mjs';
import { gatewayConfiguration } from './gateway.mjs';

const [command, path] = process.argv.slice(2);
try {
  if (!['init', 'check', 'render'].includes(command) || !path) throw new Error('Use init|check|render CONFIG_DIRECTORY');
  const directory = resolve(path);
  if (command === 'init') await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || await realpath(directory) !== directory || info.uid !== process.getuid() || info.mode & 0o077) throw new Error('Configuration directory must be owned by this user and mode 0700');
  if (command === 'init') {
    // Exclusive files: repeating setup never rotates credentials or overwrites edits.
    const defaults = {
      version: 1, name: 'Agentic Browser', origin: 'http://127.0.0.1:3333',
      adminEmail: 'admin@example.invalid', registration: 'closed', turnstileSiteKey: '',
      model: { name: '', baseURL: '', promptRate: null, completionRate: null },
      credits: { initial: 200000, daily: 20000000, timeZone: 'Asia/Shanghai' }, browser: { maximum: 1 },
    };
    const files = {
      'settings.json': JSON.stringify(defaults, null, 2) + '\n',
      'secrets.env': ['# Private values; never commit this file.', 'QWEN_API_KEY=',
        'DEMO_ADMIN_PASSWORD=' + randomBytes(24).toString('hex'),
        ...['JWT_SECRET', 'JWT_REFRESH_SECRET', 'CREDS_KEY', 'CREDS_IV'].map(key => key + '=' + randomBytes(key === 'CREDS_IV' ? 16 : 32).toString('hex')),
        'TURNSTILE_SECRET_KEY=', 'SMTP_PASSWORD=', ''].join('\n'),
      'browser-token': randomBytes(32).toString('hex') + '\n',
    };
    for (const [name, content] of Object.entries(files)) {
      try { await writeFile(resolve(directory, name), content, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    console.log('Configuration initialized. Edit settings.json and secrets.env; existing files were preserved.');
  } else {
    for (const name of ['settings.json', 'secrets.env', 'browser-token']) {
      const file = await lstat(resolve(directory, name));
      if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() || file.mode & 0o077) throw new Error('Unsafe configuration file');
    }
    const { config } = validateSettings(JSON.parse(await readFile(resolve(directory, 'settings.json'), 'utf8')), parseEnv(await readFile(resolve(directory, 'secrets.env'), 'utf8')));
    if (!/^[a-f0-9]{64}\n?$/.test(await readFile(resolve(directory, 'browser-token'), 'utf8'))) throw new Error('Invalid service credential');
    if (command === 'render') await writeFile(resolve(directory, 'nginx.conf'), gatewayConfiguration(config.origin, config.trustedProxyIPs), { mode: 0o600 });
    console.log(JSON.stringify({ ready: true, origin: config.origin, maximum: config.browser.maximum, registration: config.registration }));
  }
} catch {
  console.error('Configuration rejected. Check required model/rates, origin, administrator, Turnstile and private file permissions. No secret values were logged.');
  process.exitCode = 1;
}
