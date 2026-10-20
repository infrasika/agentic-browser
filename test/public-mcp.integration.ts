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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const exec = promisify(execFile);
const result = (value: any) => JSON.parse(value.content[0].text);
test('public Compose MCP: five-browser capacity, isolated visitors, human handback and cleanup', { timeout: 300000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-public-compose-'));
  const configFile = join(root, 'public.env'); await writeFile(configFile, '');
  const project = `ab-public-test-${randomUUID()}`;
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, AB_PROJECT_NAME: project, AB_PORT: String(port), AB_PUBLIC_URL: base,
    AB_MODE: 'public', AB_BIND_ADDRESS: '127.0.0.1', AB_TRUST_PROXY: 'true', AB_MAX_SESSIONS: '5', AB_MAX_SESSIONS_PER_IP: '2', AB_COMPOSE_ENV_FILE: configFile };
  const compose = async (...args: string[]) => (await exec('bash', ['scripts/compose.sh', ...args], { env, timeout: 120000, maxBuffer: 2 ** 20 })).stdout.trim();
  const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 30000, maxBuffer: 2 ** 20 })).stdout.trim();
  const clients: Client[] = []; let browser: Browser | undefined, instance = '';
  const owned = async () => (await docker('ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`)).split(/\s+/).filter(Boolean);
  t.after(async () => {
    await Promise.all(clients.map(client => client.close())); await browser?.close();
    try { await compose('down', '--timeout', '60'); }
    finally {
      if (instance) for (const id of await owned()) await docker('rm', '-f', id);
      await compose('down', '--volumes'); await rm(root, { recursive: true, force: true });
    }
  });
  const rendered = JSON.parse(await compose('config', '--format', 'json'));
  assert.equal(rendered.services.controller.ports.length, 1);
  assert.equal(rendered.services.controller.environment.BROWSER_AUTH_MODE, 'public');
  assert.equal(rendered.services.controller.environment.MAX_SESSIONS, '5');
  assert.equal(rendered.volumes.data.name, `${project}-data`);
  // Health probes must work when PUBLIC_URL uses a public IP, with no local
  // loopback exception. This reserved address need not be reachable externally.
  env.AB_PUBLIC_URL = `http://198.51.100.10:${port}`;
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  env.AB_PUBLIC_URL = base;
  await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90');
  let controller = await compose('ps', '-q', 'controller');
  const inside = (source: string) => docker('exec', controller, 'node', '--import', 'tsx', '--input-type=module', '-e', source);
  instance = await inside("import {readFile} from 'node:fs/promises';console.log(await readFile('/data/public-browser/runtimes/instance-id','utf8'))");
  assert.equal((await fetch(base + '/api/auth/config').then(r => r.json())).mcpUrl, base + '/mcp');
  const capacity = () => fetch(base + '/api/public/capacity').then(r => r.json());
  assert.deepEqual(await capacity(), { currentSessions: 0, maxSessions: 5, availableSessions: 5, full: false });
  async function client(source = '198.51.100.1') {
    const client = new Client({ name: 'public-compose-test', version: '1' }); clients.push(client);
    // This isolated loopback-only fixture simulates a trusted proxy; production
    // receives an overwritten client IP from Nginx.
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { 'X-Real-IP': source } } })); return client;
  }
  const a = await client(), b = await client(); assert.equal((await a.listTools()).tools.length, 9);
  const one = result(await a.callTool({ name: 'browser_create', arguments: { purpose: 'Synthetic public visitor A' } }));
  const two = result(await b.callTool({ name: 'browser_create', arguments: { purpose: 'Synthetic public visitor B' } }));
  assert.ok(one.sessionKey, JSON.stringify(one)); assert.ok(two.sessionKey, JSON.stringify(two));
  const aa = { sessionId: one.id, sessionKey: one.sessionKey }, bb = { sessionId: two.id, sessionKey: two.sessionKey };
  const action = async (client: Client, access: typeof aa, action: object) => result(await client.callTool({ name: 'browser_action', arguments: { ...access, action } }));
  assert.equal(result(await b.callTool({ name: 'browser_status', arguments: { ...bb, sessionId: one.id } })).status, 404);
  const sourceLimited = result(await a.callTool({ name: 'browser_create', arguments: {} }));
  assert.equal(sourceLimited.error, 'source_limit'); assert.equal(sourceLimited.capacity.currentSessions, 2);
  const extraClients = await Promise.all([2, 3, 4].map(i => client(`198.51.100.${i}`)));
  const extras = await Promise.all(extraClients.map(async c => result(await c.callTool({ name: 'browser_create', arguments: { purpose: 'Synthetic capacity fixture' } }))));
  assert.ok(extras.every(s => s.sessionKey));
  assert.deepEqual(await capacity(), { currentSessions: 5, maxSessions: 5, availableSessions: 0, full: true });
  const full = result(await a.callTool({ name: 'browser_create', arguments: {} }));
  assert.equal(full.error, 'session_limit', 'Global full notice takes precedence over a source limit');
  assert.equal(full.status, 429); assert.match(full.userMessage, /5 \/ 5/); assert.match(full.userMessage, /try again later/);
  const runtimes = JSON.parse(await docker('inspect', ...await owned())); assert.equal(runtimes.length, 10);
  for (const runtime of runtimes) {
    assert.equal(runtime.HostConfig.Privileged, false); assert.equal(runtime.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(runtime.HostConfig.PortBindings, {});
    for (const mount of runtime.HostConfig.Mounts) {
      assert.notEqual(mount.Target, '/var/run/docker.sock'); assert.notEqual(mount.Target, '/profile');
      assert.match(mount.VolumeOptions.Subpath, /^public-browser\/runtimes\//);
    }
  }
  assert.equal(runtimes.filter((r: any) => r.HostConfig.NetworkMode === 'none').length, 5);
  // A fresh MCP transport can continue with its explicit capability. No shared
  // transport ID, cookies, or global session list is used as Agent authority.
  await a.close(); const reconnected = await client();
  assert.equal(result(await reconnected.callTool({ name: 'browser_status', arguments: aa })).control, 'agent');
  await action(reconnected, aa, { type: 'click', selector: '#username' });
  const handoff = result(await reconnected.callTool({ name: 'browser_handoff', arguments: aa }));
  const presentedLink = handoff.userMessage.match(/\[Open browser and take control\]\((https?:\/\/[^\s)]+)\)/)?.[1];
  assert.equal(presentedLink, handoff.humanUrl, 'The user-facing message must contain the complete usable link');
  assert.equal((await action(reconnected, aa, { type: 'snapshot' })).status, 409);
  browser = await chromium.launch({ headless: true });
  const human = await browser.newContext(), other = await browser.newContext();
  const page = await human.newPage(); await page.goto(base);
  await page.waitForFunction(() => document.getElementById('mcp-config')?.textContent?.includes('/mcp'));
  assert.match((await page.locator('#mcp-config').textContent()) ?? '', /\/mcp/);
  await page.waitForFunction(() => document.getElementById('capacity-status')?.textContent?.includes('All browser slots are in use'));
  assert.match(await page.locator('#capacity-status').innerText(), /5 \/ 5/);
  await extraClients[0].callTool({ name: 'browser_close', arguments: { sessionId: extras[0].id, sessionKey: extras[0].sessionKey } });
  await page.waitForFunction(() => document.getElementById('capacity-status')?.textContent?.includes('4 / 5'));
  extras[0] = result(await extraClients[0].callTool({ name: 'browser_create', arguments: {} }));
  assert.ok(extras[0].sessionKey, 'A closed browser releases a slot for a new visitor');
  assert.equal((await capacity()).currentSessions, 5);
  await Promise.all(extras.map((s, i) => extraClients[i].callTool({ name: 'browser_close', arguments: { sessionId: s.id, sessionKey: s.sessionKey } })));
  await page.waitForFunction(() => document.getElementById('capacity-status')?.textContent?.includes('2 / 5'));
  await page.route('**/api/public/capacity', route => route.fulfill({ status: 503, body: '{}' }));
  await page.waitForFunction(() => document.getElementById('capacity-status')?.textContent?.includes('Session counts are temporarily unavailable'));
  assert.equal(await page.locator('#copy-prompt').isEnabled(), true);
  await page.unroute('**/api/public/capacity');
  await page.waitForFunction(() => document.getElementById('capacity-status')?.textContent?.includes('2 / 5'));
  await page.goto(base + '/connect');
  assert.equal(await page.locator('#connect-browser').isDisabled(), true);
  await page.waitForFunction(() => document.getElementById('connect-message')?.textContent?.includes('Incomplete handoff link'));
  await page.goto(one.humanUrl); // browser_handoff has revoked this initial link.
  await page.locator('#connect-browser').click();
  await page.waitForFunction(() => document.getElementById('connect-message')?.textContent?.includes('has been used or has expired'));
  assert.equal(await page.locator('#connect-browser').isDisabled(), true);
  // Same-document navigation must recover a tab opened without a fragment.
  await page.goto(presentedLink!);
  await page.waitForFunction(() => !(document.getElementById('connect-browser') as HTMLButtonElement).disabled);
  assert.equal(page.url(), presentedLink, 'Do not erase the ticket before the user claims it');
  await page.reload();
  await page.waitForFunction(() => !(document.getElementById('connect-browser') as HTMLButtonElement).disabled);
  assert.equal(page.url(), presentedLink, 'The unclaimed link survives refresh');
  await page.route('**/api/public/claim', route => route.abort('failed'));
  await page.locator('#connect-browser').click();
  await page.waitForFunction(() => document.getElementById('connect-message')?.textContent?.includes('Please retry'));
  assert.equal(await page.locator('#connect-browser').isDisabled(), false, 'A transient failure allows retry');
  assert.equal(page.url(), presentedLink);
  await page.unroute('**/api/public/claim');
  await page.locator('#connect-browser').click();
  await page.waitForURL('**/view*');
  assert.ok(!page.url().includes(new URL(presentedLink!).hash), 'A successful claim removes the ticket from the current address');
  const connected = () => page.waitForFunction(() => document.getElementById('connection')?.textContent === 'Connected' && !!document.querySelector('#desktop canvas'));
  await connected(); await page.reload(); await connected();
  const otherPage = await other.newPage(); await otherPage.goto(two.humanUrl); await otherPage.locator('#connect-browser').click(); await otherPage.waitForURL('**/view*');
  assert.equal((await other.request.get(`${base}/api/human/${one.id}`)).status(), 404);
  await page.locator('#desktop canvas').focus(); await page.keyboard.type('public-mcp-fixture'); await page.keyboard.press('Tab'); await page.keyboard.type('fictional-public-password'); await page.keyboard.press('Enter');
  await new Promise(resolve => setTimeout(resolve, 600));
  const waiting = reconnected.callTool({ name: 'browser_wait', arguments: { ...aa, afterRevision: handoff.revision, timeoutSeconds: 25 } });
  await page.locator('#resume').click();
  assert.equal(result(await waiting).status, 'ready');
  const snap = await action(reconnected, aa, { type: 'snapshot' }); assert.match(snap.result.text, /Signed in: public-mcp-fixture/);
  assert.doesNotMatch(snap.result.text, /Task complete: the Agent/);
  await action(reconnected, aa, { type: 'click', selector: '#continue' });
  assert.match((await action(reconnected, aa, { type: 'snapshot' })).result.text, /Task complete: the Agent/);
  await otherPage.locator('#resume').click();
  await otherPage.waitForFunction(() => document.getElementById('message')?.textContent?.startsWith('Control returned'));
  assert.doesNotMatch((await action(b, bb, { type: 'snapshot' })).result.text, /Signed in: public-mcp-fixture/);
  const echo = `public-mcp-${randomUUID()}`;
  await action(reconnected, aa, { type: 'navigate', url: `https://httpbin.org/get?fixture=${echo}` });
  assert.ok((await action(reconnected, aa, { type: 'snapshot' })).result.text.includes(echo));
  await action(reconnected, aa, { type: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' });
  assert.match((await action(reconnected, aa, { type: 'snapshot' })).result.text, /Network target is not allowed/);
  assert.equal(result(await reconnected.callTool({ name: 'browser_close', arguments: aa })).control, 'closed');
  assert.equal((await human.request.get(base + '/api/auth/me')).status(), 401);
  assert.equal((await owned()).length, 2);
  assert.equal((await capacity()).currentSessions, 1);
  await compose('stop', '--timeout', '60', 'controller'); assert.deepEqual(await owned(), []);
  await compose('up', '-d', '--wait', '--wait-timeout', '90'); controller = await compose('ps', '-q', 'controller');
  assert.equal((await capacity()).currentSessions, 0);
  assert.equal(result(await b.callTool({ name: 'browser_status', arguments: bb })).status, 404, 'Restart ends temporary capabilities');
  assert.equal(await inside("import {ProfileStore} from './src/profiles.ts';console.log((await new ProfileStore('/data/public-browser').list()).length)"), '0');
});
