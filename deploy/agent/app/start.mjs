import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createAgentConfiguration } from './config.mjs';
import { validateSettings } from './settings.mjs';

const require = createRequire('/app/package.json');
let child;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child?.kill(signal));
function run(file) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [file], { cwd: '/app', env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Application child failed')));
  });
}
try {
  const { config, credentials } = validateSettings(
    JSON.parse(await readFile('/config/settings.json', 'utf8')),
    parseEnv(await readFile('/run/secrets/agent', 'utf8')),
  );
  const token = (await readFile('/run/secrets/browser_token', 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid service credential');
  const definition = JSON.parse(await readFile('/app/config/browser-demo.json', 'utf8'));
  definition.name = config.name;
  const yaml = createAgentConfiguration({ origin: config.origin, model: config.model.name,
    promptRate: config.model.promptRate, completionRate: config.model.completionRate,
    startCredits: config.credits.initial, dailyCredits: config.credits.daily,
    timeZone: config.credits.timeZone, name: config.name, starters: definition.conversation_starters,
    browserURL: 'http://browser:8081', turnstile: config.turnstileSiteKey || undefined });
  require('librechat-data-provider').configSchema.parse(yaml);
  await mkdir('/tmp/agent', { recursive: true, mode: 0o700 });
  await writeFile('/tmp/agent/librechat.yaml', JSON.stringify(yaml), { mode: 0o600 });
  await writeFile('/tmp/agent/definition.json', JSON.stringify(definition), { mode: 0o600 });
  Object.assign(process.env, credentials, {
    NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3080',
    DOMAIN_CLIENT: config.origin, DOMAIN_SERVER: config.origin, CONFIG_PATH: '/tmp/agent/librechat.yaml',
    BROWSER_SERVICE_TOKEN: token, QWEN_MODEL: config.model.name, QWEN_BASE_URL: config.model.baseURL,
    DEMO_ADMIN_EMAIL: config.adminEmail,
    MONGO_URI: 'mongodb://mongo:27017/AgenticBrowser',
    USE_REDIS: 'true', USE_REDIS_STREAMS: 'true', REDIS_URI: 'redis://redis:6379', REDIS_KEY_PREFIX: 'agent',
    ENDPOINTS: 'agents,custom', ADMIN_PANEL_URL: config.origin + '/demo-admin',
    ALLOW_EMAIL_LOGIN: 'true', ALLOW_REGISTRATION: String(config.registration === 'public'),
    ALLOW_SOCIAL_LOGIN: 'false', ALLOW_SOCIAL_REGISTRATION: 'false', ALLOW_PASSWORD_RESET: 'false',
    ALLOW_UNVERIFIED_EMAIL_LOGIN: 'true', ALLOW_SHARED_LINKS: 'false', ALLOW_SHARED_LINKS_PUBLIC: 'false',
    LIMIT_CONCURRENT_MESSAGES: 'true', CONCURRENT_MESSAGE_MAX: '1',
    LIMIT_MESSAGE_IP: 'true', LIMIT_MESSAGE_USER: 'true', BAN_VIOLATIONS: 'true',
    SEARCH: 'false', DEBUG_LOGGING: 'false', DEBUG_CONSOLE: 'false', CONSOLE_JSON: 'true',
  });
  await run('/app/selfhost/bootstrap.cjs');
  await run('/app/api/server/index.js');
} catch {
  console.error('Agent startup failed. Check settings, private credential files and database readiness.');
  process.exitCode = 1;
}
