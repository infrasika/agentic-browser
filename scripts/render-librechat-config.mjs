import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { mailEnvironment } from './librechat-mail.mjs';
import { createAgentConfiguration } from '../deploy/agent/app/config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkout = resolve(process.env.LIBRECHAT_CHECKOUT ?? resolve(root, '../librechat-agent'));
const require = createRequire(resolve(checkout, 'package.json'));
const { configSchema } = require('librechat-data-provider');
const directory = resolve(root, '.deployment/librechat');
const values = parseEnv(await readFile(resolve(directory, 'private.env'), 'utf8'));
let mailReceipt;
try { mailReceipt = JSON.parse(await readFile(resolve(directory, 'mail-verified.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid mail verification receipt'); }
const mailEnv = mailEnvironment(values, mailReceipt);
const model = values.QWEN_MODEL;
if (!model || !values.TURNSTILE_SITE_KEY) throw new Error('Run doctor:librechat before rendering');
// Agent bootstrap and homepage cards use the same deployment-owned definition.
const { conversation_starters: starters } = JSON.parse(await readFile(resolve(checkout, 'config/browser-demo.json'), 'utf8'));
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const acceptance of [false, true]) {
  const origin = acceptance ? 'http://127.0.0.1:3081' : values.DOMAIN_CLIENT;
  const config = createAgentConfiguration({
    origin, model, promptRate: Number(values.QWEN_PROMPT_RATE), completionRate: Number(values.QWEN_COMPLETION_RATE),
    startCredits: Number(values.DEMO_START_CREDITS), starters,
    browserURL: acceptance ? 'http://127.0.0.1:18081' : 'http://127.0.0.1:8081',
    turnstile: acceptance ? undefined : values.TURNSTILE_SITE_KEY,
  });
  const validated = configSchema.safeParse(config);
  if (!validated.success) {
    console.error(validated.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })));
    process.exit(1);
  }
  const name = acceptance ? 'acceptance' : 'production';
  await writeFile(resolve(directory, `${name}.yaml`), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const env = {
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: acceptance ? '3091' : '3080',
    DOMAIN_CLIENT: origin, DOMAIN_SERVER: origin,
    ADMIN_PANEL_URL: `${origin}/demo-admin`,
    CONFIG_PATH: resolve(directory, `${name}.yaml`),
    MONGO_URI: `mongodb://127.0.0.1:27019/${acceptance ? 'LibreChatBrowserAcceptance' : 'LibreChatBrowserDemo'}`,
    USE_REDIS: 'true', USE_REDIS_STREAMS: 'true', REDIS_URI: 'redis://127.0.0.1:6381',
    REDIS_KEY_PREFIX: `browser-${name}`, ENDPOINTS: 'agents,custom',
    ALLOW_EMAIL_LOGIN: 'true', ALLOW_REGISTRATION: acceptance ? 'false' : 'true',
    ALLOW_SOCIAL_LOGIN: 'false', ALLOW_SOCIAL_REGISTRATION: 'false', ALLOW_PASSWORD_RESET: 'false',
    ALLOW_UNVERIFIED_EMAIL_LOGIN: 'true', ALLOW_SHARED_LINKS: 'false', ALLOW_SHARED_LINKS_PUBLIC: 'false',
    LIMIT_CONCURRENT_MESSAGES: 'true', CONCURRENT_MESSAGE_MAX: '1',
    LIMIT_MESSAGE_IP: 'true', LIMIT_MESSAGE_USER: 'true', BAN_VIOLATIONS: 'true',
    SEARCH: 'false', DEBUG_LOGGING: 'false', DEBUG_CONSOLE: 'false', CONSOLE_JSON: 'true',
    ...(acceptance ? {} : mailEnv),
  };
  await writeFile(resolve(directory, `${name}.env`), Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
}
console.log('Rendered and schema-validated production/acceptance configurations. Production requires Turnstile; loopback acceptance disables challenges and public registration.');
