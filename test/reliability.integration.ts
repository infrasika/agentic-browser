import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const exec = promisify(execFile);
function setting(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isInteger(value) && value >= min && value <= max, `${name} must be ${min}-${max}`);
  return value;
}
const rounds = setting('AB_RELIABILITY_ROUNDS', 3, 1, 30);
const holdSeconds = setting('AB_RELIABILITY_HOLD_SECONDS', 15, 0, 120);
type Access = { sessionId: string; sessionKey?: string };

test('Docker reliability: repeated capacity, isolation, expiry, revocation and interrupted containers', {
  timeout: (rounds * (holdSeconds + 120) + 660) * 1000,
}, async t => {
  const started = Date.now();
  const runId = randomUUID();
  const evidence = join('output', 'reliability', `${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}`);
  await mkdir(evidence, { recursive: true });
  const report: Record<string, any> = { startedAt: new Date(started).toISOString(), rounds, holdSeconds,
    host: { platform: platform(), arch: arch(), release: release() }, passed: false, checks: [], samples: [] };
  async function record(name: string, details: Record<string, unknown> = {}) {
    report.checks.push({ name, elapsedMs: Date.now() - started, ...details });
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`[reliability] ${name}: ${JSON.stringify(details)}`);
  }
  const root = await mkdtemp(join(tmpdir(), 'ab-reliability-'));
  const configFile = join(root, '.env');
  await writeFile(configFile, '', { mode: 0o600 });
  const project = `ab-reliability-${runId}`;
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  // Deliberately exclude deployment settings and credentials from the shell or
  // local .env. Only explicit candidate image references are inherited.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AB_')));
  Object.assign(env, { AB_PROJECT_NAME: project, AB_PORT: String(port), AB_PUBLIC_URL: base,
    AB_BIND_ADDRESS: '127.0.0.1', AB_MODE: 'public', AB_MAX_SESSIONS: '5', AB_MAX_SESSIONS_PER_IP: '1',
    AB_MAX_SESSIONS_PER_MEMBER: '1', AB_TRUST_PROXY: 'true', AB_COMPOSE_ENV_FILE: configFile,
    AB_SESSION_TTL_SECONDS: '180', AB_SESSION_MAX_LIFETIME_SECONDS: '300',
    AB_CONTROLLER_IMAGE: process.env.AB_CONTROLLER_IMAGE ?? 'agentic-browser:controller-preview',
    AB_RUNTIME_IMAGE: process.env.AB_RUNTIME_IMAGE ?? 'agentic-browser:zkpass-prototype' });
  const compose = async (...args: string[]) => (await exec('bash', ['scripts/compose.sh', ...args], { env, timeout: 120000, maxBuffer: 2 ** 20 })).stdout.trim();
  const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 45000, maxBuffer: 2 ** 20 })).stdout.trim();
  let controller = '';
  const instances = new Set<string>();
  const clients = new Set<Client>();
  const inside = (source: string) => docker('exec', controller, 'node', '--import', 'tsx', '--input-type=module', '-e', source);
  async function owned() {
    const ids = new Set<string>();
    for (const instance of instances)
      for (const id of (await docker('ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`)).split(/\s+/).filter(Boolean)) ids.add(id);
    return [...ids];
  }
  async function eventually(name: string, check: () => Promise<boolean>, timeout = 30000) {
    const end = Date.now() + timeout;
    do { if (await check()) return; await delay(1000); } while (Date.now() < end);
    assert.fail(`Timed out: ${name}`);
  }
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, signal: AbortSignal.timeout(30000) });
  const headers = (cookie = '') => ({ Origin: base, 'X-Agentic-Browser': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) });
  const capacity = async () => { const response = await request('/api/public/capacity'); assert.equal(response.status, 200); return response.json(); };
  async function connect(extraHeaders: Record<string, string>) {
    const client = new Client({ name: 'synthetic-reliability-fixture', version: '1' }); clients.add(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: extraHeaders } }));
    return client;
  }
  async function disconnect(client: Client) { await client.close(); clients.delete(client); }
  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(Array.isArray(response.content));
    const first = response.content[0]; assert.equal(first.type, 'text');
    return JSON.parse(first.text as string);
  }
  const action = (client: Client, access: Access, action: object) => call(client, 'browser_action', { ...access, action });
  async function create(client: Client, purpose: string) {
    const session = await call(client, 'browser_create', { purpose, url: 'https://agentic-browser.invalid/demo' });
    assert.match(session.id ?? '', /^[a-f0-9-]{36}$/, `Session creation failed: ${session.error ?? 'missing ID'}`);
    return { session, access: { sessionId: session.id, ...(session.sessionKey ? { sessionKey: session.sessionKey } : {}) } as Access };
  }
  async function sample(stage: string) {
    const ids = [controller, ...await owned()];
    const rows = (await docker('stats', '--no-stream', '--format', '{{json .}}', ...ids)).split('\n').filter(Boolean).map(line => JSON.parse(line));
    report.samples.push({ stage, elapsedMs: Date.now() - started,
      containers: rows.map(row => ({ name: row.Name, cpu: row.CPUPerc, memory: row.MemUsage, pids: row.PIDs })) });
  }
  async function start() {
    await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '90');
    controller = await compose('ps', '-q', 'controller');
    const directory = env.AB_MODE === 'public' ? '/data/public-browser' : '/data';
    const instance = await inside(`import {readFile} from 'node:fs/promises';console.log(await readFile('${directory}/runtimes/instance-id','utf8'))`);
    assert.match(instance, /^[a-f0-9-]{36}$/); instances.add(instance);
  }
  async function emptyPublic() {
    await eventually('public capacity and containers reclaimed', async () => (await capacity()).currentSessions === 0 && (await owned()).length === 0);
  }
  async function handback(client: Client, access: Access, cookie: string, revision: number) {
    const waiting = call(client, 'browser_wait', { ...access, afterRevision: revision, timeoutSeconds: 10 });
    // All human requests in this test belong to synthetic fixture identities.
    const resumed = await request(`/api/human/${access.sessionId}/resume`, { method: 'POST', headers: headers(cookie), body: '{}' });
    assert.equal(resumed.status, 200);
    assert.equal((await waiting).status, 'ready');
  }
  t.after(async () => {
    const errors: string[] = [];
    await Promise.allSettled([...clients].map(client => client.close()));
    try { await compose('down', '--timeout', '30'); } catch { errors.push('controller shutdown failed'); }
    try { for (const id of await owned()) await docker('rm', '-f', id); } catch { errors.push('label-scoped runtime cleanup failed'); }
    try { await compose('down', '--volumes'); } catch { errors.push('disposable volume removal failed'); }
    try {
      assert.deepEqual(await owned(), []);
      assert.equal(await docker('ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`), '');
      assert.equal(await docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`), '');
    } catch { errors.push('disposable resources remain'); }
    await rm(root, { recursive: true, force: true });
    report.cleanupErrors = errors; report.elapsedMs = Date.now() - started;
    report.passed = report.scenariosPassed === true && errors.length === 0;
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    t.diagnostic(`Evidence: ${evidence}/report.json`);
    assert.deepEqual(errors, [], 'Reliability fixture must remove only its own resources');
  });

  report.sourceBase = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
  report.sourceHashes = Object.fromEntries(await Promise.all(['src/sessions.ts', 'test/reliability.integration.ts'].map(async path =>
    [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  report.dockerVersion = JSON.parse(await docker('version', '--format', '{{json .Server}}')).Version;
  report.composeVersion = await docker('compose', 'version', '--short');
  report.images = {};
  for (const [key, image] of [['controller', env.AB_CONTROLLER_IMAGE!], ['runtime', env.AB_RUNTIME_IMAGE!]]) {
    const data = JSON.parse(await docker('image', 'inspect', image))[0];
    report.images[key] = { reference: image, id: data.Id, platform: `${data.Os}/${data.Architecture}` };
  }
  await start(); await emptyPublic(); await record('isolated public deployment started');

  for (let round = 1; round <= rounds; round++) {
    const peers = await Promise.all(Array.from({ length: 6 }, (_, i) => connect({ 'X-Real-IP': `198.51.100.${i + 1}` })));
    const allocations = await Promise.all(peers.map(client => call(client, 'browser_create', { purpose: `Synthetic round ${round}` })));
    const live = allocations.flatMap((session, i) => session.id ? [{ client: peers[i], session,
      access: { sessionId: session.id, sessionKey: session.sessionKey } as Access, source: `198.51.100.${i + 1}` }] : []);
    assert.equal(live.length, 5);
    const rejected = allocations.filter(session => !session.id);
    assert.equal(rejected.length, 1); assert.equal(rejected[0].error, 'session_limit');
    assert.equal(rejected[0].capacity.currentSessions, 5);
    assert.equal((await capacity()).full, true); assert.equal((await owned()).length, 10);
    await sample(`public round ${round} full`);
    await Promise.all(live.map(async ({ client, access }, i) => {
      assert.equal((await action(client, { ...access, sessionId: live[(i + 1) % live.length].session.id }, { type: 'snapshot' })).status, 404);
      const marker = `reliability-${round}-${i}`;
      await action(client, access, { type: 'fill', selector: '#username', text: marker });
      await action(client, access, { type: 'fill', selector: '#password', text: 'synthetic-only-password' });
      await action(client, access, { type: 'press', key: 'Enter' });
      const snapshot = await action(client, access, { type: 'snapshot' });
      assert.ok(snapshot.result?.text.includes(`Signed in: ${marker}`), 'Each browser retains its own fixture state');
    }));
    await disconnect(live[0].client);
    live[0].client = await connect({ 'X-Real-IP': live[0].source });
    assert.equal((await call(live[0].client, 'browser_status', live[0].access)).control, 'agent');
    const handoff = await call(live[0].client, 'browser_handoff', live[0].access);
    assert.equal((await action(live[0].client, live[0].access, { type: 'snapshot' })).status, 409);
    const [sessionId, ticket] = new URL(handoff.humanUrl).hash.slice(1).split('.');
    const claimed = await request('/api/public/claim', { method: 'POST', headers: headers(), body: JSON.stringify({ sessionId, ticket }) });
    assert.equal(claimed.status, 200); await claimed.json();
    const cookie = claimed.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request(`/api/human/${live[1].session.id}`, { headers: { Cookie: cookie } })).status, 404);
    await handback(live[0].client, live[0].access, cookie, handoff.revision);
    const until = Date.now() + holdSeconds * 1000;
    while (Date.now() < until) {
      await Promise.all(live.map(async ({ client, access }) => assert.ok((await action(client, access, { type: 'snapshot' })).result?.text.includes('Signed in: reliability-'))));
      await delay(Math.min(5000, Math.max(0, until - Date.now())));
    }
    // Kill only a labelled runtime from this disposable installation, while
    // the other four browsers continue. Do not poll its status to trigger cleanup.
    if (round === 1) {
      const details = JSON.parse(await docker('inspect', ...await owned()));
      const victim = details.find((item: any) => item.Config.Labels['dev.agentic-browser.runtime'] === live[0].session.runtime.id && item.HostConfig.NetworkMode === 'none');
      assert.ok(victim); const killedAt = Date.now();
      await docker('kill', '--signal', 'KILL', victim.Id);
      await eventually('stopped runtime releases its slot without Agent traffic', async () =>
        (await capacity()).currentSessions === 4 && (await owned()).length === 8);
      await record('runtime crash reclaimed without Agent request', { recoveryMs: Date.now() - killedAt });
      const replacement = await create(live[0].client, 'Replacement after runtime failure');
      live[0] = { ...live[0], ...replacement };
      assert.equal((await capacity()).currentSessions, 5);
    }
    await Promise.all(live.map(async ({ client, access }) => assert.equal((await call(client, 'browser_close', access)).control, 'closed')));
    await emptyPublic();
    assert.equal((await request('/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
    await Promise.all([...new Set([...peers, ...live.map(item => item.client)])].filter(client => clients.has(client)).map(disconnect));
    await record('public capacity cycle passed', { round, peakSessions: 5, remainingSessions: 0 });
  }

  const expiryClient = await connect({ 'X-Real-IP': '198.51.100.20' });
  const expiring = await create(expiryClient, 'Natural five-minute expiry');
  assert.equal(expiring.session.ttlSeconds, 300);
  const expiresAt = Date.parse(expiring.session.expiresAt);
  await disconnect(expiryClient);
  await record('natural expiry started', { expectedExpiry: expiring.session.expiresAt });
  let nextProgress = Date.now() + 30000;
  while (Date.now() < expiresAt) {
    const current = await capacity();
    if (Date.now() < expiresAt - 1000) assert.equal(current.currentSessions, 1);
    if (Date.now() >= nextProgress) { console.log(`[reliability] Natural expiry: ${Math.ceil((expiresAt - Date.now()) / 1000)} seconds remaining`); nextProgress = Date.now() + 30000; }
    await delay(Math.min(5000, Math.max(0, expiresAt - Date.now())));
  }
  await emptyPublic(); await record('natural expiry reclaimed disconnected browser', { cleanupAfterExpiryMs: Date.now() - expiresAt });
  const afterExpiry = await connect({ 'X-Real-IP': '198.51.100.20' });
  const first = await create(afterExpiry, 'After expiry');
  const secondClient = await connect({ 'X-Real-IP': '198.51.100.21' });
  const second = await create(secondClient, 'Crash cleanup companion');
  await compose('kill', '-s', 'SIGKILL', 'controller');
  await compose('up', '-d', '--wait', '--wait-timeout', '90');
  controller = await compose('ps', '-q', 'controller'); await emptyPublic();
  for (const [client, access] of [[afterExpiry, first.access], [secondClient, second.access]] as const)
    assert.equal((await call(client, 'browser_status', access)).status, 404);
  await record('controller crash cleared orphan containers and old capabilities');
  await Promise.all([...clients].map(disconnect));

  env.AB_MODE = 'authenticated'; env.AB_ADMIN_USERNAME = 'reliability0'; env.AB_ADMIN_PASSWORD = 'synthetic-reliability-password';
  await start();
  await inside(`import {IdentityStore} from './src/identity.ts';const store=new IdentityStore('/data/identity');
    for(let i=1;i<5;i++)await store.createMember('reliability'+i,'synthetic-reliability-password');store.close();`);
  const members: { cookie: string; credential: { id: string; token: string }; client: Client }[] = [];
  // Account setup respects the four-concurrent-password-check guard. Browser
  // creation below is still simultaneous and exercises all five member slots.
  for (let i = 0; i < 5; i++) {
    const login = await request('/api/auth/login', { method: 'POST', headers: headers(), body: JSON.stringify({ username: `reliability${i}`, password: env.AB_ADMIN_PASSWORD }) });
    assert.equal(login.status, 200); await login.json(); const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const response = await request('/api/credentials', { method: 'POST', headers: headers(cookie), body: JSON.stringify({ name: 'Synthetic reliability Agent' }) });
    assert.equal(response.status, 200); const credential = await response.json();
    members.push({ cookie, credential, client: await connect({ Authorization: `Bearer ${credential.token}` }) });
  }
  const privateSessions = await Promise.all(members.map((member, i) => create(member.client, `Member ${i}`)));
  for (let i = 0; i < members.length; i++) {
    assert.equal((await call(members[i].client, 'browser_sessions')).sessions.length, 1);
    assert.equal((await call(members[i].client, 'browser_status', privateSessions[(i + 1) % members.length].access)).status, 404);
  }
  assert.equal((await call(members[0].client, 'browser_create', { purpose: 'Over capacity' })).status, 429);
  await sample('authenticated five-member peak');
  const current = privateSessions[0];
  const transfer = await call(members[0].client, 'browser_handoff', { ...current.access, reason: 'Synthetic human fixture' });
  assert.equal((await action(members[0].client, current.access, { type: 'snapshot' })).status, 409);
  const cancel = new AbortController();
  const pending = members[0].client.callTool({ name: 'browser_wait', arguments: { ...current.access, timeoutSeconds: 25 } }, undefined, { signal: cancel.signal });
  const cancelled = assert.rejects(pending); await delay(300); cancel.abort(); await cancelled;
  assert.equal((await call(members[0].client, 'browser_status', current.access)).control, 'human');
  await handback(members[0].client, current.access, members[0].cookie, transfer.revision);
  await disconnect(members[1].client);
  members[1].client = await connect({ Authorization: `Bearer ${members[1].credential.token}` });
  assert.equal((await call(members[1].client, 'browser_status', privateSessions[1].access)).control, 'agent');
  const revoked = await request(`/api/credentials/${members[0].credential.id}`, { method: 'DELETE', headers: headers(members[0].cookie) });
  assert.equal(revoked.status, 200); await revoked.json();
  await assert.rejects(members[0].client.listTools());
  // Revoking a token does not discard its owner's live browser. The owner can
  // still close it from the dashboard; other members cannot acquire it.
  assert.equal((await request(`/api/human/${current.session.id}`, { headers: { Cookie: members[1].cookie } })).status, 404);
  assert.equal((await request(`/api/human/${current.session.id}`, { method: 'DELETE', headers: headers(members[0].cookie) })).status, 200);
  await Promise.all(members.slice(1).map(async (member, i) => assert.equal((await call(member.client, 'browser_close', privateSessions[i + 1].access)).control, 'closed')));
  await eventually('private runtimes removed', async () => (await owned()).length === 0);
  for (const member of members) {
    const response = await request('/api/sessions', { headers: { Cookie: member.cookie } });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).sessions, []);
  }
  await record('five-member isolation, wait cancellation, reconnect and token revocation passed');
  await create(members[1].client, 'Graceful shutdown cleanup');
  await compose('stop', '--timeout', '60', 'controller');
  assert.deepEqual(await owned(), []);
  await record('graceful shutdown reclaimed final active browser');
  report.scenariosPassed = true;
});
