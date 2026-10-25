import { createRequire } from 'node:module';
import { loadRuntime } from './environment.mjs';
import { testMail } from './mail.mjs';
const require = createRequire('/app/package.json');
const action = process.argv[2];
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 16384) throw new Error('Input too large'); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const { config, credentials } = await loadRuntime();
  if (action === 'mail-test') {
    const receipt = await testMail(config, credentials, input.to, require('nodemailer'));
    console.log('AGENT_RESULT=' + JSON.stringify(receipt));
  } else {
    // Offline operator authority; no email is sent by account creation/recovery.
    for (const key of ['EMAIL_HOST','EMAIL_SERVICE','EMAIL_FROM','EMAIL_USERNAME','EMAIL_PASSWORD','MAILGUN_API_KEY','MAILGUN_DOMAIN']) delete process.env[key];
    const { z } = require('zod');
    const account = z.object({ email: z.string().trim().email().transform(v => v.toLowerCase()),
      password: z.string().min(12).max(128), name: z.string().min(1).max(100).optional(),
      username: z.string().regex(/^[a-zA-Z0-9_-]{3,40}$/).optional() }).strict().parse(input);
    require('@librechat/data-schemas').createModels(require('mongoose'));
    require('module-alias')({ base: '/app/api' });
    const db = require('/app/api/models');
    const auth = require('/app/api/server/services/AuthService');
    await require('/app/config/connect')();
    const admin = await db.findUser({ email: config.adminEmail }, 'role');
    if (admin?.role !== 'ADMIN') throw new Error('Administrator must be initialized');
    const user = await db.findUser({ email: account.email }, '_id email provider username');
    let result;
    if (action === 'user-create') {
      if (!account.name || !account.username) throw new Error('Name and username required');
      if (user) result = { status: 'already_exists' };
      else {
        if (await db.findUser({ username: account.username }, '_id')) throw new Error('Username already used');
        const created = await auth.registerUser({ ...account, confirm_password: account.password }, { emailVerified: true, role: 'USER' });
        if (created.status !== 200 || !created.userCreated) throw new Error('Creation failed');
        result = { status: 'created', role: 'USER' };
      }
    } else if (action === 'user-reset') {
      if (!user || user.provider !== 'local') throw new Error('Local account required');
      const reset = await auth.requestPasswordReset({ body: { email: account.email } });
      if (!reset.link) throw new Error('Cannot issue recovery');
      const url = new URL(reset.link), userId = String(user._id);
      const outcome = await auth.resetPassword(userId, url.searchParams.get('token'), account.password);
      if (outcome instanceof Error) throw new Error('Recovery failed');
      try {
        await Promise.all([db.deleteAllUserSessions({ userId }), db.deletePasskeysByUser(userId)]);
      } finally { await db.awaitAuthUserDocEviction(userId); }
      result = { status: 'password_reset', sessionsRevoked: true };
    } else throw new Error('Unknown action');
    console.log('AGENT_RESULT=' + JSON.stringify(result));
  }
  process.exit(0);
} catch {
  console.error('Operator command failed. Check input/configuration and service readiness. No private diagnostics were emitted.');
  process.exit(1);
}
