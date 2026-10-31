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
const image = process.env.BROWSER_RUNTIME_IMAGE;
if (!image) throw new Error("Set BROWSER_RUNTIME_IMAGE to the installed runtime being verified");
test('Docker volume subpaths: only the authorised proxy directory is mounted', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-volume-acceptance-'));
  const volumeName = `agentic-test-${randomUUID()}`;
  await writeFile(join(root, 'controller-only-fixture'), 'must-not-be-mounted');
  // A test-only local volume backed by our own disposable directory lets the
  // host controller verify real Docker volume subpaths without granting any
  // container access to the Docker daemon or unrelated host paths.
  await exec('docker', ['volume', 'create', '--driver', 'local', '--opt', 'type=none', '--opt', 'o=bind', '--opt', `device=${root}`, volumeName]);
  const engine = new DockerEngine({ image, dataDirectory: root, volume: { name: volumeName, root }, network: 'public' });
  t.after(async () => { await engine.close(); await exec('docker', ['volume', 'rm', volumeName]); await rm(root, { recursive: true, force: true }); });
  const alice = randomUUID();
  const workspace = await engine.create({ ownerId: alice });
  const details = JSON.parse((await exec('docker', ['inspect', workspace.record.name])).stdout)[0];
  assert.deepEqual(details.Mounts.filter((mount: any) => mount.Type === 'volume').map((mount: any) => mount.Destination).sort(), ['/egress']);
  for (const mount of details.HostConfig.Mounts) {
    assert.equal(mount.Type, 'volume'); assert.equal(mount.Source, volumeName);
    assert.ok(mount.VolumeOptions.Subpath && mount.VolumeOptions.Subpath !== '.');
    assert.ok(!mount.VolumeOptions.Subpath.includes('..'));
  }
  const inside = async (source: string) => (await exec('docker', ['exec', workspace.record.name, 'node', '-e', source])).stdout.trim();
  assert.equal(await inside("const fs=require('fs'); console.log(fs.existsSync('/data/controller-only-fixture') || fs.existsSync('/profile/controller-only-fixture') || fs.existsSync('/profile/private-other-member') || fs.existsSync('/var/run/docker.sock'))"), 'false');
  // Product navigation intentionally accepts HTTP(S) only. The fixture uses
  // container-local CDP to inspect Chrome's own diagnostic page, never an API.
  const sandbox = await inside(`(async()=>{const fs=require('fs'),{chromium}=require('playwright');
    let port; for(const id of fs.readdirSync('/proc')) {try {const m=fs.readFileSync('/proc/'+id+'/cmdline','utf8').match(/--remote-debugging-port=(\\d+)/); if(m) {port=m[1];break;}}catch{}}
    const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
    const page=await browser.contexts()[0].newPage(); await page.goto('chrome://sandbox');
    console.log(await page.locator('body').innerText()); await page.close(); await browser.close();
  })().catch(()=>process.exit(1));`);
  assert.match(sandbox, /Layer 1 Sandbox\s+Namespace/i);
  assert.match(sandbox, /PID namespaces\s+Yes/i);
  assert.match(sandbox, /Seccomp-BPF[\s\S]*Yes/i);
  await workspace.perform({ type: 'navigate', url: 'http://169.254.169.254/' });
  assert.match((await workspace.perform({ type: 'snapshot' }) as { text: string }).text, /Network target is not allowed/);
  await workspace.perform({ type: 'navigate', url: 'https://httpbin.org/anything/agentic-browser-acceptance' });
  await workspace.setControl('human');
  const stream = workspace.openDesktop(); assert.match((await once(stream, 'data'))[0].toString(), /^RFB /);
  const closed = once(stream, 'close'); await workspace.setControl('agent'); await closed;
  assert.match((await workspace.perform({ type: 'snapshot' }) as { text: string }).text, /agentic-browser-acceptance/);
  await workspace.close();
  assert.equal((await readdir(join(root, 'runtimes'))).filter(file => file.endsWith('.json')).length, 0);
});

