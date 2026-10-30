require('@librechat/data-schemas').createModels(require('mongoose'));
require('module-alias')({ base: '/app/api' });
const { bootstrapBrowserDemo } = require('@librechat/api');
const { registerUser } = require('~/server/services/AuthService');
const { grantPermission } = require('~/server/services/PermissionService');
const db = require('~/models');
require('/app/config/connect')()
  .then(() => db.seedDatabase())
  .then(() => bootstrapBrowserDemo({
    email: process.env.DEMO_ADMIN_EMAIL, password: process.env.DEMO_ADMIN_PASSWORD,
    model: process.env.QWEN_MODEL, agentId: 'agent_browser_demo', provider: 'Qwen',
    administratorName: 'Administrator', administratorUsername: 'administrator',
    definition: require('/tmp/agent/definition.json'),
  }, { ...db, registerUser, grantPermission }))
  .then(() => { console.log('Agent administrator and browser tools are ready.'); process.exit(0); })
  .catch(() => { console.error('Agent initialization failed; existing accounts were preserved.'); process.exit(1); });
