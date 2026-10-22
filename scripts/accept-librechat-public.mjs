import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';

const origin = 'https://agentic-browser.zkpass.org';
const checks = [];
for (const [path, status] of [
  ['/', 200], ['/mcp', 404], ['/mcp/', 404], ['/api/mcp/servers', 404],
  ['/internal/v1/leases', 404], ['/browser/internal', 404],
  ['/connect', 410], ['/api/public/sessions', 410],
  ['/api/agentic-browser/11111111-1111-4111-8111-111111111111', 401],
]) {
  const r = await fetch(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { 'x-user-id': 'forged-user', 'x-tenant-id': 'forged-tenant' } });
  assert.equal(r.status, status, path);
  assert.notEqual(r.headers.get('cf-cache-status'), 'HIT', `${path} must not use shared caching`);
  checks.push({ path, status, cache: r.headers.get('cf-cache-status') });
}
const socket = new WebSocket('wss://agentic-browser.zkpass.org/browser/v1/input', { origin });
try {
  const closed = once(socket, 'close', { signal: AbortSignal.timeout(10000) });
  await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
  socket.send(JSON.stringify({ grant: 'invalid' }));
  const [code] = await closed;
  assert.equal(code, 1008);
  checks.push({ websocket: 'upgrade_works_but_invalid_grant_is_rejected' });
} finally { socket.terminate(); }
const report = { passed: true, completedAt: new Date().toISOString(), checks,
  limitation: 'Unauthenticated public route and WebSocket checks; real Turnstile completion requires a human browser.' };
await mkdir('output/librechat', { recursive: true });
await writeFile('output/librechat/public-routing.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
