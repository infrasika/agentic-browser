import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chromium, type Browser } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { verifyDesktopExperience, verifyExternalExperience } from './browser-experience.js';
import { verifyRemoteClients } from './remote-client.js';
import { HttpsProxy, freePort } from './https-proxy.js';

const exec = promisify(execFile);
const installerUrl = 'https://agentic-browser.zkpass.org/install.sh';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const experienceMinutes = Number(process.env.AB_ACCEPTANCE_EXPERIENCE_MINUTES ?? 0);
const remoteClient = process.env.AB_ACCEPTANCE_REMOTE_CLIENT === '1';
const httpsRoot = process.env.AB_ACCEPTANCE_HTTPS_DIR;
assert.ok(!httpsRoot || (!remoteClient && !experienceMinutes), 'Run HTTPS acceptance separately');
assert.ok(Number.isInteger(experienceMinutes) && experienceMinutes >= 0 && experienceMinutes <= 60);

test('published self-host installation: anonymous native images, human handoff and retained account/profile', { timeout: 1200000 + experienceMinutes * 60000 }, async t => {
  const started = Date.now(), runId = randomUUID();
  const project = `ab-install-${runId}`;
  const evidence = resolve(httpsRoot ? 'output/https' : remoteClient ? 'output/remote-client' : experienceMinutes ? 'output/experience' : 'output/self-host', `${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}`);
  await mkdir(evidence, { recursive: true });
  const report: Record<string, any> = { startedAt: new Date(started).toISOString(), project,
    host: { platform: platform(), arch: arch(), release: release() }, installerUrl,
    freshHostedRunner: false, passed: false, checks: [] };
  const record = async (name: string) => {
    report.checks.push({ name, elapsedMs: Date.now() - started });
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`[self-host] ${name}`);
  };
  const root = await mkdtemp(join(tmpdir(), 'ab-install-'));
  const setup = join(root, 'installation'), registry = join(root, 'empty-registry');
  await mkdir(registry); await writeFile(join(registry, 'config.json'), '{}', { mode: 0o600 });
  // Docker Desktop may install Compose under the original client config. Keep
  // access to that executable alone, without copying credentials or helpers.
  const plugins = JSON.parse((await exec('docker', ['info', '--format', '{{json .ClientInfo.Plugins}}'])).stdout);
  const composePlugin = plugins.find((plugin: { Name: string }) => plugin.Name === 'compose');
  assert.ok(composePlugin && isAbsolute(composePlugin.Path), 'A local Compose plugin is required');
  await mkdir(join(registry, 'cli-plugins'));
  await symlink(composePlugin.Path, join(registry, 'cli-plugins/docker-compose'));
  // Resolve the user's local context before isolating registry credentials. This
  // preserves Docker Desktop's Unix endpoint without copying its auth/config.
  const endpoint = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT ? process.env.DOCKER_HOST :
    (await exec('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
  assert.ok(endpoint.startsWith('unix://'), 'Acceptance requires a local Docker Unix socket');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('AB_') && !key.startsWith('COMPOSE_') &&
    !['DOCKER_CONFIG', 'DOCKER_AUTH_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_DEFAULT_PLATFORM'].includes(key)));
  Object.assign(env, { DOCKER_CONFIG: registry, DOCKER_HOST: endpoint });
  const docker = async (...args: string[]) => (await exec('docker', args, { env, timeout: 180000, maxBuffer: 4 * 2 ** 20 })).stdout.trim();
  const compose = (...args: string[]) => docker('compose', '--project-directory', setup, '--env-file', join(setup, '.env'), '-f', join(setup, 'compose.yaml'), ...args);
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const upstream = `http://127.0.0.1:${port}`;
  const base = httpsRoot ? `https://127.0.0.1:${await freePort()}` : upstream;
  const proxy = httpsRoot ? new HttpsProxy(httpsRoot, base, upstream, await freePort(), report.https = {}) : undefined;
  const instances = new Set<string>(), clients = new Set<Client>();
  let configured = false, controller = '', browser: Browser | undefined, mode = 'authenticated';
  const inside = (source: string) => docker('exec', controller, 'node', '--import', 'tsx', '--input-type=module', '-e', source);
  async function owned() {
    const ids = new Set<string>();
    for (const instance of instances)
      for (const id of (await docker('ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`)).split(/\s+/).filter(Boolean)) ids.add(id);
    return [...ids];
  }
  t.after(async () => {
    const errors: string[] = [];
    await Promise.allSettled([...clients].map(client => client.close()));
    if ((experienceMinutes || proxy) && !report.scenariosPassed) {
      const failedPage = browser?.contexts().flatMap(context => context.pages()).find(page => !page.isClosed());
      if (failedPage) try {
        await mkdir('output/playwright', { recursive: true });
        report.failureScreenshot = `output/playwright/${proxy ? 'https' : 'experience'}-${runId}-failure.png`;
        await failedPage.screenshot({ path: report.failureScreenshot, fullPage: true, timeout: 5000 });
      } catch { report.failureScreenshot = undefined; }
    }
    try { await browser?.close(); } catch { errors.push('verification browser cleanup failed'); }
    try { await proxy?.stop(); } catch { errors.push('disposable HTTPS proxy cleanup failed'); }
    if (configured) {
      try { await compose('down', '--timeout', '60'); } catch { errors.push('controller shutdown failed'); }
      try { for (const id of await owned()) await docker('rm', '-f', id); } catch { errors.push('scoped browser cleanup failed'); }
      try { await compose('down', '--volumes'); } catch { errors.push('disposable volume removal failed'); }
      try {
        assert.deepEqual(await owned(), []);
        assert.equal(await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`), '');
        assert.equal(await docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`), '');
      } catch { errors.push('disposable resources remain'); }
    }
    if (!errors.length) await rm(root, { recursive: true, force: true });
    report.cleanupErrors = errors; report.elapsedMs = Date.now() - started;
    report.passed = report.scenariosPassed === true && errors.length === 0;
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    t.diagnostic(`Evidence: ${evidence}/report.json`);
    assert.deepEqual(errors, [], 'Installer acceptance must clean up its disposable resources');
  });
  async function start() {
    await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90');
    controller = await compose('ps', '-q', 'controller');
    const directory = mode === 'public' ? '/data/public-browser' : '/data';
    const instance = await inside(`import {readFile} from 'node:fs/promises';console.log(await readFile('${directory}/runtimes/instance-id','utf8'))`);
    assert.match(instance, /^[a-f0-9-]{36}$/); instances.add(instance);
  }
  async function connect(token?: string) {
    const client = new Client({ name: 'synthetic-install-acceptance', version: '1' }); clients.add(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'),
      token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}));
    return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `MCP ${name} failed`);
    const content = result.content as { type: string; text: string }[];
    assert.equal(content[0].type, 'text'); return JSON.parse(content[0].text);
  }

  report.sourceRevision = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  report.testHash = sha256(await readFile('test/self-host.integration.ts'));
  if (experienceMinutes) report.sourceHashes = Object.fromEntries(await Promise.all(
    ['test/self-host.integration.ts', 'test/browser-experience.ts', 'scripts/experience.mjs', 'deploy/release.env'].map(async path => [path, sha256(await readFile(path))])));
  if (remoteClient) report.sourceHashes = Object.fromEntries(await Promise.all(
    ['test/self-host.integration.ts', 'test/remote-client.ts', 'scripts/remote-client.mjs', 'deploy/release.env'].map(async path => [path, sha256(await readFile(path))])));
  if (proxy) report.sourceHashes = Object.fromEntries(await Promise.all(
    ['test/self-host.integration.ts', 'test/https-proxy.ts', 'scripts/https.mjs', 'deploy/nginx-public.conf', 'deploy/release.env'].map(async path => [path, sha256(await readFile(path))])));
  report.workflow = process.env.GITHUB_ACTIONS === 'true' ?
    `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const server = JSON.parse(await docker('version', '--format', '{{json .Server}}'));
  report.docker = { version: server.Version, os: server.Os, arch: server.Arch };
  report.composeVersion = await docker('compose', 'version', '--short');
  assert.equal(server.Os, 'linux');
  assert.equal(server.Arch, arch() === 'arm64' ? 'arm64' : 'amd64', 'Use native images, without architecture emulation');
  const pins = Object.fromEntries((await readFile('deploy/release.env', 'utf8')).trim().split('\n').map(line => line.split('=')));
  const before = await docker('image', 'ls', '--format', '{{.Repository}}');
  if (process.env.AB_ACCEPTANCE_FRESH_RUNNER === '1') {
    assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
    assert.equal(platform(), 'linux');
    assert.ok(!before.includes('agentic-browser'), 'Fresh-runner acceptance must not reuse browser image caches');
    report.freshHostedRunner = true;
  }
  await exec('python3', ['scripts/package-self-host.py', '--output', join(root, 'expected')]);
  const installer = join(root, 'install.sh');
  await exec('curl', ['--fail', '--silent', '--show-error', '--max-time', '60', '--output', installer, installerUrl]);
  const downloaded = await readFile(installer);
  assert.equal(sha256(downloaded), sha256(await readFile(join(root, 'expected/install.sh'))), 'Live installer differs from reviewed configuration');
  report.installerSha256 = sha256(downloaded);
  await record('public installer matches reviewed configuration');
  await exec('bash', [installer, setup], { env, timeout: 600000, maxBuffer: 4 * 2 ** 20 });
  assert.deepEqual((await readdir(setup)).sort(), ['.env', 'compose.yaml']);
  assert.equal((await stat(join(setup, '.env'))).mode & 0o777, 0o600);
  const password = 'synthetic-install-$literal-#password';
  let settings = (await readFile(join(setup, '.env'), 'utf8'))
    .replace(/^AB_PROJECT_NAME=.*$/m, `AB_PROJECT_NAME=${project}`)
    .replace(/^AB_PORT=.*$/m, `AB_PORT=${port}`)
    .replace(/^AB_ADMIN_PASSWORD=.*$/m, `AB_ADMIN_PASSWORD='${password}'`);
  if (experienceMinutes) settings = settings.replace(/^AB_SESSION_TTL_SECONDS=.*$/m, `AB_SESSION_TTL_SECONDS=${(experienceMinutes + 10) * 60}`);
  if (proxy) settings += `\nAB_PUBLIC_URL=${base}\nAB_TRUST_PROXY=true\n`;
  await writeFile(join(setup, '.env'), settings);
  const config = JSON.parse(await compose('config', '--format', 'json'));
  assert.equal(config.name, project); configured = true;
  assert.equal(config.services.controller.ports[0].host_ip, '127.0.0.1');
  assert.equal(config.services.controller.image, pins.AB_CONTROLLER_IMAGE);
  assert.equal(config.services.controller.environment.BROWSER_RUNTIME_IMAGE, pins.AB_RUNTIME_IMAGE);
  report.images = {};
  for (const [name, image] of [['controller', pins.AB_CONTROLLER_IMAGE], ['runtime', pins.AB_RUNTIME_IMAGE]]) {
    const detail = JSON.parse(await docker('image', 'inspect', image))[0];
    assert.equal(detail.Architecture, server.Arch); assert.equal(detail.Os, 'linux');
    report.images[name] = { reference: image, id: detail.Id, platform: `${detail.Os}/${detail.Architecture}`, anonymousPull: true };
  }
  assert.deepEqual(JSON.parse(await readFile(join(registry, 'config.json'), 'utf8')), {});
  await record('anonymous native pulls; installation contains only compose.yaml and private .env');
  await start();
  assert.match(await compose('exec', '-T', 'controller', 'npm', 'run', 'doctor'), /PASS Private data volume/);
  if (proxy) {
    await proxy.start(); await proxy.verifyTransport();
    await record('HTTPS redirect, trusted CA, untrusted CA and hostname rejection, unknown Host rejection');
    await proxy.verifyRateLimits();
    await record('viewer modules load without throttling while excessive API requests receive 429');
  }
  browser = await chromium.launch({ headless: true, ...(httpsRoot ? { env: { ...process.env, HOME: join(httpsRoot, 'browser-home') } } : {}) });
  const human = await browser.newContext();
  const headers = { Origin: base, 'X-Agentic-Browser': '1' };
  const login = (value: string) => human.request.post(base + '/api/auth/login', { headers, data: { username: 'admin', password: value } });
  assert.equal((await login(password)).status(), 200);
  if (proxy) {
    const cookies = await human.cookies(base);
    assert.equal(cookies.length, 1); assert.equal(cookies[0].secure, true); assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].sameSite, 'Strict');
    assert.equal((await human.request.post(base + '/api/credentials', {
      headers: { ...headers, Origin: 'https://wrong.acceptance.invalid' }, data: { name: 'Rejected origin' },
    })).status(), 403);
    await assert.rejects(connect(), { code: 401 });
    await assert.rejects(connect('synthetic-invalid-token'), { code: 401 });
    report.https.authenticationPassed = true;
    await record('HTTPS secure HttpOnly cookie, foreign-origin denial and missing/invalid MCP token rejection');
  }
  const profileResponse = await human.request.post(base + '/api/profiles', { headers, data: { name: 'Synthetic installation profile' } });
  assert.equal(profileResponse.status(), 201);
  const profile = await profileResponse.json();
  const credential = await human.request.post(base + '/api/credentials', { headers, data: { name: 'Install acceptance', profileIds: [profile.id] } });
  assert.equal(credential.status(), 200); const key = await credential.json();
  let client = await connect(key.token);
  assert.equal((await client.listTools()).tools.length, 11);
  const create = () => call(client, 'browser_create', { purpose: 'Synthetic installation acceptance', profileId: profile.id, url: 'https://agentic-browser.invalid/demo' });
  const session = await create();
  assert.equal(new URL(session.humanUrl).origin, base);
  const runtimes = JSON.parse(await docker('inspect', ...await owned()));
  const chrome = runtimes.find((item: any) => item.HostConfig.NetworkMode === 'none');
  assert.ok(chrome);
  const cdp = `import fs from 'node:fs';import {chromium} from 'playwright';
    let port;for(const id of fs.readdirSync('/proc')){try{const m=fs.readFileSync('/proc/'+id+'/cmdline','utf8').match(/--remote-debugging-port=(\\d+)/);if(m){port=m[1];break;}}catch{}}
    const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});const context=browser.contexts()[0];`;
  await call(client, 'browser_action', { sessionId: session.id, action: { type: 'click', selector: '#username' } });
  const handoff = await call(client, 'browser_handoff', { sessionId: session.id, reason: 'Complete the synthetic sign-in, then hand back.' });
  assert.equal(new URL(handoff.humanUrl).origin, base);
  assert.equal((await client.callTool({ name: 'browser_action', arguments: { sessionId: session.id, action: { type: 'snapshot' } } })).isError, true);
  const page = await human.newPage();
  const stream = { connections: 0, closed: 0, receivedBytes: 0, insecure: 0 };
  if (proxy) {
    report.https.stream = stream;
    report.https.failedRequests = [];
    page.on('response', response => {
      if (response.status() >= 400) report.https.failedRequests.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
    page.on('requestfailed', request => report.https.failedRequests.push({ path: new URL(request.url()).pathname, failure: request.failure()?.errorText }));
  }
  if (proxy) page.on('websocket', socket => {
    stream.connections++; if (new URL(socket.url()).protocol !== 'wss:') stream.insecure++;
    socket.on('framereceived', frame => { stream.receivedBytes += Buffer.byteLength(frame.payload); });
    socket.on('close', () => { stream.closed++; });
  });
  if (experienceMinutes) {
    report.experience = {};
    await verifyDesktopExperience({ page, humanUrl: handoff.humanUrl, sessionId: session.id, client, report: report.experience, record,
      observe: source => docker('exec', chrome.Id, 'node', '--input-type=module', '-e', cdp + source),
      login: async () => { assert.equal((await login(password)).status(), 200); },
      logout: async () => { assert.equal((await human.request.post(base + '/api/auth/logout', { headers, data: {} })).status(), 200); },
    }, experienceMinutes);
  } else await page.goto(handoff.humanUrl);
  const connected = () => page.waitForFunction(() => document.getElementById('connection')?.textContent === 'Connected' && !!document.querySelector('#desktop canvas'));
  await connected(); await page.reload(); await connected();
  await page.locator('#text').fill('synthetic-install-user'); await page.locator('#send-text').click();
  await page.locator('#desktop canvas').focus(); await page.keyboard.press('Tab');
  await page.keyboard.type('fictional-site-password'); await page.keyboard.press('Enter');
  // The synthetic human must see sign-in finish before clicking handback.
  // VNC input and HTTP handback use separate channels. Observe only this owned
  // fixture through the host test driver; the Agent API remains denied above.
  await docker('exec', chrome.Id, 'node', '--input-type=module', '-e', cdp + `
    const page=context.pages().find(p=>p.url()==='http://127.0.0.1:8080/demo');
    await page.waitForFunction(()=>document.body.innerText.includes('Signed in: synthetic-install-user'),null,{timeout:15000});await browser.close();`);
  if (proxy) {
    const connections = stream.connections, began = Date.now();
    await proxy.restart();
    // The existing viewer must reconnect itself; no page reload or TLS bypass.
    await page.waitForFunction(() => document.getElementById('connection')?.textContent === 'Connected', null, { timeout: 20000 });
    for (let attempt = 0; attempt < 100 && stream.connections <= connections; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    await connected();
    assert.ok(stream.connections > connections); assert.ok(stream.receivedBytes > 10000); assert.equal(stream.insecure, 0);
    report.https.proxyRecoveryMs = Date.now() - began;
    await client.close(); clients.delete(client); client = await connect(key.token);
    assert.equal((await client.listTools()).tools.length, 11);
    assert.equal((await client.callTool({ name: 'browser_action', arguments: { sessionId: session.id, action: { type: 'snapshot' } } })).isError, true);
    await record('WSS pixels/input, proxy interruption, automatic viewer recovery and authenticated MCP reconnect');
  }
  const waiting = proxy ? call(client, 'browser_wait', { sessionId: session.id, timeoutSeconds: 20 }) : undefined;
  void waiting?.catch(() => {});
  await page.locator('#resume').click();
  await page.waitForFunction(() => document.getElementById('message')?.textContent?.startsWith('Control returned'));
  if (waiting) { assert.equal((await waiting).status, 'ready'); report.https.stream = stream; report.https.handoffPassed = true; }
  await page.close();
  const snapshot = await call(client, 'browser_action', { sessionId: session.id, action: { type: 'snapshot' } });
  assert.match(snapshot.result.text, /Signed in: synthetic-install-user/);
  await record('account bootstrap, personal token, native desktop reconnect, human typing and Agent handback');
  if (experienceMinutes) {
    await verifyExternalExperience(client, session.id, report.experience, record);
    report.experience.stage = 'native handoff on a public repository file';
    const externalHandoff = await call(client, 'browser_handoff', { sessionId: session.id, reason: 'View the public repository file, then hand control back.' });
    const externalPage = await human.newPage();
    await externalPage.goto(externalHandoff.humanUrl);
    await externalPage.waitForFunction(() => document.getElementById('connection')?.textContent === 'Connected' && !!document.querySelector('#desktop canvas'));
    // The VNC connection can be ready before the first framebuffer is painted.
    // Require varied page pixels below Chrome's toolbar before taking evidence.
    await externalPage.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#desktop canvas');
      const context = canvas?.getContext('2d');
      if (!canvas || !context || canvas.width < 400 || canvas.height < 400) return false;
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set<string>(); let light = 0, dark = 0;
      for (let y = 200; y < canvas.height; y += 10) for (let x = 30; x < canvas.width; x += 10) {
        const i = (y * canvas.width + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
        colors.add(`${r},${g},${b}`);
        if (Math.min(r, g, b) > 230) light++;
        if (Math.max(r, g, b) < 120) dark++;
      }
      return colors.size > 20 && light > 100 && dark > 5;
    }, null, { timeout: 15000 });
    await externalPage.locator('#desktop canvas').focus(); await externalPage.keyboard.press('End'); await externalPage.keyboard.press('Home');
    await mkdir('output/playwright', { recursive: true });
    report.experience.externalScreenshot = `output/playwright/experience-${runId}-public-repository.png`;
    await externalPage.screenshot({ path: report.experience.externalScreenshot, fullPage: true });
    await externalPage.locator('#resume').click();
    await externalPage.waitForFunction(() => document.getElementById('message')?.textContent?.startsWith('Control returned'));
    await externalPage.close();
    assert.match((await call(client, 'browser_action', { sessionId: session.id, action: { type: 'snapshot' } })).result.text, /Playwright/);
    report.experience.externalHandoffPassed = true;
    await record('native desktop displays public repository content and returns control to the Agent');
  }
  report.resources = (await docker('stats', '--no-stream', '--format', '{{json .}}', controller, ...await owned())).split('\n').map(line => {
    const row = JSON.parse(line); return { cpu: row.CPUPerc, memory: row.MemUsage, pids: row.PIDs };
  });
  // The saved cookie is synthetic and is written after Agent control resumes.
  await docker('exec', chrome.Id, 'node', '--input-type=module', '-e', cdp + `await context.addCookies([{name:'install_fixture',value:'synthetic-only',url:'https://example.test/',expires:Date.now()/1000+3600}]);await browser.close();`);
  await call(client, 'browser_close', { sessionId: session.id }); assert.deepEqual(await owned(), []);
  if (proxy) {
    const temporary = await human.request.post(base + '/api/credentials', { headers, data: { name: 'Synthetic TLS revocation' } });
    assert.equal(temporary.status(), 200); const revoked = await temporary.json();
    const revokedClient = await connect(revoked.token); assert.equal((await revokedClient.listTools()).tools.length, 11);
    assert.equal((await human.request.delete(base + '/api/credentials/' + revoked.id, { headers })).status(), 200);
    await assert.rejects(revokedClient.listTools(), { code: 401 }); await assert.rejects(connect(revoked.token), { code: 401 });
    await revokedClient.close(); clients.delete(revokedClient);
    report.https.revocationPassed = true;
    await record('HTTPS token revocation denies existing and newly connected MCP clients');
  }
  if (remoteClient) await verifyRemoteClients({ docker, env, controller, image: pins.AB_CONTROLLER_IMAGE, base, human, headers, profileId: profile.id, report, record });
  await client.close(); clients.delete(client);
  await writeFile(join(setup, '.env'), settings.replace(/^AB_ADMIN_PASSWORD=.*$/m, "AB_ADMIN_PASSWORD='changed-but-must-not-reset'"));
  await start();
  assert.equal((await login(password)).status(), 200); assert.equal((await login('changed-but-must-not-reset')).status(), 401);
  client = await connect(key.token);
  const reopened = await create();
  const reopenedChrome = JSON.parse(await docker('inspect', ...await owned())).find((item: any) => item.HostConfig.NetworkMode === 'none');
  assert.equal(await docker('exec', reopenedChrome.Id, 'node', '--input-type=module', '-e', cdp + `console.log((await context.cookies()).some(c=>c.name==='install_fixture'&&c.value==='synthetic-only'));await browser.close();`), 'true');
  await call(client, 'browser_close', { sessionId: reopened.id });
  await record('controller recreation preserves account, token and synthetic saved-profile cookie');
  settings = settings.replace(/^AB_ADMIN_(USERNAME|PASSWORD)=.*\n/gm, ''); await writeFile(join(setup, '.env'), settings);
  await start();
  assert.equal((await login(password)).status(), 200); assert.equal((await client.listTools()).tools.length, 11);
  await record('removing bootstrap settings preserves existing access');
  await client.close(); clients.delete(client);
  mode = 'public'; await writeFile(join(setup, '.env'), settings.replace('AB_MODE=authenticated', 'AB_MODE=public'));
  await start(); client = await connect();
  assert.equal((await client.listTools()).tools.length, 9);
  const publicSession = await call(client, 'browser_create', { purpose: 'Synthetic public installation acceptance', url: 'https://agentic-browser.invalid/demo' });
  const access = { sessionId: publicSession.id, sessionKey: publicSession.sessionKey };
  assert.ok((await call(client, 'browser_action', { ...access, action: { type: 'snapshot' } })).result);
  await call(client, 'browser_close', access);
  assert.deepEqual(await owned(), []);
  const capacity = await fetch(base + '/api/public/capacity').then(response => response.json());
  assert.equal(capacity.currentSessions, 0);
  await record('same installation switches to public MCP with isolated temporary browser data');
  report.scenariosPassed = true;
});
