import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { IdentityStore } from './identity.js';
import { ProfileStore } from './profiles.js';
import { ServiceError } from './contracts.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const directory = process.env.BROWSER_DATA_DIR ?? '.data';
const [operation, username, profileId] = process.argv.slice(2);
const store = new IdentityStore(join(directory, 'identity'));
async function password() {
  // Interactive-only: passwords never travel in command-line arguments or logs.
  if (!process.stdin.isTTY) throw new Error('Enter the password interactively in a terminal. Password command-line arguments are not accepted.');
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stderr.write('New password (at least 12 characters; input is hidden): ');
    const first = await reader.question('');
    process.stderr.write('\nConfirm password: ');
    const second = await reader.question('');
    process.stderr.write('\n');
    if (first !== second) throw new Error('The passwords do not match.');
    return first;
  } finally { reader.close(); }
}
try {
  if (operation === 'list') console.log(JSON.stringify(store.listMembers(), null, 2));
  else if (operation === 'create' && username) console.log(await store.createMember(username, await password()));
  else if (operation === 'password' && username) { await store.setPassword(username, await password()); console.log('Password updated. Existing credentials have been revoked.'); }
  else if (['disable', 'enable'].includes(operation) && username) console.log(store.setActive(username, operation === 'enable'));
  else if (operation === 'claim-profile' && username && profileId) {
    const member = store.listMembers().find(member => member.username === username && member.active === 1);
    if (!member) throw new Error('The member does not exist or is disabled.');
    await new ProfileStore(directory).assignOwner(profileId, String(member.id));
    console.log('The existing profile has been assigned to this member. Other members cannot access it.');
  } else throw new Error('Usage: npm run members -- list | create <name> | password <name> | disable <name> | enable <name> | claim-profile <name> <profile-id>');
} catch (error) {
  console.error(error instanceof ServiceError ? error.message : 'Member operation failed. Check the command, member name, password length, and whether the profile is in use.');
  process.exitCode = 1;
} finally { store.close(); }
