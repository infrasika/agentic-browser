import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const address = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
export function mailSettings(values) {
  const keys = ['CLOUDFLARE_EMAIL_API_TOKEN', 'DEMO_EMAIL_FROM', 'DEMO_EMAIL_TEST_TO'];
  const missing = keys.filter(key => !values[key]?.trim());
  if (missing.length) return { ready: false, missing };
  if (!address.test(values.DEMO_EMAIL_FROM) || !address.test(values.DEMO_EMAIL_TEST_TO)) {
    throw new Error('Invalid mail address configuration');
  }
  const origin = new URL(values.DOMAIN_CLIENT);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Invalid public mail origin');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(keys.map(key => values[key]).concat(origin.origin))).digest('hex');
  return { ready: true, fingerprint, env: {
    EMAIL_HOST: 'smtp.mx.cloudflare.net', EMAIL_PORT: '465', EMAIL_ENCRYPTION: 'tls',
    EMAIL_USERNAME: 'api_token', EMAIL_PASSWORD: values.CLOUDFLARE_EMAIL_API_TOKEN,
    EMAIL_FROM: values.DEMO_EMAIL_FROM, EMAIL_FROM_NAME: 'Browser Demo', EMAIL_ALLOW_SELFSIGNED: 'false',
  } };
}

export function mailEnvironment(values, receipt) {
  const config = mailSettings(values);
  if (!config.ready || receipt?.fingerprint !== config.fingerprint || receipt?.accepted !== true) {
    return { ALLOW_PASSWORD_RESET: 'false' };
  }
  return { ...config.env, ALLOW_PASSWORD_RESET: 'true' };
}

async function main() {
  if (process.argv[2] !== 'test') throw new Error('Usage: node scripts/librechat-mail.mjs test');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = resolve(root, '.deployment/librechat');
  const values = parseEnv(await readFile(resolve(directory, 'private.env'), 'utf8'));
  const config = mailSettings(values);
  if (!config.ready) { console.log(JSON.stringify({ ready: false, missing: config.missing })); process.exitCode = 2; return; }
  const require = createRequire(resolve(process.env.LIBRECHAT_CHECKOUT ?? resolve(root, '../librechat-agent'), 'package.json'));
  const nodemailer = require('nodemailer');
  const smtp = nodemailer.createTransport({
    host: config.env.EMAIL_HOST, port: 465, secure: true,
    auth: { user: 'api_token', pass: values.CLOUDFLARE_EMAIL_API_TOKEN },
    tls: { rejectUnauthorized: true }, connectionTimeout: 15000, socketTimeout: 20000,
  });
  try {
    await smtp.verify();
    const sent = await smtp.sendMail({
      from: { name: 'Browser Demo', address: values.DEMO_EMAIL_FROM }, to: values.DEMO_EMAIL_TEST_TO,
      subject: 'Browser Demo — email delivery test',
      text: 'This is the requested Browser Demo email delivery test. Password reset emails will use this sender. No account credentials or reset links are included.',
    });
    if (!sent.accepted?.some(value => String(value).toLowerCase() === values.DEMO_EMAIL_TEST_TO.toLowerCase())) throw new Error('Recipient not accepted');
    await writeFile(resolve(directory, 'mail-verified.json'), JSON.stringify({ fingerprint: config.fingerprint, accepted: true, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    console.log('Cloudflare accepted the test email. Receipt saved; configuration rendering may now enable password reset. Inbox delivery still needs confirmation.');
  } finally { smtp.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Mail verification failed. Check the private mail configuration and Cloudflare sender status. No credentials or SMTP diagnostics were logged.'); process.exitCode = 1; });
}
