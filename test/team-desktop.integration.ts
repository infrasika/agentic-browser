import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { IdentityStore } from '../src/identity.js';
import { DesktopEngine } from '../src/desktop.js';
import { DockerEngine } from '../src/docker-runtime.js';
import { SessionRegistry } from '../src/sessions.js';
import { createHttpServer } from '../src/http.js';

test('team native desktop: one input window, reconnect with fresh grant, native login, Agent resumes', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentic-team-native-'));
  const identity = new IdentityStore(root);
  await identity.createMember('alice', 'synthetic-native-password');
  const isolated = process.env.AGENTIC_TEST_DOCKER === '1';
  const engine = isolated ? new DockerEngine({ dataDirectory: root, network: 'public', denyHosts: ['localhost'] }) : new DesktopEngine();
  const registry = new SessionRegistry(engine, { ttlMs: 60000, maxSessions: 2 });
  const server = createHttpServer(registry, { publicUrl: 'http://127.0.0.1:3333', identity });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await registry.close(); server.close(); server.closeAllConnections(); identity.close(); await rm(root, { recursive: true, force: true }); });
  const client = await browser.newContext();
  const humanHeaders = { Origin: base, 'X-Agentic-Browser': '1' };
  assert.equal((await client.request.post(base + '/api/auth/login', { headers: humanHeaders, data: { username: 'alice', password: 'synthetic-native-password' } })).status(), 200);
  const key = await (await client.request.post(base + '/api/credentials', { headers: humanHeaders, data: { name: 'Native test client' } })).json();
  const mcp = process.env.AGENTIC_TEST_MCP === '1' ? new Client({ name: 'isolated-team-acceptance', version: '1.0.0' }) : undefined;
  if (mcp) {
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'], env: { ...process.env, AGENT_BROWSER_TOKEN: key.token, AGENT_BROWSER_URL: base } as Record<string, string>, stderr: 'pipe' }));
    t.after(() => mcp.close());
  }
  const agent = async (path: string, method = 'GET', body?: unknown) => {
    if (mcp) {
      const match = /^\/api\/sessions\/([^/]+)(?:\/(actions|handoff))?$/.exec(path);
      const tool = !match ? { name: 'browser_create', arguments: body as Record<string, unknown> } : match[2] === 'actions' ? { name: 'browser_action', arguments: { sessionId: match[1], action: body } } : match[2] === 'handoff' ? { name: 'browser_handoff', arguments: { sessionId: match[1], reason: 'Synthetic native login' } } : { name: 'browser_status', arguments: { sessionId: match[1] } };
      const result = await mcp.callTool(tool);
      const data = JSON.parse((result.content as { text: string }[])[0].text);
      return { status: result.isError ? data.status : match ? 200 : 201, data };
    }
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const created = await agent('/api/sessions', 'POST', { purpose: 'Synthetic native team test', url: isolated ? 'https://agentic-browser.invalid/demo' : base + '/demo' });
  assert.equal(created.status, 201);
  const id = created.data.id;
  await agent(`/api/sessions/${id}/actions`, 'POST', { type: 'click', selector: '#username' });
  assert.equal((await agent(`/api/sessions/${id}/handoff`, 'POST', {})).status, 200);
  const pendingWait = mcp?.callTool({ name: 'browser_wait', arguments: { sessionId: id, timeoutSeconds: 25 } });
  const page = await client.newPage();
  await page.goto(created.data.humanUrl);
  const connected = () => page.waitForFunction(() => document.getElementById('connection')?.textContent === '连接正常' && !!document.querySelector('#desktop canvas'));
  await connected();
  // A second tab with the same login gets no RFB stream and cannot displace us.
  const other = await client.newPage();
  let otherReceivedFrame = false;
  other.on('websocket', socket => socket.on('framereceived', ({ payload }) => { if (Buffer.isBuffer(payload)) otherReceivedFrame = true; }));
  await other.goto(created.data.humanUrl);
  await other.waitForFunction(() => document.getElementById('message')?.textContent?.includes('另一个窗口'));
  assert.equal(otherReceivedFrame, false);
  assert.equal(await page.locator('#desktop canvas').count(), 1);
  await other.close();
  await page.reload(); await connected();
  await page.context().setOffline(true);
  await page.waitForFunction(() => !document.querySelector('#desktop canvas') && (document.getElementById('text') as HTMLInputElement).disabled);
  assert.equal((await agent(`/api/sessions/${id}`)).data.control, 'human');
  await page.context().setOffline(false); await connected();
  await page.locator('#text').fill('team-native-fixture');
  await page.locator('#send-text').click();
  await page.locator('#desktop canvas').focus();
  await page.keyboard.press('Tab'); await page.keyboard.type('fictional-site-password'); await page.keyboard.press('Enter');
  // Poll only the test site's rendered framebuffer before returning; no CDP in the human phase.
  await new Promise(resolve => setTimeout(resolve, 600));
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.getElementById('message')?.textContent?.startsWith('已交还'));
  if (pendingWait) assert.equal(JSON.parse(((await pendingWait).content as { text: string }[])[0].text).status, 'ready');
  const snapshot = await agent(`/api/sessions/${id}/actions`, 'POST', { type: 'snapshot' });
  assert.equal(snapshot.status, 200); assert.match(snapshot.data.result.text, /已登录：team-native-fixture/);
  await page.locator('#takeover').click(); await connected();
  assert.equal((await client.request.post(base + '/api/auth/logout', { headers: humanHeaders, data: {} })).status(), 200);
  await page.waitForFunction(() => !document.querySelector('#desktop canvas'));
});
