import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { IdentityStore } from '../src/identity.js';
import { readConfig } from '../src/config.js';
import { SessionRegistry } from '../src/sessions.js';
import { createHttpServer } from '../src/http.js';
import { fakeWorkspace } from './helpers.js';

const password = 'synthetic-bootstrap-password';
const result = (value: any) => JSON.parse(value.content[0].text);

test('bootstrap creates exactly one account, stores only a hash, and never resets existing or disabled accounts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ab-bootstrap-'));
  let store = new IdentityStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const second = new IdentityStore(directory);
  try {
    const created = await Promise.all([store.bootstrapAdmin('admin', password), second.bootstrapAdmin('other', password)]);
    assert.equal(created.filter(Boolean).length, 1);
  } finally { second.close(); }
  const username = String(store.listMembers()[0].username);
  const login = await store.login(username, password, 'fixture');
  const credential = store.issueAgent(store.authenticate(login.token, 'human'), 'Initial Agent');
  assert.equal((await readFile(join(directory, 'identity.sqlite'))).includes(Buffer.from(password)), false);
  store.close(); store = new IdentityStore(directory);
  assert.equal(await store.bootstrapAdmin(username, 'changed-bootstrap-password'), false);
  assert.equal(await store.bootstrapAdmin('another-admin', password), false);
  assert.equal(store.listMembers().length, 1);
  assert.ok(store.authenticate(credential.token, 'agent'));
  await store.login(username, password, 'fixture');
  await assert.rejects(store.login(username, 'changed-bootstrap-password', 'fixture'));
  store.setActive(username, false);
  assert.equal(await store.bootstrapAdmin(username, password), false);
  await assert.rejects(store.login(username, password, 'fixture'));
});

test('unified modes fail closed on typos, keep public limits, and ignore bootstrap credentials in public mode', () => {
  const base = { BROWSER_MODE: 'docker', BROWSER_DATA_DIR: '/data' };
  const privateConfig = readConfig({ ...base, AB_MODE: 'authenticated', AB_ADMIN_USERNAME: 'Admin', AB_ADMIN_PASSWORD: password });
  assert.equal(privateConfig.authMode, 'team');
  assert.equal(privateConfig.bootstrapAdmin?.username, 'admin');
  const publicConfig = readConfig({ ...base, AB_MODE: 'public', AB_ADMIN_USERNAME: 'admin', AB_ADMIN_PASSWORD: '' });
  assert.equal(publicConfig.bootstrapAdmin, undefined);
  assert.equal(publicConfig.dataDirectory, '/data/public-browser');
  assert.equal(publicConfig.ttlMs, 300000);
  assert.equal(publicConfig.maxLifetimeMs, 600000);
  assert.equal(readConfig({ ...base, BROWSER_AUTH_MODE: 'team' }).authMode, 'team');
  assert.equal(readConfig({ ...base, BROWSER_AUTH_MODE: 'authenticated' }).authMode, 'team');
  for (const fields of [{ AB_MODE: 'typo' }, { AB_MODE: 'team' }, { AB_MODE: 'authenticated', AB_ADMIN_USERNAME: 'admin' },
    { AB_MODE: 'authenticated', AB_ADMIN_PASSWORD: password }, { AB_MODE: 'authenticated', AB_ADMIN_USERNAME: 'admin', AB_ADMIN_PASSWORD: 'short' }])
    assert.throws(() => readConfig({ ...base, ...fields }));
});

