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
  if (!process.stdin.isTTY) throw new Error('请在终端交互输入密码；不接受命令行参数。');
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stderr.write('新密码（至少 12 字符，不显示输入）：');
    const first = await reader.question('');
    process.stderr.write('\n再次输入：');
    const second = await reader.question('');
    process.stderr.write('\n');
    if (first !== second) throw new Error('两次密码不同。');
    return first;
  } finally { reader.close(); }
}
try {
  if (operation === 'list') console.log(JSON.stringify(store.listMembers(), null, 2));
  else if (operation === 'create' && username) console.log(await store.createMember(username, await password()));
  else if (operation === 'password' && username) { await store.setPassword(username, await password()); console.log('密码已更新，已有凭据全部撤销。'); }
  else if (['disable', 'enable'].includes(operation) && username) console.log(store.setActive(username, operation === 'enable'));
  else if (operation === 'claim-profile' && username && profileId) {
    const member = store.listMembers().find(member => member.username === username && member.active === 1);
    if (!member) throw new Error('目标成员不存在或已停用。');
    await new ProfileStore(directory).assignOwner(profileId, String(member.id));
    console.log('旧配置归属已明确分配；其他成员仍不可访问。');
  } else throw new Error('用法：npm run members -- list | create <name> | password <name> | disable <name> | enable <name> | claim-profile <name> <profile-id>');
} catch (error) {
  console.error(error instanceof ServiceError ? error.message : '成员操作失败；请检查命令、成员名、密码长度和配置是否正在使用。');
  process.exitCode = 1;
} finally { store.close(); }
