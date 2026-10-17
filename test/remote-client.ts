import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type Fixture = {
  docker: (...args: string[]) => Promise<string>; env: Record<string, string | undefined>;
  controller: string; image: string; base: string; human: BrowserContext;
  headers: Record<string, string>; profileId: string;
  report: Record<string, any>; record: (name: string) => Promise<void>;
};

export async function verifyRemoteClients(fixture: Fixture) {
  const { docker, controller, image, base, human, headers, profileId, record } = fixture;
  const started = Date.now(), runId = randomUUID(), label = `dev.agentic-browser.client-acceptance=${runId}`;
  const report = fixture.report.remoteClient = { passed: false, checks: [] as string[], containers: [] as object[], cleanupErrors: [] as string[], elapsedMs: 0 };
  const clients = new Set<Client>(), credentials = new Set<string>(), sessions = new Set<string>();
  const check = async (name: string) => { report.checks.push(name); await record(`remote client: ${name}`); };
  const owned = async () => (await docker('ps', '-aq', '--filter', `label=${label}`)).split(/\s+/).filter(Boolean);
  async function issue(name: string, profileIds: string[] = []) {
    const response = await human.request.post(base + '/api/credentials', { headers, data: { name, profileIds } });
    assert.equal(response.status(), 200);
    const key = await response.json(); credentials.add(key.id); return key as { id: string; token: string };
  }
  async function call(client: Client, name: string, args: Record<string, unknown> = {}, errorStatus?: number) {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.isError === true, errorStatus !== undefined, `Unexpected MCP result: ${name}`);
    const result = JSON.parse((response.content as { text: string }[])[0].text);
    if (errorStatus !== undefined) assert.equal(result.status, errorStatus);
    return result;
  }
  try {
    const detail = JSON.parse(await docker('inspect', controller))[0];
    const networks = Object.keys(detail.NetworkSettings.Networks);
    assert.equal(networks.length, 1); const network = networks[0];
    assert.match(network, /^ab-install-[a-f0-9-]+_default$/);
    const relay = `ab-client-relay-${runId}`;
    const controllerAddress = detail.NetworkSettings.Networks[network].IPAddress;
    assert.match(controllerAddress, /^\d+\.\d+\.\d+\.\d+$/);
    // Test-only reverse proxy on the disposable Compose network. It has no host
    // ports/mounts and forwards only to this installation, preserving its Host.
    // This models separate client/server origins without exposing a test account.
    const proxy = `const http=require('node:http');http.createServer((req,res)=>{
      const upstream=http.request({hostname:${JSON.stringify(controllerAddress)},port:3333,path:req.url,method:req.method,
        headers:{...req.headers,host:${JSON.stringify(new URL(base).host)}}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
      req.on('aborted',()=>upstream.destroy());res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});req.pipe(upstream);
    }).listen(3333,'0.0.0.0');`;
    const restrictions = ['--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '1000:1000', '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777'];
    await docker('run', '-d', '--rm', '--name', relay, '--label', label, '--network', network,
      ...restrictions, '--entrypoint', 'node', image, '-e', proxy);
    await docker('exec', relay, 'node', '-e', `fetch('http://127.0.0.1:3333/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`);
    let sequence = 0;
    async function connect(token: string) {
      const name = `ab-client-${runId}-${++sequence}`;
      const transport = new StdioClientTransport({ command: 'docker', stderr: 'pipe',
        args: ['run', '--rm', '-i', '--name', name, '--label', label, '--network', network, ...restrictions,
          '-e', 'AGENT_BROWSER_TOKEN', '-e', 'AGENT_BROWSER_URL', '-e', 'AGENT_BROWSER_VIEW_URL',
          '--entrypoint', 'node', image, '--import', 'tsx', 'src/mcp.ts'],
        // Pass the synthetic token through the child environment, never argv.
        env: { ...fixture.env, AGENT_BROWSER_TOKEN: token, AGENT_BROWSER_URL: `http://${relay}:3333`, AGENT_BROWSER_VIEW_URL: base } as Record<string, string>,
      });
      transport.stderr?.on('data', () => {}); // No credentials or raw child logs in evidence.
      const client = new Client({ name: 'synthetic-container-client', version: '1' }); clients.add(client);
      await client.connect(transport); assert.equal((await client.listTools()).tools.length, 11);
      const container = JSON.parse(await docker('inspect', name))[0];
      assert.equal(container.Config.User, '1000:1000'); assert.equal(container.HostConfig.ReadonlyRootfs, true);
      assert.equal(container.HostConfig.Privileged, false); assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
      assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
      assert.equal(container.HostConfig.NetworkMode, network); assert.deepEqual(container.Mounts, []);
      assert.deepEqual(container.HostConfig.PortBindings ?? {}, {});
      assert.equal(container.Config.Env.some((value: string) => value.startsWith('DOCKER_HOST=')), false);
      report.containers.push({ image: container.Image, user: container.Config.User, readOnly: true,
        mounts: 0, publishedPorts: 0, privileged: false, droppedCapabilities: ['ALL'] });
      return { client, name };
    }
    const key = await issue('Remote adapter owner', [profileId]), other = await issue('Remote adapter restricted');
    let adapter = await connect(key.token);
    const foreign = await connect(other.token), invalid = await connect('invalid-synthetic-token-0000000000000000');
    await call(invalid.client, 'browser_sessions', {}, 401);
    assert.deepEqual((await call(foreign.client, 'browser_profiles')).profiles, []);
    assert.ok((await call(adapter.client, 'browser_profiles')).profiles.some((p: { id: string }) => p.id === profileId));
    const session = await call(adapter.client, 'browser_create', { purpose: 'Synthetic remote client', profileId, url: 'https://agentic-browser.invalid/demo' });
    sessions.add(session.id); assert.equal(new URL(session.humanUrl).origin, base);
    assert.deepEqual((await call(foreign.client, 'browser_sessions')).sessions, []);
    await call(foreign.client, 'browser_status', { sessionId: session.id }, 404);
    await call(foreign.client, 'browser_close', { sessionId: session.id }, 404);
    await call(foreign.client, 'browser_create', { purpose: 'Denied profile', profileId }, 404);
    await check('no mounts/socket, invalid token rejected, credential and profile isolation');
    const action = (value: object) => call(adapter.client, 'browser_action', { sessionId: session.id, action: value });
    await action({ type: 'fill', selector: '#username', text: 'remote-client-marker' });
    await action({ type: 'fill', selector: '#password', text: 'synthetic-password' });
    await action({ type: 'press', key: 'Enter' });
    assert.match((await action({ type: 'snapshot' })).result.text, /Signed in: remote-client-marker/);
    await adapter.client.close(); clients.delete(adapter.client);
    for (let attempt = 0; attempt < 30 && (await docker('ps', '-aq', '--filter', `name=^/${adapter.name}$`)); attempt++) await delay(100);
    assert.equal(await docker('ps', '-aq', '--filter', `name=^/${adapter.name}$`), '', 'Closing stdio must remove its client container');
    adapter = await connect(key.token);
    assert.match((await action({ type: 'snapshot' })).result.text, /Signed in: remote-client-marker/);
    await check('stdio disconnect removes adapter; reconnect preserves browser session and page state');
    const handoff = await call(adapter.client, 'browser_handoff', { sessionId: session.id, reason: 'Review the synthetic state and hand back.' });
    assert.equal(new URL(handoff.humanUrl).origin, base);
    await call(adapter.client, 'browser_action', { sessionId: session.id, action: { type: 'snapshot' } }, 409);
    await call(adapter.client, 'browser_screenshot', { sessionId: session.id }, 409);
    assert.equal((await call(adapter.client, 'browser_wait', { sessionId: session.id, timeoutSeconds: 1 })).status, 'timed_out');
    const page = await human.newPage();
    try {
      await page.goto(handoff.humanUrl);
      await page.waitForFunction(() => document.getElementById('connection')?.textContent === 'Connected' && !!document.querySelector('#desktop canvas'));
      const waiting = call(adapter.client, 'browser_wait', { sessionId: session.id, timeoutSeconds: 20 });
      // Handle rejection immediately even if a UI assertion fails first.
      void waiting.catch(() => {});
      await page.locator('#resume').click();
      await page.waitForFunction(() => document.getElementById('message')?.textContent?.startsWith('Control returned'));
      assert.equal((await waiting).status, 'ready');
    } finally { await page.close(); }
    assert.match((await action({ type: 'snapshot' })).result.text, /Signed in: remote-client-marker/);
    await check('human URL rewrite, native viewer, Agent denial, timed wait and handback');
    assert.equal((await human.request.delete(base + '/api/credentials/' + key.id, { headers })).status(), 200);
    credentials.delete(key.id);
    await call(adapter.client, 'browser_status', { sessionId: session.id }, 401);
    const revoked = await connect(key.token); await call(revoked.client, 'browser_sessions', {}, 401);
    // The owning member retains cleanup access after revoking the Agent.
    assert.equal((await human.request.delete(base + '/api/human/' + session.id, { headers })).status(), 200);
    sessions.delete(session.id);
    await check('revocation denies existing and restarted adapters; owner can close the browser');
    report.passed = true;
  } finally {
    await Promise.allSettled([...clients].map(client => client.close()));
    for (const id of sessions) try {
      assert.equal((await human.request.delete(base + '/api/human/' + id, { headers })).status(), 200);
    } catch { report.cleanupErrors.push('owned session cleanup failed'); }
    for (const id of credentials) try {
      assert.equal((await human.request.delete(base + '/api/credentials/' + id, { headers })).status(), 200);
    } catch { report.cleanupErrors.push('synthetic credential revocation failed'); }
    try { for (const id of await owned()) await docker('rm', '-f', id); assert.deepEqual(await owned(), []); }
    catch { report.cleanupErrors.push('client or relay container cleanup failed'); }
    report.elapsedMs = Date.now() - started;
    report.passed &&= report.cleanupErrors.length === 0;
    await record('remote client fixture cleanup completed');
    assert.deepEqual(report.cleanupErrors, []);
  }
}
