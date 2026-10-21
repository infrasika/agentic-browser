import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const exec = promisify(execFile);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const versions = ['v0.1.0', 'v0.1.1'] as const;

test('published upgrade and offline restore: profiles, ownership and credential history', { timeout: 1200000 }, async t => {
  const started = Date.now(), id = randomUUID();
  const project = `ab-upgrade-${id}`, recoveryProject = `ab-restore-${id}`;
  const root = await mkdtemp(join(tmpdir(), 'ab-upgrade-'));
  const original = join(root, 'original'), recovered = join(root, 'recovered'), backup = join(root, 'backup');
  const evidence = resolve('output/upgrade', `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`);
  await mkdir(evidence, { recursive: true }); await mkdir(original); await mkdir(recovered);
  const report: Record<string, any> = { startedAt: new Date(started).toISOString(), from: versions[0], to: versions[1],
    host: { platform: platform(), arch: arch(), release: release() }, passed: false, checks: [] };
  async function record(name: string, details: Record<string, unknown> = {}) {
    report.checks.push({ name, elapsedMs: Date.now() - started, ...details });
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`[upgrade] ${name}`);
  }
  const registry = join(root, 'empty-registry'); await mkdir(registry); await writeFile(join(registry, 'config.json'), '{}', { mode: 0o600 });
  const plugins = JSON.parse((await exec('docker', ['info', '--format', '{{json .ClientInfo.Plugins}}'])).stdout);
  const plugin = plugins.find((value: { Name: string }) => value.Name === 'compose'); assert.ok(plugin);
  await mkdir(join(registry, 'cli-plugins')); await symlink(plugin.Path, join(registry, 'cli-plugins/docker-compose'));
  const endpoint = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT ? process.env.DOCKER_HOST :
    (await exec('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
  assert.ok(endpoint.startsWith('unix://'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AB_') && !key.startsWith('COMPOSE_') &&
    !['DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_AUTH_CONFIG', 'DOCKER_DEFAULT_PLATFORM'].includes(key)));
  Object.assign(env, { DOCKER_CONFIG: registry, DOCKER_HOST: endpoint });
  const docker = async (...args: string[]) => (await exec('docker', args, { env, timeout: 300000, maxBuffer: 4 * 2 ** 20 })).stdout.trim();
  const composeAt = (directory: string, ...args: string[]) => docker('compose', '--project-directory', directory, '--env-file', join(directory, '.env'), '-f', join(directory, 'compose.yaml'), ...args);
  let directory = original, controller = '', holder = '';
  const compose = (...args: string[]) => composeAt(directory, ...args);
  const inside = (code: string) => docker('exec', controller, 'node', '--import', 'tsx', '--input-type=module', '-e', code);
  const backupScript = resolve('scripts/workspace-backup.sh');
  const manage = (...args: string[]) => exec('bash', [backupScript, ...args], { cwd: original, env, timeout: 180000, maxBuffer: 2 ** 20 });
  const instances = new Set<string>(), clients = new Set<Client>();
  const configured = new Set<string>();
  const restoredVolume = `${recoveryProject}-data`, corruptVolume = `${project}-corrupt`;
  async function owned() {
    const ids = new Set<string>();
    for (const instance of instances)
      for (const value of (await docker('ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`)).split(/\s+/).filter(Boolean)) ids.add(value);
    return [...ids];
  }
  t.after(async () => {
    const errors: string[] = [];
    await Promise.allSettled([...clients].map(client => client.close()));
    if (holder) try { await docker('rm', '-f', holder); } catch { errors.push('fixture holder cleanup failed'); }
    for (const path of configured) try { await composeAt(path, 'down', '--timeout', '60'); } catch { errors.push('controller cleanup failed'); }
    try { for (const value of await owned()) await docker('rm', '-f', value); } catch { errors.push('scoped browser cleanup failed'); }
    for (const path of configured) try { await composeAt(path, 'down', '--volumes'); } catch { errors.push('Compose volume cleanup failed'); }
    try {
      const remaining = (await docker('volume', 'ls', '--format', '{{.Name}}')).split('\n');
      for (const volume of [restoredVolume, corruptVolume]) if (remaining.includes(volume)) await docker('volume', 'rm', volume);
      assert.deepEqual(await owned(), []);
      for (const name of [project, recoveryProject]) {
        assert.equal(await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${name}`), '');
        assert.equal(await docker('volume', 'ls', '-q', '--filter', `name=^${name}-data$`), '');
      }
    } catch { errors.push('disposable resources remain'); }
    if (!errors.length) await rm(root, { recursive: true, force: true });
    report.cleanupErrors = errors; report.elapsedMs = Date.now() - started;
    report.passed = report.scenariosPassed === true && errors.length === 0;
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    t.diagnostic(`Evidence: ${evidence}/report.json`);
    assert.deepEqual(errors, []);
  });
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, signal: AbortSignal.timeout(30000) });
  const headers = (cookie: string) => ({ Origin: base, 'X-Agentic-Browser': '1', 'Content-Type': 'application/json', Cookie: cookie });
  const password = 'synthetic-upgrade-$password#fixture';
  async function login(username: string) {
    const response = await request('/api/auth/login', { method: 'POST', headers: headers(''), body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie')!.split(';')[0];
  }
  async function human(cookie: string, path: string, method = 'GET', body?: unknown) {
    const response = await request(path, { method, headers: headers(cookie), body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${path}: ${response.status}`); return response.json();
  }
  async function tokenStatus(token: string) {
    return (await request('/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).status;
  }
  async function connect(token: string) {
    const client = new Client({ name: 'synthetic-upgrade-fixture', version: '1' }); clients.add(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    assert.equal((await client.listTools()).tools.length, 11); return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, `${name} failed`);
    return JSON.parse((result.content as { text: string }[])[0].text);
  }
  async function start() {
    configured.add(directory); await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90');
    controller = await compose('ps', '-q', 'controller');
    const instance = await inside("import fs from 'node:fs';console.log(fs.readFileSync('/data/runtimes/instance-id','utf8'))");
    assert.match(instance, /^[a-f0-9-]{36}$/); instances.add(instance);
    assert.match(await compose('exec', '-T', 'controller', 'npm', 'run', 'doctor'), /PASS Private data volume/);
  }
  async function stopped() {
    for (const client of clients) await client.close(); clients.clear();
    await compose('stop', '--timeout', '60', 'controller'); assert.deepEqual(await owned(), []);
  }
  type Member = { name: string; profile: string; token: string };
  async function profileState(member: Member, expected: string | null, write?: string) {
    const client = await connect(member.token);
    const session = await call(client, 'browser_create', { purpose: 'Synthetic upgrade acceptance', profileId: member.profile, url: 'https://agentic-browser.invalid/demo' });
    const runtime = JSON.parse(await docker('inspect', ...await owned())).find((item: any) => item.HostConfig.NetworkMode === 'none'); assert.ok(runtime);
    const state = JSON.parse(await docker('exec', runtime.Id, 'node', '--input-type=module', '-e', `
      import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium} from 'playwright';
      let port;for(const id of fs.readdirSync('/proc')){try{const m=fs.readFileSync('/proc/'+id+'/cmdline','utf8').match(/--remote-debugging-port=(\\d+)/);if(m){port=m[1];break;}}catch{}}
      const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});const context=browser.contexts()[0];
      const lock=JSON.parse(fs.readFileSync('/app/runtime/assets.lock.json','utf8'));
      const expected=${JSON.stringify(expected)},write=${JSON.stringify(write ?? null)};
      const page=context.pages().find(p=>p.url()==='http://127.0.0.1:8080/demo');assert.ok(page);
      const cookie=(await context.cookies()).find(c=>c.name==='upgrade_fixture')?.value??null;
      const storage=await page.evaluate(()=>localStorage.getItem('upgrade_fixture'));
      assert.equal(cookie,expected);assert.equal(storage,expected);
      if(write!==null){await context.addCookies([{name:'upgrade_fixture',value:write,url:'https://example.test/',expires:Date.now()/1000+3600}]);await page.evaluate(v=>localStorage.setItem('upgrade_fixture',v),write);}
      console.log(JSON.stringify({chrome:browser.version(),extensionsChecked:false}));await browser.close();`));
    await call(client, 'browser_close', { sessionId: session.id }); await client.close(); clients.delete(client); assert.deepEqual(await owned(), []);
    return state;
  }
  async function isolated(alice: Member, bob: Member) {
    const aliceCookie = await login(alice.name), bobCookie = await login(bob.name);
    assert.ok(!(await human(bobCookie, '/api/profiles')).profiles.some((p: any) => p.id === alice.profile));
    assert.ok(!(await human(aliceCookie, '/api/profiles')).profiles.some((p: any) => p.id === bob.profile));
    const result = await request('/api/sessions', { method: 'POST', headers: { Authorization: `Bearer ${bob.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: alice.profile }) });
    assert.equal(result.status, 404);
  }
  report.verifierRevision = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  report.sourceHashes = Object.fromEntries(await Promise.all(['test/upgrade.integration.ts', 'scripts/workspace-backup.sh'].map(async path => [path, hash(await readFile(path))])));
  report.workflow = process.env.GITHUB_ACTIONS === 'true' ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const server = JSON.parse(await docker('version', '--format', '{{json .Server}}'));
  report.docker = { version: server.Version, os: server.Os, arch: server.Arch }; report.composeVersion = await docker('compose', 'version', '--short');
  assert.equal(server.Os, 'linux'); assert.equal(server.Arch, arch() === 'arm64' ? 'arm64' : 'amd64');
  const receipts = await Promise.all(versions.map(async version => JSON.parse(await readFile(`deploy/releases/${version}-public-verification.json`, 'utf8'))));
  report.images = {};
  for (const receipt of receipts) {
    report.images[receipt.version] = {};
    for (const role of ['controller', 'runtime']) {
      const reference = receipt.images[role].reference; await docker('pull', reference);
      const image = JSON.parse(await docker('image', 'inspect', reference))[0]; assert.equal(image.Architecture, server.Arch);
      report.images[receipt.version][role] = { reference, id: image.Id, platform: `${image.Os}/${image.Architecture}`, anonymousPull: true };
    }
  }
  const current = receipts[1].images;
  const socket = platform() === 'darwin' ? '/var/run/docker.sock' : endpoint.slice('unix://'.length);
  const group = await docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--mount', `type=bind,src=${socket},dst=/var/run/docker.sock`, current.controller.reference, 'stat', '-c', '%g', '/var/run/docker.sock');
  assert.match(group, /^\d+$/);
  const composeText = await readFile('compose.yaml', 'utf8'); await writeFile(join(original, 'compose.yaml'), composeText);
  function settings(index: number, name = project) {
    return `AB_PROJECT_NAME=${name}\nAB_MODE=authenticated\nAB_PORT=${port}\nAB_BIND_ADDRESS=127.0.0.1\nAB_PUBLIC_URL=${base}\nAB_MAX_SESSIONS=1\nAB_DOCKER_SOCKET='${socket}'\nAB_DOCKER_GID=${group}\nAB_CONTROLLER_IMAGE=${receipts[index].images.controller.reference}\nAB_RUNTIME_IMAGE=${receipts[index].images.runtime.reference}\n`;
  }
  await writeFile(join(original, '.env'), settings(0) + `AB_ADMIN_USERNAME=alice\nAB_ADMIN_PASSWORD='${password}'\n`, { mode: 0o600 });
  await start(); await inside(`import {IdentityStore} from './src/identity.ts';const store=new IdentityStore('/data/identity');await store.createMember('bob',${JSON.stringify(password)});store.close();`);
  const members: Member[] = [];
  for (const name of ['alice', 'bob']) {
    const cookie = await login(name); const profile = await human(cookie, '/api/profiles', 'POST', { name: `Synthetic ${name} profile` });
    const key = await human(cookie, '/api/credentials', 'POST', { name: `Synthetic ${name} Agent`, profileIds: [profile.id] });
    members.push({ name, profile: profile.id, token: key.token });
    report.baselineAssets = await profileState(members.at(-1)!, null, `before-${name}`);
  }
  const [alice, bob] = members; let cookie = await login('alice');
  const revoked = await human(cookie, '/api/credentials', 'POST', { name: 'Revoked before backup' });
  const laterRevoked = await human(cookie, '/api/credentials', 'POST', { name: 'Revoked after backup' });
  await human(cookie, `/api/credentials/${revoked.id}`, 'DELETE'); assert.equal(await tokenStatus(revoked.token), 401);
  await isolated(alice, bob);
  await assert.rejects(manage('backup', controller, join(root, 'refused-live')), /Stop the controller/);
  await stopped();
  holder = await docker('run', '-d', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--mount', `type=volume,src=${project}-data,dst=/data,readonly`, receipts[0].images.controller.reference, 'node', '-e', 'setInterval(()=>{},1000)');
  await assert.rejects(manage('backup', controller, join(root, 'refused-mounted')), /Stop every controller and browser/);
  await docker('rm', '-f', holder); holder = '';
  await manage('backup', controller, backup);
  assert.equal((await stat(backup)).mode & 0o777, 0o700); assert.equal((await stat(join(backup, '.env'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(backup, '.env'), 'utf8'), await readFile(join(original, '.env'), 'utf8'));
  assert.equal(await readFile(join(backup, 'compose.yaml'), 'utf8'), composeText);
  await assert.rejects(manage('backup', controller, backup));
  report.backup = { bytes: (await stat(join(backup, 'data.tar.gz'))).size, sha256: hash(await readFile(join(backup, 'data.tar.gz'))) };
  await record(`stopped ${versions[0]} workspace backed up; live/mounted volume and overwrite guards passed`);
  await writeFile(join(original, '.env'), settings(1)); await start();
  report.upgradedAssets = await profileState(alice, 'before-alice', 'after-upgrade');
  await profileState(bob, 'before-bob'); await isolated(alice, bob);
  assert.equal(await tokenStatus(revoked.token), 401);
  cookie = await login('alice');
  const addedProfile = await human(cookie, '/api/profiles', 'POST', { name: 'Created after backup' });
  const addedKey = await human(cookie, '/api/credentials', 'POST', { name: 'Created after backup' });
  await human(cookie, `/api/credentials/${laterRevoked.id}`, 'DELETE'); assert.equal(await tokenStatus(laterRevoked.token), 401);
  await assert.rejects(manage('restore', backup, `${project}-data`), /already exists/);
  await profileState(alice, 'after-upgrade');
  await record(`${versions[1]} preserves accounts, tokens, account isolation and website state`);
  await stopped();
  const corrupt = join(root, 'corrupt'); await cp(backup, corrupt, { recursive: true });
  const archive = await open(join(corrupt, 'data.tar.gz'), 'r+'); await archive.write(Buffer.from([0]), 0, 1, 0); await archive.close();
  await assert.rejects(manage('restore', corrupt, corruptVolume), /checksum mismatch/);
  assert.equal(await docker('volume', 'ls', '-q', '--filter', `name=^${corruptVolume}$`), '');
  await manage('restore', backup, restoredVolume);
  // Keep the upgraded original volume intact. The restored backup uses its own
  // external volume and old image pins; the original controller stays stopped.
  await writeFile(join(recovered, 'compose.yaml'), composeText.replace('volumes:\n  data:\n', 'volumes:\n  data:\n    external: true\n'));
  await writeFile(join(recovered, '.env'), (await readFile(join(backup, '.env'), 'utf8')).replace(`AB_PROJECT_NAME=${project}`, `AB_PROJECT_NAME=${recoveryProject}`), { mode: 0o600 });
  directory = recovered; await start();
  report.restoredAssets = await profileState(alice, 'before-alice'); await profileState(bob, 'before-bob'); await isolated(alice, bob);
  cookie = await login('alice');
  assert.ok(!(await human(cookie, '/api/profiles')).profiles.some((profile: any) => profile.id === addedProfile.id));
  assert.equal(await tokenStatus(addedKey.token), 401); assert.equal(await tokenStatus(revoked.token), 401);
  assert.equal(await tokenStatus(laterRevoked.token), 200, 'Restoring an older identity database also restores its older revocation state');
  assert.deepEqual(report.upgradedAssets, report.baselineAssets); assert.deepEqual(report.restoredAssets, report.baselineAssets);
  report.browserVersionChanged = false; report.extensionVersionsChanged = false;
  await record('checksum corruption rejected; fresh-volume rollback restores exact pre-upgrade profile and identity state');
  await inside("import {IdentityStore} from './src/identity.ts';const store=new IdentityStore('/data/identity');await store.setPassword('alice','rotated-synthetic-restore-password');store.close();");
  assert.equal(await tokenStatus(alice.token), 401); assert.equal(await tokenStatus(laterRevoked.token), 401); assert.equal(await tokenStatus(bob.token), 200);
  await record('post-backup revocations require reapplication; password rotation invalidates restored member tokens');
  report.scenariosPassed = true;
});
