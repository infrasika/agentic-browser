import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DockerEngine } from '../src/docker-runtime.js';

const exec = promisify(execFile);
test('Docker Runtime: separate processes/files/network, scoped profile mount, handoff, reuse and cleanup', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-runtime-acceptance-'));
  const engine = new DockerEngine({ dataDirectory: root });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const alice = randomUUID(), bob = randomUUID();
  const aProfile = await engine.profiles.create('Synthetic A profile', alice);
  const bProfile = await engine.profiles.create('Synthetic B profile', bob);
  const bLease = await engine.profiles.acquire(bProfile.id, bob);
  await writeFile(join(bLease.directory, 'other-member-fixture'), 'must-not-be-mounted'); await bLease.release();
  process.env.AGENTIC_TEST_PARENT_SECRET = 'synthetic-parent-only';
  t.after(() => { delete process.env.AGENTIC_TEST_PARENT_SECRET; });
  const a = await engine.create({ ownerId: alice, profileId: aProfile.id });
  const b = await engine.create({ ownerId: bob });
  assert.notEqual(a.record.name, b.record.name);
  async function inside(name: string, script: string) {
    return (await exec('docker', ['exec', name, 'node', '--input-type=module', '-e', script])).stdout.trim();
  }
  async function fixtureCookie(name: string, write = false) {
    return inside(name, `import fs from 'node:fs'; import {chromium} from 'playwright';
      let port; for(const id of fs.readdirSync('/proc')) {try {const m=fs.readFileSync('/proc/'+id+'/cmdline','utf8').match(/--remote-debugging-port=(\\d+)/); if(m) {port=m[1];break;}}catch{}}
      const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
      const context=browser.contexts()[0];
      if(${write}) await context.addCookies([{name:'runtime_fixture_cookie',value:'private-A',url:'https://example.test/',expires:Date.now()/1000+3600}]);
      console.log((await context.cookies()).some(c=>c.name==='runtime_fixture_cookie'&&c.value==='private-A'));
      await browser.close();`);
  }
  assert.equal(await fixtureCookie(a.record.name, true), 'true');
  assert.equal(await fixtureCookie(b.record.name), 'false');
  const info = JSON.parse((await exec('docker', ['inspect', a.record.name])).stdout)[0];
  assert.equal(info.HostConfig.NetworkMode, 'none');
  assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
  assert.equal(info.HostConfig.Privileged, false);
  assert.equal(info.HostConfig.Memory, 2 * 1024 ** 3);
  assert.equal(info.HostConfig.PidsLimit, 512);
  assert.equal(info.Config.User, `${process.getuid!()}:${process.getgid!()}`);
  assert.deepEqual(info.HostConfig.PortBindings, {});
  assert.deepEqual(info.Mounts.filter((mount: any) => mount.Type === 'bind').map((mount: any) => mount.Destination), ['/profile']);
  assert.equal(await inside(a.record.name, "console.log(process.env.AGENTIC_TEST_PARENT_SECRET === undefined)"), 'true');
  assert.equal(await inside(a.record.name, `import fs from 'node:fs'; fs.writeFileSync('/tmp/private-A','fixture'); console.log(fs.existsSync(${JSON.stringify(root)}))`), 'false');
  assert.equal(await inside(b.record.name, "import fs from 'node:fs'; console.log(fs.existsSync('/tmp/private-A') || fs.existsSync('/profile'))"), 'false');
  assert.equal(await inside(a.record.name, "import fs from 'node:fs'; console.log(fs.existsSync('/profile/other-member-fixture') || fs.existsSync('/var/run/docker.sock'))"), 'false');
  assert.equal(await inside(a.record.name, "import os from 'node:os'; console.log(Object.values(os.networkInterfaces()).flat().every(i => i.internal))"), 'true');
  await assert.rejects(engine.create({ ownerId: bob, profileId: aProfile.id }));
  await assert.rejects(engine.create({ ownerId: alice, profileId: aProfile.id }));
  assert.equal((await a.perform({ type: 'snapshot' }) as { url: string }).url, 'about:blank');
  await a.setControl('human');
  await assert.rejects(a.perform({ type: 'snapshot' }));
  const stream = a.openDesktop();
  assert.match((await once(stream, 'data'))[0].toString(), /^RFB /);
  const closed = once(stream, 'close');
  await a.setControl('agent'); await closed;
  assert.equal((await a.perform({ type: 'snapshot' }) as { url: string }).url, 'about:blank');
  await a.close();
  const reopened = await engine.create({ ownerId: alice, profileId: aProfile.id });
  assert.equal(await fixtureCookie(reopened.record.name), 'true', 'Synthetic login persists across complete container recreation');
  await reopened.close(); await b.close();
  assert.equal((await readdir(join(root, 'runtimes'))).filter(file => file.endsWith('.json')).length, 0);
  const instance = await readFile(join(root, 'runtimes', 'instance-id'), 'utf8');
  const survivors = (await exec('docker', ['ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`])).stdout.trim();
  assert.equal(survivors, '');
  assert.equal((await engine.profiles.list(alice)).length, 1);
  await engine.profiles.remove(aProfile.id, alice);
});

test('Docker Runtime: public HTTPS works through private proxy; private/metadata targets and direct egress are blocked', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-runtime-egress-'));
  const engine = new DockerEngine({ dataDirectory: root, network: 'public', denyHosts: ['localhost'] });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await engine.create({ ownerId: randomUUID() });
  await workspace.perform({ type: 'navigate', url: 'https://httpbin.org/get?agentic_runtime_fixture=1' });
  const page = await workspace.perform({ type: 'snapshot' }) as { text: string };
  assert.match(page.text, /agentic_runtime_fixture/);
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://169.254.169.254/', 'http://172.17.0.1/', 'http://localhost/']) {
    await workspace.perform({ type: 'navigate', url });
    assert.match((await workspace.perform({ type: 'snapshot' }) as { text: string }).text, /Network target is not allowed/, url);
  }
  await workspace.perform({ type: 'navigate', url: 'https://agentic-browser.invalid/demo' });
  assert.match((await workspace.perform({ type: 'snapshot' }) as { text: string }).text, /演示用户名/);
  const direct = await exec('docker', ['exec', workspace.record.name, 'node', '-e', "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(1500)}).then(()=>console.log('bypassed'),()=>console.log('blocked'))"]);
  assert.equal(direct.stdout.trim(), 'blocked');
  await workspace.close();
  const instance = await readFile(join(root, 'runtimes', 'instance-id'), 'utf8');
  assert.equal((await exec('docker', ['ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`])).stdout.trim(), '');
  assert.equal((await readdir(join(root, 'runtimes'))).some(file => file.endsWith('-proxy')), false);
});

test('Docker Runtime: crashed Chrome/container cannot be reused until verified cleanup; saved profile remains recoverable', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-runtime-crash-'));
  const engine = new DockerEngine({ dataDirectory: root });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const ownerId = randomUUID();
  const profile = await engine.profiles.create('Crash fixture', ownerId);
  const workspace = await engine.create({ ownerId, profileId: profile.id });
  await exec('docker', ['kill', workspace.record.name]);
  await assert.rejects(workspace.perform({ type: 'snapshot' }));
  await workspace.close();
  const reopened = await engine.create({ ownerId, profileId: profile.id });
  assert.equal((await reopened.perform({ type: 'snapshot' }) as { url: string }).url, 'about:blank');
  await reopened.close();
  assert.equal((await readdir(join(root, 'runtimes'))).filter(file => file.endsWith('.json')).length, 0);
});

test('Docker Runtime: an abruptly killed controller leaves a recoverable ledger; restart cleans only its own runtimes', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-controller-crash-'));
  const script = `import {DockerEngine} from ${JSON.stringify(new URL('../src/docker-runtime.ts', import.meta.url).href)};
    const engine = new DockerEngine({dataDirectory:${JSON.stringify(root)}});
    const ownerId=${JSON.stringify(randomUUID())};
    const profile=await engine.profiles.create('Controller crash fixture',ownerId);
    const runtime=await engine.create({ownerId,profileId:profile.id});
    process.stdout.write(JSON.stringify({ownerId,profileId:profile.id,name:runtime.record.name})+'\\n');
    setInterval(()=>{},10000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const engine = new DockerEngine({ dataDirectory: root });
  t.after(async () => { child.kill('SIGKILL'); await engine.close(); await rm(root, { recursive: true, force: true }); });
  const [line] = await once(lines, 'line');
  const record = JSON.parse(line);
  const competitor = new DockerEngine({ dataDirectory: root });
  await assert.rejects(competitor.initialize(), /Another runtime controller/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await engine.initialize();
  assert.equal((await readdir(join(root, 'runtimes'))).filter(file => file.endsWith('.json')).length, 0);
  const restored = await engine.create({ ownerId: record.ownerId, profileId: record.profileId });
  await restored.close();
  assert.equal((await engine.profiles.list(record.ownerId)).length, 1);
});
