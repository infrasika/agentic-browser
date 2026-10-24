import assert from 'node:assert/strict';
import test from 'node:test';
// Deployment helpers run directly under Node and are intentionally plain ESM.
// @ts-expect-error deployment helper has no declaration file
import { mailSettings, mailEnvironment } from '../scripts/librechat-mail.mjs';

const values = { DOMAIN_CLIENT: 'https://demo.example.test', CLOUDFLARE_EMAIL_API_TOKEN: 'test-only-token',
  DEMO_EMAIL_FROM: 'noreply@example.test', DEMO_EMAIL_TEST_TO: 'owner@example.test' };
test('password recovery requires a successful test for the exact mail configuration', () => {
  assert.deepEqual(mailEnvironment({}, undefined), { ALLOW_PASSWORD_RESET: 'false' });
  assert.deepEqual(mailEnvironment(values, undefined), { ALLOW_PASSWORD_RESET: 'false' });
  const config = mailSettings(values);
  const receipt = { fingerprint: config.fingerprint, accepted: true };
  const env = mailEnvironment(values, receipt);
  assert.equal(env.ALLOW_PASSWORD_RESET, 'true');
  assert.equal(env.EMAIL_HOST, 'smtp.mx.cloudflare.net');
  assert.equal(env.EMAIL_PORT, '465');
  assert.equal(env.EMAIL_ENCRYPTION, 'tls');
  assert.equal(env.EMAIL_ALLOW_SELFSIGNED, 'false');
  assert.equal(env.EMAIL_USERNAME, 'api_token');
  assert.deepEqual(mailEnvironment({ ...values, CLOUDFLARE_EMAIL_API_TOKEN: 'changed-token' }, receipt), { ALLOW_PASSWORD_RESET: 'false' });
  assert.deepEqual(mailEnvironment(values, { ...receipt, accepted: false }), { ALLOW_PASSWORD_RESET: 'false' });
});
test('mail settings reject address injection and an insecure recovery origin without echoing secrets', () => {
  assert.throws(() => mailSettings({ ...values, DEMO_EMAIL_FROM: 'sender@example.test\r\nBcc: victim@example.test' }), /Invalid mail address configuration/);
  assert.throws(() => mailSettings({ ...values, DOMAIN_CLIENT: 'http://demo.example.test' }), /Invalid public mail origin/);
});
