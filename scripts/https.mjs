#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

assert.equal(process.argv.length, 2, 'Usage: npm run test:https');
assert.equal(process.platform, 'linux', 'This verifier uses Linux Nginx and NSS; Mac acceptance is separate');
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'Certificate verification must remain enabled');
const root = mkdtempSync(join(tmpdir(), 'ab-https-trust-'));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed; install openssl, nginx and libnss3-tools before running this verifier`);
}
let status = 1;
try {
  // The private CA and its trust database live only in this disposable directory.
  // Never modify the system or the user's browser certificate store.
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Agentic Browser synthetic acceptance CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', join(root, 'ca.key'), '-out', join(root, 'ca.crt')]);
  run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
    '-keyout', join(root, 'server.key'), '-out', join(root, 'server.csr')]);
  writeFileSync(join(root, 'server.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
  run('openssl', ['x509', '-req', '-in', join(root, 'server.csr'), '-CA', join(root, 'ca.crt'), '-CAkey', join(root, 'ca.key'),
    '-CAcreateserial', '-days', '2', '-extfile', join(root, 'server.ext'), '-out', join(root, 'server.crt')]);
  const database = join(root, 'browser-home/.local/share/pki/nssdb');
  mkdirSync(database, { recursive: true });
  run('certutil', ['-N', '-d', `sql:${database}`, '--empty-password']);
  run('certutil', ['-A', '-d', `sql:${database}`, '-n', 'Synthetic acceptance CA', '-t', 'C,,', '-i', join(root, 'ca.crt')]);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/self-host.integration.ts'], {
    env: { ...process.env, AB_ACCEPTANCE_HTTPS_DIR: root, NODE_EXTRA_CA_CERTS: join(root, 'ca.crt'),
      AB_ACCEPTANCE_REMOTE_CLIENT: '0', AB_ACCEPTANCE_EXPERIENCE_MINUTES: '0' }, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
process.exit(status);
