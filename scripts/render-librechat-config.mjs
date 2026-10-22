import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkout = resolve(process.env.LIBRECHAT_CHECKOUT ?? resolve(root, '../librechat-agent'));
const require = createRequire(resolve(checkout, 'package.json'));
const { configSchema } = require('librechat-data-provider');
const directory = resolve(root, '.deployment/librechat');
const values = parseEnv(await readFile(resolve(directory, 'private.env'), 'utf8'));
const model = values.QWEN_MODEL;
if (!model || !values.TURNSTILE_SITE_KEY) throw new Error('Run doctor:librechat before rendering');
const permissionOff = { use: false, create: false, share: false, public: false };
const starters = [
  'Open example.com, read the page, and explain what it is used for.',
  'Open example.com and let me take control. When I return control, inspect the page and finish the task.',
];
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const acceptance of [false, true]) {
  const origin = acceptance ? 'http://127.0.0.1:3081' : values.DOMAIN_CLIENT;
  const config = {
    version: '1.3.18', cache: true,
    interface: {
      customWelcome: 'Browser Demo', modelSelect: false, parameters: false, presets: false,
      multiConvo: false, memories: false, runCode: false, webSearch: false, fileSearch: false,
      mcpServers: permissionOff, prompts: permissionOff,
      agents: { use: true, create: false, share: false, public: false },
      buildInfo: false, mascot: false, temporaryChat: false, contextCost: true,
    },
    registration: { socialLogins: [] },
    ...(acceptance ? {} : { turnstile: { siteKey: values.TURNSTILE_SITE_KEY,
      verification: { required: true, hostname: new URL(origin).hostname, timeoutMs: 10000 } } }),
    balance: { enabled: true, startBalance: Number(values.DEMO_START_CREDITS), autoRefillEnabled: false, display: 'credits' },
    transactions: { enabled: true },
    browser: { enabled: true, baseURL: acceptance ? 'http://127.0.0.1:18081' : 'http://127.0.0.1:8081',
      agentIds: ['agent_browser_demo'], pollIntervalMs: 1000 },
    endpoints: {
      agents: { disableBuilder: true, allowedProviders: ['Qwen'], capabilities: [],
        recursionLimit: 40, maxRecursionLimit: 40, checkpointer: { type: 'mongo', ttl: 3600 } },
      custom: [{ name: 'Qwen', apiKey: '${QWEN_API_KEY}', baseURL: '${QWEN_BASE_URL}',
        models: { default: [model], fetch: false }, titleConvo: false,
        addParams: { enable_thinking: false, parallel_tool_calls: false },
        tokenConfig: { [model]: { prompt: Number(values.QWEN_PROMPT_RATE), completion: Number(values.QWEN_COMPLETION_RATE), context: 64000 } },
      }],
    },
    modelSpecs: { enforce: true, list: [{ name: 'browser-demo', label: 'Browser Demo', default: true,
      preset: { endpoint: 'agents', agent_id: 'agent_browser_demo' }, conversation_starters: starters }] },
  };
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
  };
  await writeFile(resolve(directory, `${name}.env`), Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
}
console.log('Rendered and schema-validated production/acceptance configurations. Production requires Turnstile; loopback acceptance disables challenges and public registration.');