test('private HTTP MCP requires personal tokens and preserves isolation, human handoff, cancellation, and revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ab-private-mcp-'));
  const identity = new IdentityStore(directory);
  await identity.bootstrapAdmin('admin', password);
  await identity.createMember('alice', password);
  const registry = new SessionRegistry({ create: async () => fakeWorkspace(), close: async () => {} }, { ttlMs: 60000, maxSessions: 4 });
  const options = { identity, publicUrl: 'http://127.0.0.1' };
  const server = createHttpServer(registry, options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await server.closeRemoteMcp(); await registry.close(); server.close(); server.closeAllConnections();
    identity.close(); await rm(directory, { recursive: true, force: true });
  });
  const login = await identity.login('admin', password, 'fixture');
  const human = identity.authenticate(login.token, 'human');
  const key = identity.issueAgent(human, 'Codex');
  const other = identity.issueAgent(human, 'Another Agent');
  const aliceLogin = await identity.login('alice', password, 'fixture');
  const aliceKey = identity.issueAgent(identity.authenticate(aliceLogin.token, 'human'), 'Alice Agent');
  const connect = async (token: string) => {
    const client = new Client({ name: 'private-test', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const raw = (headers: Record<string, string> = {}, suffix = '') => fetch(base + '/mcp' + suffix, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}',
  });
  for (const headers of [{}, { Cookie: `ab_login=${login.token}` }, { Authorization: `Bearer ${login.token}` }, { Authorization: 'Bearer invalid' }] as Record<string, string>[])
    assert.equal((await raw(headers)).status, 401);
  assert.equal((await raw({ Authorization: `Bearer ${key.token}` }, '?token=never-in-url')).status, 400);
  assert.equal((await raw({ Authorization: `Bearer ${key.token}`, Origin: 'https://untrusted.invalid' })).status, 403);
  const admin = await connect(key.token), sibling = await connect(other.token), alice = await connect(aliceKey.token);
  assert.equal((await admin.listTools()).tools.length, 11);
  const created = result(await admin.callTool({ name: 'browser_create', arguments: { purpose: 'Private fixture' } }));
  assert.equal(new URL(created.humanUrl).origin, base);
  for (const client of [sibling, alice]) {
    assert.deepEqual(result(await client.callTool({ name: 'browser_sessions', arguments: {} })).sessions, []);
    for (const name of ['browser_status', 'browser_screenshot', 'browser_close', 'browser_human_link'])
      assert.equal(result(await client.callTool({ name, arguments: { sessionId: created.id } })).status, 404);
  }
  const action = { name: 'browser_action', arguments: { sessionId: created.id, action: { type: 'snapshot' } } };
  assert.notEqual((await admin.callTool(action)).isError, true);
  const handoff = result(await admin.callTool({ name: 'browser_handoff', arguments: { sessionId: created.id, reason: 'Sign in' } }));
  assert.equal(handoff.humanUrl, created.humanUrl);
  assert.equal(result(await admin.callTool(action)).status, 409);
  const cancel = new AbortController();
  const wait = admin.callTool({ name: 'browser_wait', arguments: { sessionId: created.id, timeoutSeconds: 25 } }, undefined, { signal: cancel.signal });
  const cancelled = assert.rejects(wait);
  await new Promise(resolve => setTimeout(resolve, 100)); cancel.abort(); await cancelled;
  assert.equal(registry.get(created.id, human.ownerId).info().control, 'human');
  const resume = await fetch(base + `/api/human/${created.id}/resume`, { method: 'POST',
    headers: { Cookie: `ab_login=${login.token}`, Origin: base, 'X-Agentic-Browser': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(resume.status, 200);
  assert.notEqual((await admin.callTool(action)).isError, true);
  assert.notEqual((await admin.callTool({ name: 'browser_close', arguments: { sessionId: created.id } })).isError, true);
  identity.revokeAgent(human, key.id);
  assert.equal((await raw({ Authorization: `Bearer ${key.token}` })).status, 401);
  await assert.rejects(admin.listTools());
  // Custom HTTPS domains still route the adapter locally and retain external links.
  options.publicUrl = 'https://workspace.example.test';
  const proxy = createServer((incoming, response) => {
    const outgoing = httpRequest(base + incoming.url, { method: incoming.method, headers: { ...incoming.headers, host: 'workspace.example.test' } }, upstream => {
      response.writeHead(upstream.statusCode!, upstream.headers); upstream.pipe(response);
    });
    outgoing.on('error', () => response.destroy()); incoming.pipe(outgoing);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => { proxy.close(); proxy.closeAllConnections(); });
  const domain = new Client({ name: 'domain-test', version: '1' }); clients.push(domain);
  await domain.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${other.token}` } } }));
  const remote = result(await domain.callTool({ name: 'browser_create', arguments: { purpose: 'Domain fixture' } }));
  assert.equal(new URL(remote.humanUrl).origin, options.publicUrl);
  await domain.callTool({ name: 'browser_close', arguments: { sessionId: remote.id } });
});
