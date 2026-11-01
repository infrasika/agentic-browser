import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import type { Browser, Page } from 'playwright';
import { DesktopWorkspace } from '../src/desktop.js';

const exec = promisify(execFile);
const lock = JSON.parse(await readFile('/app/runtime/assets.lock.json', 'utf8')) as {
  extensions: { id: string; name: string; version: string; popup: string }[];
};
// Test-only access to the already-owned browser; never add a second CDP client during handoff.
const internals = (workspace: DesktopWorkspace) => workspace as unknown as {
  browser?: Browser; environment: NodeJS.ProcessEnv;
};
async function createWorkspace(publicEgress = false) {
  const workspace = new DesktopWorkspace(await mkdtemp(join(tmpdir(), 'extension-test-')));
  try { await workspace.start('/usr/bin/google-chrome-stable', [], publicEgress); return workspace; }
  catch (error) { await workspace.close(); throw error; }
}
async function extensionInfo(page: Page) {
  await page.goto('chrome://extensions');
  return page.evaluate(() => new Promise<any[]>((resolve) => {
    (globalThis as any).chrome.developerPrivate.getExtensionsInfo(
      { includeDisabled: true, includeTerminated: true }, resolve,
    );
  }));
}
async function waitForExtensions(page: Page) {
  let info: any[] = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    info = await extensionInfo(page);
    if (lock.extensions.every(e => info.some(item => item.id === e.id && item.state === 'ENABLED'))) return info;
    await delay(500);
  }
  assert.fail(`Extensions not enabled: ${JSON.stringify(info.map(({ id, name, state, disableReasons }) => ({ id, name, state, disableReasons })))}`);
}

test('image: both original extensions install without network and remain usable across native handoff', { timeout: 90000 }, async t => {
  assert.ok(Object.values(networkInterfaces()).flat().every(address => !address || address.internal), 'Run with docker --network none');
  const workspace = await createWorkspace();
  t.after(() => workspace.close());
  const browser = internals(workspace).browser!;
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  const info = await waitForExtensions(page);
  for (const expected of lock.extensions) {
    const installed = info.find(e => e.id === expected.id);
    assert.equal(installed.version, expected.version);
    assert.equal(installed.state, 'ENABLED');
  }
  await page.goto('chrome://sandbox');
  const sandbox = await page.locator('body').innerText();
  console.log('Chrome sandbox:', sandbox.replace(/\s+/g, ' '));
  assert.match(sandbox, /Layer 1 Sandbox\s+Namespace/i);
  assert.match(sandbox, /PID namespaces\s+Yes/i);
  assert.match(sandbox, /Network namespaces\s+Yes/i);
  assert.match(sandbox, /Seccomp-BPF[\s\S]*Yes/i);
  await mkdir('/app/output/playwright', { recursive: true });
  for (const extension of lock.extensions) {
    await page.goto(`chrome-extension://${extension.id}/${extension.popup}`);
    await page.locator('body').waitFor();
    await delay(300);
    assert.ok((await page.locator('body').innerText()).trim().length > 0, `${extension.name} UI should render`);
    await page.screenshot({ path: `/app/output/playwright/${extension.id}.png` });
    console.log('Popup rendered:', extension.name);
  }
  // Verify private extension storage and cookies start empty in a second browser.
  const transgate = lock.extensions[0];
  await page.goto(`chrome-extension://${transgate.id}/${transgate.popup}`);
  await page.evaluate(() => (globalThis as any).chrome.storage.local.set({ agenticIsolationFixture: 'private-session-A' }));
  await context.addCookies([{ name: 'agentic_fixture', value: 'private-session-A', url: 'https://example.test/' }]);
  const second = await createWorkspace();
  t.after(() => second.close());
  const secondContext = internals(second).browser!.contexts()[0];
  const secondPage = secondContext.pages()[0];
  await waitForExtensions(secondPage);
  await secondPage.goto(`chrome-extension://${transgate.id}/${transgate.popup}`);
  assert.deepEqual(await secondPage.evaluate(() => (globalThis as any).chrome.storage.local.get('agenticIsolationFixture')), {});
  assert.equal((await secondContext.cookies()).some(cookie => cookie.name === 'agentic_fixture'), false);
  await second.close();

  await workspace.setControl('human');
  assert.equal(internals(workspace).browser, undefined);
  await assert.rejects(workspace.perform({ type: 'snapshot' }));
  const socket = workspace.openDesktop();
  const banner = await once(socket, 'data');
  assert.match(banner[0].toString(), /^RFB /);
  const socketClosed = once(socket, 'close');
  // Native keyboard input, while CDP is detached, opens the actual validator UI.
  const env = { ...process.env, ...internals(workspace).environment };
  const validator = lock.extensions[1];
  await exec('xdotool', ['key', '--clearmodifiers', 'ctrl+l'], { env });
  await exec('xdotool', ['type', '--clearmodifiers', '--delay', '1', `chrome-extension://${validator.id}/${validator.popup}`], { env });
  await exec('xdotool', ['key', 'Return'], { env });
  await delay(600);
  await workspace.setControl('agent');
  await socketClosed;
  const returned = await workspace.perform({ type: 'snapshot' }) as { url: string; text: string };
  assert.equal(returned.url, `chrome-extension://${validator.id}/${validator.popup}`);
  assert.ok(returned.text.trim().length > 0);
  console.log('Native handoff restored extension UI; old VNC connection revoked.');
});