test('Docker Runtime: separate processes/files/network, no persistent login state, handoff and cleanup', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-runtime-acceptance-'));
  const engine = new DockerEngine({ image, dataDirectory: root });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const alice = randomUUID(), bob = randomUUID();
  process.env.AGENTIC_TEST_PARENT_SECRET = 'synthetic-parent-only';
  t.after(() => { delete process.env.AGENTIC_TEST_PARENT_SECRET; });
  const a = await engine.create({ ownerId: alice });
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
      if(await context.pages()[0].evaluate(()=>navigator.onLine)) throw new Error('Network-disabled runtime must remain offline');
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
  assert.deepEqual(info.Mounts.filter((mount: any) => mount.Type === 'bind').map((mount: any) => mount.Destination), []);
  assert.equal(await inside(a.record.name, "console.log(process.env.AGENTIC_TEST_PARENT_SECRET === undefined)"), 'true');
  assert.equal(await inside(a.record.name, `import fs from 'node:fs'; fs.writeFileSync('/tmp/private-A','fixture'); console.log(fs.existsSync(${JSON.stringify(root)}))`), 'false');
  assert.equal(await inside(b.record.name, "import fs from 'node:fs'; console.log(fs.existsSync('/tmp/private-A') || fs.existsSync('/profile'))"), 'false');
  assert.equal(await inside(a.record.name, "import fs from 'node:fs'; console.log(fs.existsSync('/profile/other-member-fixture') || fs.existsSync('/var/run/docker.sock'))"), 'false');
  assert.equal(await inside(a.record.name, "import os from 'node:os'; console.log(Object.values(os.networkInterfaces()).flat().every(i => i.internal))"), 'true');
  assert.equal((await a.perform({ type: 'snapshot' }) as { url: string }).url, 'about:blank');
  await a.setControl('human');
  await assert.rejects(a.perform({ type: 'snapshot' }));
  const stream = a.openDesktop();
  assert.match((await once(stream, 'data'))[0].toString(), /^RFB /);
  const closed = once(stream, 'close');
  await a.setControl('agent'); await closed;
  assert.equal((await a.perform({ type: 'snapshot' }) as { url: string }).url, 'about:blank');
  await a.close();
  const reopened = await engine.create({ ownerId: alice });
  assert.equal(await fixtureCookie(reopened.record.name), 'false', 'A new session never inherits the previous login');
  await reopened.close(); await b.close();
  assert.equal((await readdir(join(root, 'runtimes'))).filter(file => file.endsWith('.json')).length, 0);
  const instance = await readFile(join(root, 'runtimes', 'instance-id'), 'utf8');
  const survivors = (await exec('docker', ['ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`])).stdout.trim();
  assert.equal(survivors, '');

});

test('Docker Runtime: public HTTPS works through private proxy; private/metadata targets and direct egress are blocked', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-runtime-egress-'));
  const engine = new DockerEngine({ image, dataDirectory: root, network: 'public', denyHosts: ['localhost'] });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await engine.create({ ownerId: randomUUID() });
  await workspace.perform({ type: 'navigate', url: 'https://httpbin.org/get?agentic_runtime_fixture=1' });
  const page = await workspace.perform({ type: 'snapshot' }) as { text: string };
  assert.match(page.text, /agentic_runtime_fixture/);
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://169.254.169.254/', 'http://172.17.0.1/', 'http://localhost/']) {
    await workspace.perform({ type: 'navigate', url });
    assert.match((await workspace.perform({ type: 'snapshot' }) as { text: string }).text, /Network target is not allowed/, url);
  }
  await workspace.perform({ type: 'navigate', url: 'https://httpbin.org/anything/agentic-browser-acceptance' });
  assert.match((await workspace.perform({ type: 'snapshot' }) as { text: string }).text, /agentic-browser-acceptance/);
  const direct = await exec('docker', ['exec', workspace.record.name, 'node', '-e', "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(1500)}).then(()=>console.log('bypassed'),()=>console.log('blocked'))"]);
  assert.equal(direct.stdout.trim(), 'blocked');
  await workspace.close();
  const instance = await readFile(join(root, 'runtimes', 'instance-id'), 'utf8');
  assert.equal((await exec('docker', ['ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`])).stdout.trim(), '');
  assert.equal((await readdir(join(root, 'runtimes'))).some(file => file.endsWith('-proxy')), false);
});

test('Docker Runtime: proxy online state and software WebGL survive handoff, reload and new pages', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-runtime-compat-'));
  const engine = new DockerEngine({ image, dataDirectory: root, network: 'public' });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = await engine.create();
  // Container-local diagnostics only; CDP is never exposed by the product API.
  async function inspect(newPage = false) {
    const { stdout } = await exec('docker', ['exec', workspace.record.name, 'node', '--input-type=module', '-e', `
      import fs from 'node:fs'; import { chromium } from 'playwright';
      let port; for (const id of fs.readdirSync('/proc')) { try { const m=fs.readFileSync('/proc/'+id+'/cmdline','utf8').match(/--remote-debugging-port=(\\d+)/); if(m){port=m[1];break;} } catch {} }
      const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
      try {
        const context=browser.contexts()[0];
        const page=${newPage} ? await context.newPage() : context.pages()[0];
        const fixture='<script>window.onlineAtStart=navigator.onLine</script><title>Runtime compatibility</title><body>Runtime compatibility</body>';
        await page.route('https://example.com/**', route=>route.fulfill({contentType:'text/html',body:fixture+'<iframe src="https://example.org/frame"></iframe>'}));
        await page.route('https://example.org/**', route=>route.fulfill({contentType:'text/html',body:fixture}));
        await page.goto('https://example.com/fixture');
        if(!await page.evaluate(()=>window.onlineAtStart)) throw new Error('First site script saw offline state');
        await page.reload();
        for(const frame of page.frames()) {
          if(!await frame.evaluate(()=>window.onlineAtStart && navigator.onLine)) throw new Error('Reloaded page/frame saw offline state');
        }
        const state=await page.evaluate(()=>{
          const gl=document.createElement('canvas').getContext('webgl2');
          if(!gl) return {online:navigator.onLine,webgl2:false};
          gl.clearColor(1,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
          const pixel=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
          const extension=gl.getExtension('WEBGL_debug_renderer_info');
          return {online:navigator.onLine,webgl2:true,pixel:[...pixel],renderer:extension&&gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)};
        });
        console.log(JSON.stringify(state));
      } finally { await browser.close(); }
    `]);
    const state = JSON.parse(stdout);
    assert.equal(state.online, true); assert.equal(state.webgl2, true);
    assert.deepEqual(state.pixel, [255, 0, 0, 255]);
    assert.match(state.renderer, /llvmpipe/i);
  }
  await inspect();
  await workspace.setControl('human');
  await assert.rejects(workspace.perform({ type: 'snapshot' }));
  await inspect(true);
  await workspace.setControl('agent');
  await inspect();
  await workspace.perform({ type: 'navigate', url: 'http://169.254.169.254/' });
  assert.match((await workspace.perform({ type: 'snapshot' }) as { text: string }).text, /Network target is not allowed/);
  const direct = await exec('docker', ['exec', workspace.record.name, 'node', '-e', "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(1500)}).then(()=>console.log('bypassed'),()=>console.log('blocked'))"]);
  assert.equal(direct.stdout.trim(), 'blocked');
});

test('Docker Runtime: crashed Chrome/container cannot be reused until verified cleanup; replacement starts with a fresh context', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-runtime-crash-'));
  const engine = new DockerEngine({ image, dataDirectory: root });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const ownerId = randomUUID();
  const workspace = await engine.create({ ownerId });
  await exec('docker', ['kill', workspace.record.name]);
  await assert.rejects(workspace.perform({ type: 'snapshot' }));
  await workspace.close();
  const reopened = await engine.create({ ownerId });
  assert.equal((await reopened.perform({ type: 'snapshot' }) as { url: string }).url, 'about:blank');
  await reopened.close();
  assert.equal((await readdir(join(root, 'runtimes'))).filter(file => file.endsWith('.json')).length, 0);
});

test('Docker Runtime: an abruptly killed controller leaves a recoverable ledger; restart cleans only its own runtimes', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-controller-crash-'));
  const script = `import {DockerEngine} from ${JSON.stringify(new URL('../src/docker-runtime.ts', import.meta.url).href)};
    const engine = new DockerEngine({image:${JSON.stringify(image)},dataDirectory:${JSON.stringify(root)}});
    const ownerId=${JSON.stringify(randomUUID())};
    const runtime=await engine.create({ownerId});
    process.stdout.write(JSON.stringify({ownerId,name:runtime.record.name})+'\\n');
    setInterval(()=>{},10000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const engine = new DockerEngine({ image, dataDirectory: root });
  t.after(async () => { child.kill('SIGKILL'); await engine.close(); await rm(root, { recursive: true, force: true }); });
  const [line] = await once(lines, 'line');
  const record = JSON.parse(line);
  const competitor = new DockerEngine({ image, dataDirectory: root });
  await assert.rejects(competitor.initialize(), /Another runtime controller/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await engine.initialize();
  assert.equal((await readdir(join(root, 'runtimes'))).filter(file => file.endsWith('.json')).length, 0);
  const restored = await engine.create({ ownerId: record.ownerId });
  await restored.close();
});
