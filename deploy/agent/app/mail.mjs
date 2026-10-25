import { createHash } from 'node:crypto';

export function mailConfiguration(config, credentials, receipt) {
  if (!config.smtp) return { enabled: false, env: { ALLOW_PASSWORD_RESET: 'false' } };
  const smtp = config.smtp;
  const fingerprint = createHash('sha256').update(JSON.stringify([smtp, credentials.SMTP_PASSWORD, config.origin])).digest('hex');
  const enabled = receipt?.fingerprint === fingerprint && receipt?.accepted === true;
  return { fingerprint, enabled, env: enabled ? {
    ALLOW_PASSWORD_RESET: 'true', EMAIL_HOST: smtp.host, EMAIL_PORT: String(smtp.port),
    EMAIL_ENCRYPTION: smtp.encryption, EMAIL_USERNAME: smtp.username,
    EMAIL_PASSWORD: credentials.SMTP_PASSWORD, EMAIL_FROM: smtp.from, EMAIL_FROM_NAME: config.name,
    EMAIL_ALLOW_SELFSIGNED: 'false',
  } : { ALLOW_PASSWORD_RESET: 'false' } };
}

export async function testMail(config, credentials, recipient, nodemailer) {
  if (!config.smtp || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient)) throw new Error('Mail configuration required');
  const smtp = config.smtp;
  const transport = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.encryption === 'tls', requireTLS: smtp.encryption === 'starttls',
    ...(smtp.username ? { auth: { user: smtp.username, pass: credentials.SMTP_PASSWORD } } : {}),
    tls: { rejectUnauthorized: true }, connectionTimeout: 15000, socketTimeout: 20000,
  });
  try {
    await transport.verify();
    const result = await transport.sendMail({ from: { name: config.name, address: smtp.from }, to: recipient,
      subject: 'Agentic Browser — mail test', text: 'This is the requested mail configuration test. It contains no account credentials.' });
    if (!result.accepted?.some(address => String(address).toLowerCase() === recipient.toLowerCase())) throw new Error('Recipient rejected');
    return { fingerprint: mailConfiguration(config, credentials).fingerprint, accepted: true, at: new Date().toISOString() };
  } finally { transport.close(); }
}