test('TransGate: original popup opens Portal during human control without closing the browser', { timeout: 60000 }, async t => {
  // Exercise the production online-state adapter with the original extension.
  // This container has no egress, so the destination may show a network error;
  // its new tab must still initialize and survive the adapter's 5s timeout.
  const workspace = await createWorkspace(true);
  t.after(() => workspace.close());
  const context = internals(workspace).browser!.contexts()[0];
  const page = context.pages()[0];
  await waitForExtensions(page);
  const transgate = lock.extensions[0];
  await page.goto(`chrome-extension://${transgate.id}/${transgate.popup}`);
  await page.bringToFront();
  const link = page.getByRole('link', { name: 'Enter the World of Crypto' });
  assert.equal(await link.getAttribute('href'), 'https://portal.zkpass.org');
  assert.equal(await link.getAttribute('target'), '_blank');
  await page.evaluate(() => (globalThis as any).chrome.action.openPopup());
  await delay(500);
  await workspace.setControl('human');
  const env = { ...process.env, ...internals(workspace).environment };
  // The popup's only focusable element is its Portal link. Use native input,
  // with no automation client attached while Chrome creates the new target.
  await exec('xdotool', ['key', '--clearmodifiers', 'Tab', 'Return'], { env });
  await delay(6500);
  assert.equal(internals(workspace).browser, undefined);
  await assert.rejects(workspace.perform({ type: 'snapshot' }));
  await workspace.setControl('agent');
  const returnedContext = internals(workspace).browser!.contexts()[0];
  const returned = returnedContext.pages();
  assert.equal(returned.length, 2, 'The original tab and Portal tab both survive');
  const portal = returned.find(p => !p.url().startsWith('chrome-extension:'))!;
  // Chrome exposes chrome-error://chromewebdata/ for an offline tab via CDP;
  // navigation history retains the real URL attempted by the extension.
  const inspector = await returnedContext.newCDPSession(portal);
  const history = await inspector.send('Page.getNavigationHistory');
  assert.equal(history.entries[history.currentIndex].url, 'https://portal.zkpass.org/');
  await inspector.detach();
  assert.equal(await portal.evaluate(() => document.visibilityState), 'visible');
  const snapshot = await workspace.perform({ type: 'snapshot' }) as { url: string; text: string };
  assert.equal(snapshot.url, portal.url(), 'Agent adopts the tab opened by the human');
  assert.match(snapshot.text, /ERR_INTERNET_DISCONNECTED/);
});

test('proxy online bootstrap runs before the first script in native link and window.open tabs', { timeout: 60000 }, async t => {
  const { createServer } = await import('node:http');
  const observations = new Map<string, string>();
  const fixture = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    res.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/observed') {
      observations.set(url.searchParams.get('kind')!, url.searchParams.get('online')!);
      res.end('ok');
    } else if (url.pathname === '/opened') {
      res.end(`<script>fetch('/observed?kind='+${JSON.stringify(url.searchParams.get('kind'))}+'&online='+navigator.onLine)</script><h1>New tab ready</h1>`);
    } else {
      res.end(`<a id="link" href="/opened?kind=link" target="_blank">New tab</a><button id="script" onclick="window.open('/opened?kind=script')">New window</button><script>
        document.addEventListener('keydown', event => {
          if (event.key === 'F8') document.getElementById('link').click();
          if (event.key === 'F9') document.getElementById('script').click();
        });
      </script>`);
    }
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const workspace = await createWorkspace(true);
  t.after(() => workspace.close());
  const env = { ...process.env, ...internals(workspace).environment };
  await waitForExtensions(internals(workspace).browser!.contexts()[0].pages()[0]);
  for (const kind of ['link', 'script']) {
    const page = internals(workspace).browser!.contexts()[0].pages()[0];
    await page.goto(base); await page.bringToFront();
    await page.locator('body').click({ position: { x: 400, y: 10 } });
    await workspace.setControl('human');
    await exec('xdotool', ['key', '--clearmodifiers', kind === 'link' ? 'F8' : 'F9'], { env });
    for (let i = 0; i < 80 && !observations.has(kind); i++) await delay(100);
    assert.equal(internals(workspace).browser, undefined, 'No automation connection during native navigation');
    await workspace.setControl('agent');
    assert.equal(observations.get(kind), 'true', `${kind}: the first document script sees the proxy online state; tabs: ${internals(workspace).browser!.contexts()[0].pages().map(p => p.url()).join(', ')}`);
    const snapshot = await workspace.perform({ type: 'snapshot' }) as { url: string; text: string };
    assert.equal(snapshot.url, `${base}/opened?kind=${kind}`);
    assert.match(snapshot.text, /New tab ready/);
  }
});

