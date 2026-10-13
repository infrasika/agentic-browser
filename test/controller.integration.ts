import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chromium, type Browser } from 'playwright';

const exec = promisify(execFile);
test('container controller: scoped mounts, native handoff, saved profile, restart and crash recovery', { timeout: 240000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-compose-test-'));
  const configFile = join(root, 'compose.env'); await writeFile(configFile, '');
  const project = `ab-test-${randomUUID()}`;
  const portProbe = createServer().listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AB_PROJECT_NAME: project, AB_PORT: String(port), AB_PUBLIC_URL: base,
    AB_COMPOSE_ENV_FILE: configFile, AB_MAX_SESSIONS: '1' };
  const compose = async (...args: string[]) => (await exec('bash', ['scripts/compose.sh', ...args], { env, timeout: 120000, maxBuffer: 2 ** 20 })).stdout.trim();
  const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 30000, maxBuffer: 2 ** 20 })).stdout.trim();
  let controller = '', instance = '', browser: Browser | undefined;
  t.after(async () => {
    await browser?.close();
    try { await compose('down', '--timeout', '60'); }
    finally {
      // Only this disposable installation's labelled browser/proxy containers.
      if (instance) for (const id of (await docker('ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`)).split(/\s+/).filter(Boolean)) await docker('rm', '-f', id);
      await compose('down', '--volumes');
      await rm(root, { recursive: true, force: true });
    }
  });
  const rendered = JSON.parse(await compose('config', '--format', 'json'));
  assert.deepEqual(Object.keys(rendered.services), ['controller']);
  assert.equal(rendered.services.controller.ports[0].host_ip, '127.0.0.1');
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  controller = await compose('ps', '-q', 'controller');
  const inside = (source: string) => docker('exec', controller, 'node', '--import', 'tsx', '--input-type=module', '-e', source);
  const detail = JSON.parse(await docker('inspect', controller))[0];
  assert.equal(detail.Config.User, '1000:1000');
  assert.equal(detail.HostConfig.Privileged, false);
  assert.equal(detail.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(detail.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(detail.Mounts.map((m: any) => m.Destination).sort(), ['/data', '/var/run/docker.sock']);
  assert.equal(await inside("console.log(process.getuid())"), '1000');
  assert.match(await docker('exec', controller, 'node', '--import', 'tsx', 'src/doctor.ts'), /PASS 私有数据卷/);
  instance = await inside("import {readFile} from 'node:fs/promises';console.log(await readFile('/data/runtimes/instance-id','utf8'))");
  await inside(`import {IdentityStore} from './src/identity.ts';
    const s=new IdentityStore('/data/identity');
    await s.createMember('alice','synthetic-compose-password'); await s.createMember('bob','synthetic-compose-password'); s.close();
    await (await import('node:fs/promises')).writeFile('/data/controller-only-fixture','private fixture');`);
  browser = await chromium.launch({ headless: true });
  const human = await browser.newContext();
  const other = await browser.newContext();
  const headers = { Origin: base, 'X-Agentic-Browser': '1' };
  for (const [context, username] of [[human, 'alice'], [other, 'bob']] as const) {
    assert.equal((await context.request.post(base + '/api/auth/login', { headers, data: { username, password: 'synthetic-compose-password' } })).status(), 200);
  }
  const profile = await (await human.request.post(base + '/api/profiles', { headers, data: { name: 'Compose fixture' } })).json();
  const key = await (await human.request.post(base + '/api/credentials', { headers, data: { name: 'Compose Agent', profileIds: [profile.id] } })).json();
  const otherKey = await (await other.request.post(base + '/api/credentials', { headers, data: { name: 'Other Agent' } })).json();
  async function agent(path: string, method = 'GET', body?: unknown, token = key.token) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  const create = () => agent('/api/sessions', 'POST', { purpose: 'Synthetic container-controller test', profileId: profile.id, url: 'https://agentic-browser.invalid/demo' });
  assert.equal((await agent('/api/sessions', 'POST', { profileId: profile.id }, otherKey.token)).status, 404);
  const session = await create(); assert.equal(session.status, 201);
  const id = session.data.id;
  assert.equal((await agent(`/api/sessions/${id}`, 'GET', undefined, otherKey.token)).status, 404);
  assert.equal((await create()).status, 429, 'Default single-session quota applies');
  const owned = async () => (await docker('ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`)).split(/\s+/).filter(Boolean);
  const runtimes = JSON.parse(await docker('inspect', ...await owned()));
  assert.equal(runtimes.length, 2, 'One Chrome and its public egress proxy');
  const chrome = runtimes.find((item: any) => item.HostConfig.NetworkMode === 'none');
  for (const item of runtimes) {
    assert.equal(item.HostConfig.Privileged, false);
    assert.equal(item.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(item.HostConfig.PortBindings, {});
    assert.equal(item.HostConfig.GroupAdd?.includes(rendered.services.controller.group_add[0]) ?? false, false);
    for (const mount of item.HostConfig.Mounts) {
      assert.equal(mount.Type, 'volume'); assert.equal(mount.Source, `${project}-data`);
      assert.ok(mount.VolumeOptions.Subpath && mount.VolumeOptions.Subpath !== '.');
      assert.ok(!mount.VolumeOptions.Subpath.includes('..'));
      assert.notEqual(mount.Target, '/var/run/docker.sock');
    }
  }
  assert.equal(chrome.HostConfig.Mounts.find((m: any) => m.Target === '/profile').VolumeOptions.Subpath, `profiles/${profile.id}/chrome`);
  const inChrome = (source: string) => docker('exec', chrome.Id, 'node', '--input-type=module', '-e', source);
  assert.equal(await inChrome("import fs from 'node:fs';console.log(fs.existsSync('/var/run/docker.sock') || fs.existsSync('/data/identity/identity.sqlite') || fs.existsSync('/profile/controller-only-fixture'))"), 'false');
  await agent(`/api/sessions/${id}/actions`, 'POST', { type: 'click', selector: '#username' });
  assert.equal((await agent(`/api/sessions/${id}/handoff`, 'POST', {})).status, 200);
  assert.equal((await agent(`/api/sessions/${id}/actions`, 'POST', { type: 'snapshot' })).status, 409);
  const page = await human.newPage(); await page.goto(session.data.humanUrl);
  const connected = () => page.waitForFunction(() => document.getElementById('connection')?.textContent === '连接正常' && !!document.querySelector('#desktop canvas'));
  await connected(); await page.reload(); await connected();
  await page.locator('#text').fill('compose-native-fixture'); await page.locator('#send-text').click();
  await page.locator('#desktop canvas').focus(); await page.keyboard.press('Tab');
  await page.keyboard.type('fictional-site-password'); await page.keyboard.press('Enter');
  await new Promise(resolve => setTimeout(resolve, 600));
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.getElementById('message')?.textContent?.startsWith('已交还'));
  assert.match((await agent(`/api/sessions/${id}/actions`, 'POST', { type: 'snapshot' })).data.result.text, /已登录：compose-native-fixture/);
  await page.close();
  // Diagnostic only, after handback: inspect the sandbox and create a fake
  // persisted cookie. No real accounts or production Profiles are involved.
  const cdp = `import fs from 'node:fs'; import {chromium} from 'playwright';
    let port;for(const id of fs.readdirSync('/proc')){try{const m=fs.readFileSync('/proc/'+id+'/cmdline','utf8').match(/--remote-debugging-port=(\\d+)/);if(m){port=m[1];break;}}catch{}}
    const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});const context=browser.contexts()[0];`;
  const sandbox = await inChrome(cdp + `const p=await context.newPage();await p.goto('chrome://sandbox');console.log(await p.locator('body').innerText());await p.close();
    await context.addCookies([{name:'compose_fixture',value:'alice-only',url:'https://example.test/',expires:Date.now()/1000+3600}]);await browser.close();`);
  assert.match(sandbox, /Layer 1 Sandbox\s+Namespace/i); assert.match(sandbox, /Seccomp-BPF[\s\S]*Yes/i);
  assert.equal((await agent(`/api/sessions/${id}`, 'DELETE')).status, 200);
  assert.deepEqual(await owned(), []);
  // Recreate the controller (new hostname/PID) while retaining its named volume.
  const oldController = controller;
  await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90');
  controller = await compose('ps', '-q', 'controller'); assert.notEqual(controller, oldController);
  assert.equal((await human.request.get(base + '/api/auth/me')).status(), 200);
  const reopened = await create(); assert.equal(reopened.status, 201);
  const newChrome = JSON.parse(await docker('inspect', ...await owned())).find((item: any) => item.HostConfig.NetworkMode === 'none');
  assert.equal(await docker('exec', newChrome.Id, 'node', '--input-type=module', '-e', cdp + `console.log((await context.cookies()).some(c=>c.name==='compose_fixture'&&c.value==='alice-only'));await browser.close();`), 'true');
  // SIGKILL leaves a ledger; the next controller must reap only its own children.
  await compose('kill', '-s', 'SIGKILL', 'controller');
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  controller = await compose('ps', '-q', 'controller');
  assert.deepEqual(await owned(), []);
  assert.deepEqual((await agent('/api/sessions')).data.sessions, []);
  const recovered = await create(); assert.equal(recovered.status, 201);
  await compose('stop', '--timeout', '60', 'controller');
  assert.deepEqual(await owned(), [], 'Graceful stop also reclaims active Chrome and proxy');
  assert.equal(await docker('volume', 'inspect', `${project}-data`, '--format', '{{.Name}}'), `${project}-data`, 'Stop retains saved data');
});
