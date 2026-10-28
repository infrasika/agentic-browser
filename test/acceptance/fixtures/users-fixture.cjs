// Runs only in the disposable Compose agent. No host database addresses.
process.loadEnvFile('/run/secrets/agent');
Object.assign(process.env, {
  MONGO_URI: 'mongodb://mongo:27017/AgenticBrowser', CONFIG_PATH: '/tmp/agent/librechat.yaml',
  USE_REDIS: 'true', USE_REDIS_STREAMS: 'true', REDIS_URI: 'redis://redis:6379', REDIS_KEY_PREFIX: 'agent',
});
require('/app/node_modules/@librechat/data-schemas').createModels(require('/app/node_modules/mongoose'));
require('/app/node_modules/module-alias')({ base: '/app/api' });
const { registerUser } = require('~/server/services/AuthService');
const connect = require('/app/config/connect');
connect().then(async () => {
  const result = await registerUser({ email: 'private-user@example.test', password: 'Acceptance-User-2026!', confirm_password: 'Acceptance-User-2026!', name: 'Private User', username: 'private-user' }, { emailVerified: true });
  if (result.status !== 200) throw new Error('User fixture failed');
  console.log('Synthetic ordinary user created through native registration.');
  process.exit(0);
}).catch(() => { console.error('Synthetic user initialization failed.'); process.exit(1); });