test('Schema Validator: original extension captures a synthetic API while CDP is detached, returns result, then hands back', { timeout: 60000 }, async t => {
  const { createServer } = await import('node:http');
  let base = '';
  let ready = false;
  let result: any;
  let requests = 0;
  let triggered = false;
  let diagnostic = '';

  const fixture = createServer((req, res) => {
    const path = new URL(req.url!, base || 'http://127.0.0.1').pathname;
    if (path === '/api') {
      requests++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ user: { eligible: true, id: 'synthetic-test-user' } })); return;
    }
    if (path === '/diagnostic') {
      let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { diagnostic = body; res.end('ok'); }); return;
    }
    if (path === '/triggered') { triggered = true; res.end('ok'); return; }
    if (path === '/ready') { ready = true; res.end('ok'); return; }
    if (path === '/result') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => { result = JSON.parse(body); res.end('ok'); }); return;
    }
    const schema = {
      issuer: 'Synthetic local fixture', website: `${base}/data`,
      APIs: [{ host: new URL(base).host, intercept: { url: '/api', method: 'GET' },
        assert: [{ key: 'user|eligible', value: 'true', operation: '=' }], nullifier: 'user|id' }],
    };
    res.setHeader('Content-Type', 'text/html');
    if (path === '/data') {
      res.end(`<!doctype html><h1>Synthetic data source</h1><div id="plugin-mask"></div><script>
        setInterval(() => fetch('/api').then(r=>r.json()), 600);
        let sent=false;
        setInterval(()=>fetch('/diagnostic',{method:'POST',body:document.body.innerText}),1000);
        setInterval(()=>{if(!sent && document.querySelector('[data-icon=check-circle]') && [...document.querySelectorAll('button')].some(b=>b.textContent==='Check Pass')) {sent=true;fetch('/ready');}},200);
        document.addEventListener('keydown',event=>{if(event.key==='F9'){[...document.querySelectorAll('button')].find(b=>b.textContent==='Check Pass')?.click();}});
      </script>`); return;
    }
    res.end(`<!doctype html><h1>Local validation controller</h1><div id="zkPassDevCenter"></div><script>
      document.addEventListener('keydown',event=>{if(event.key==='F8'){fetch('/triggered');window.postMessage({type:'DEV_CENTER_EXTENSION',doc:{method:'POPUP',url:${JSON.stringify(`${base}/data`)},token:'synthetic-only',params:${JSON.stringify(schema)}}},'*');}});
      window.addEventListener('message',event=>{if(event.source===window && event.data.tag==='zkpass')fetch('/result',{method:'POST',body:JSON.stringify(event.data.params)});});
    </script>`);
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const workspace = await createWorkspace();
  t.after(() => workspace.close());
  const context = internals(workspace).browser!.contexts()[0];
  const page = context.pages()[0];
  await waitForExtensions(page);
  await page.goto(`${base}/control`);
  await page.bringToFront();
  await delay(700);
  await workspace.setControl('human');
  assert.equal(internals(workspace).browser, undefined);
  const env = { ...process.env, ...internals(workspace).environment };
  await exec('xdotool', ['key', '--clearmodifiers', 'F8'], { env });
  for (let i = 0; i < 100 && !ready; i++) await delay(150);
  assert.equal(triggered, true, 'Native key reached the visible controller');
  assert.ok(requests > 0, 'Extension opened data source and fixture emitted an API request');
  assert.equal(ready, true, `Unmodified validator must render Check Pass; fixture UI: ${diagnostic}`);
  assert.equal(internals(workspace).browser, undefined, 'No automation reattached during extension validation');
  await exec('xdotool', ['key', '--clearmodifiers', 'F9'], { env });
  for (let i = 0; i < 50 && !result; i++) await delay(100);
  assert.deepEqual(result, { errMsg: [] }, 'Actual extension NOTICE flow returned success to initiating page');
  await workspace.setControl('agent');
  const snapshot = await workspace.perform({ type: 'snapshot' }) as { url: string; text: string };
  assert.equal(snapshot.url, `${base}/control`);
  assert.match(snapshot.text, /Local validation controller/);
  console.log('Schema Validator captured synthetic JSON and returned success without a live CDP connection; Agent resumed.');
});
