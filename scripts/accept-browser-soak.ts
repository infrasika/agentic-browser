import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { DockerEngine } from '../src/docker-runtime.js';
import { BrowserService } from '../src/scheduling/service.js';
import { SchedulerStore, type Lease } from '../src/scheduling/store.js';
import { ViewerGrants } from '../src/streaming/grants.js';
import { createDataServer } from '../src/streaming/server.js';

// Isolated load test with its own service, ledger, listener and runtime identity.
// Run only on a host with spare capacity; no deployed installation is required.
if (!process.argv.includes('--run')) {
  console.log('Usage: BROWSER_RUNTIME_IMAGE=sha256:... node --import tsx scripts/accept-browser-soak.ts --run [--capacity=1] [--hold-seconds=300]');
  process.exit(0);
}
const holdSeconds = Number(process.argv.find(arg => arg.startsWith('--hold-seconds='))?.split('=')[1] ?? 300);
assert.ok(Number.isInteger(holdSeconds) && holdSeconds >= 30 && holdSeconds <= 300, 'Hold must be 30–300 seconds');
const capacity = Number(process.argv.find(arg => arg.startsWith('--capacity='))?.split('=')[1] ?? 1);
assert.ok(Number.isInteger(capacity) && capacity >= 1 && capacity <= 10, 'Capacity must be 1–10');
const image = process.env.BROWSER_RUNTIME_IMAGE;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'Use a verified local runtime image ID');
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const available = async () => Number(/MemAvailable:\s+(\d+)/.exec(await readFile('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024;
assert.ok(await available() >= 8192, 'At least 8 GiB available memory is required before starting');
const directory = await mkdtemp(join(tmpdir(), 'browser-soak-'));
const engine = new DockerEngine({ dataDirectory: directory, image, network: 'public' });
const store = new SchedulerStore(join(directory, 'scheduler.sqlite'), capacity);
const service = new BrowserService(store, engine, { ttlMs: 600000, maxLifetimeMs: 600000, queueTtlMs: 600000, maxQueued: 10 });
const grants = new ViewerGrants();
const origin = 'http://127.0.0.1';
const server = createDataServer(service, grants, origin);
type Viewer = { lease: Lease; socket: WebSocket; expectedClose: boolean; frames: number; lastFrameAt: number; gaps: number[] };
const viewers: Viewer[] = [];
const leases: Lease[] = [];
const operationMs: number[] = [];
const healthMs: number[] = [];
const checks: string[] = [];
const startedAt = new Date().toISOString();
const deadline = Date.now() + 9 * 60000;
let stopped: string | undefined;
let minimumAvailableMiB = Infinity;
let monitoring = false;
let cleaning = false;
let guardTimer: ReturnType<typeof setInterval> | undefined;
let instance: string | undefined;
let stage = 'startup';
let heldMs = 0;
let cycles = 0;
let failure: string | undefined;
let cleanup: { passed: boolean; remainingContainers?: number; liveLeases?: number } = { passed: false };
const guard = async () => {
  minimumAvailableMiB = Math.min(minimumAvailableMiB, await available());
  if (minimumAvailableMiB < 3072) stopped ??= 'memory_reserve_3_gib';
  if (Date.now() >= deadline) stopped ??= 'run_deadline';
  if (stopped) throw new Error(stopped);
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped ??= 'interrupted'; });
const p95 = (values: number[]) => {
  assert.ok(values.length, 'No latency samples');
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]);
};
async function active(lease: Lease) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    await guard();
    const current = store.get(lease.id);
    if (current.state === 'active') return current;
    assert.equal(current.state, 'starting', 'Browser did not start');
    await delay(500);
  }
  throw new Error('browser_start_deadline');
}
async function observe(lease: Lease) {
  const grant = grants.issue({ ...lease, leaseId: lease.id, role: 'observe' });
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}${grant.path}`, { origin });
  const viewer: Viewer = { lease, socket, expectedClose: false, frames: 0, lastFrameAt: 0, gaps: [] };
  viewers.push(viewer);
  socket.on('error', () => { if (!viewer.expectedClose && !cleaning) stopped ??= 'viewer_error'; });
  socket.on('close', () => { if (!viewer.expectedClose && !cleaning) stopped ??= 'viewer_closed'; });
  socket.on('message', data => {
    const bytes = Buffer.from(data as Buffer);
    if (bytes.length < 1000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) { stopped ??= 'invalid_jpeg_frame'; return; }
    const now = Date.now();
    if (viewer.lastFrameAt) viewer.gaps.push(now - viewer.lastFrameAt);
    viewer.lastFrameAt = now;
    viewer.frames++;
  });
  await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
  const first = once(socket, 'message', { signal: AbortSignal.timeout(10000) });
  socket.send(JSON.stringify({ grant: grant.grant }));
  await first;
}
async function sample() {
  await guard();
  await Promise.all(leases.map(async lease => {
    const before = Date.now();
    const current = store.get(lease.id);
    await service.action(lease.id, lease, `scroll-${cycles}`, current.revision, { type: 'scroll', x: 0, y: cycles % 2 ? 500 : -500 });
    const snapshot = JSON.stringify(await service.snapshot(lease.id, lease, false));
    assert.match(snapshot, lease.url.includes('github.com') ? /GitHub/i : /agentic-browser-acceptance/);
    operationMs.push(Date.now() - before);
  }));
  const before = Date.now();
  const health = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200, 'Isolated data server health probe failed');
  await health.arrayBuffer();
  healthMs.push(Date.now() - before);
  for (const viewer of viewers) assert.ok(Date.now() - viewer.lastFrameAt < 10000, 'Viewer has stopped receiving frames');
  cycles++;
}
try {
  await engine.initialize();
  instance = (await readFile(join(directory, 'runtimes/instance-id'), 'utf8')).trim();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  guardTimer = setInterval(() => {
    if (monitoring || cleaning) return;
    monitoring = true;
    void guard().catch(() => { stopped ??= 'guard_failed'; }).finally(() => { monitoring = false; });
  }, 1000).unref();
  for (let i = 0; i < capacity; i++) {
    await guard();
    const lease = service.acquire({ userId: `soak-${i}`, conversationId: `soak-chat-${i}`, taskId: `soak-task-${i}` },
      { acquisitionId: `open-${i}`, purpose: 'Isolated sustained capacity acceptance', url: i % 2 ? 'https://github.com/' : 'https://httpbin.org/anything/agentic-browser-acceptance' });
    leases.push(lease);
    await observe(await active(lease));
    console.log(JSON.stringify({ stage, activeBrowsers: leases.length, targetCapacity: capacity }));
  }
  assert.equal(store.capacity().occupied, capacity);
  checks.push('real_browsers_at_capacity_and_authenticated_observe_streams');
  stage = 'sustained_load';
  const holdStart = Date.now();
  for (const viewer of viewers) { viewer.frames = 0; viewer.lastFrameAt = holdStart; viewer.gaps = []; }
  let nextLogAt = holdStart;
  while (Date.now() - holdStart < holdSeconds * 1000) {
    await sample();
    heldMs = Date.now() - holdStart;
    if (Date.now() >= nextLogAt) {
      console.log(JSON.stringify({ stage, heldSeconds: Math.round(heldMs / 1000), cycles, minimumAvailableMiB: Math.round(minimumAvailableMiB), operationP95Ms: p95(operationMs) }));
      nextLogAt = Date.now() + 30000;
    }
    for (let wait = 0; wait < 5 && Date.now() - holdStart < holdSeconds * 1000; wait++) { await delay(1000); await guard(); }
  }
  heldMs = Date.now() - holdStart;
  assert.ok(p95(operationMs) < 3000, 'Scroll/snapshot p95 exceeds 3 seconds');
  assert.ok(p95(healthMs) < 1000, 'Data server health latency p95 exceeds 1 second');
  for (const viewer of viewers) {
    assert.ok(viewer.frames >= Math.floor(heldMs / 3000), 'Insufficient sustained frames');
    assert.ok(p95(viewer.gaps) < 3000, 'Frame interval p95 exceeds 3 seconds');
  }
  checks.push('sustained_jpeg_scroll_snapshot_and_health_budgets');

  stage = 'queue_and_handoff';
  const owner = leases[0];
  const waiting = service.acquire({ userId: `soak-${capacity}`, conversationId: `soak-chat-${capacity}`, taskId: `soak-task-${capacity}` },
    { acquisitionId: `open-${capacity}`, purpose: 'Queue after sustained load', url: 'https://httpbin.org/anything/agentic-browser-acceptance' });
  assert.equal(waiting.position, 1);
  assert.equal(waiting.state, 'queued');
  viewers[0].expectedClose = true;
  const revoked = once(viewers[0].socket, 'close', { signal: AbortSignal.timeout(10000) });
  await service.release(owner.id, owner, 'completed');
  assert.equal((await revoked)[0], 1008);
  const admitted = await active(waiting);
  assert.equal(store.capacity().occupied, capacity);
  await service.control(admitted.id, admitted, 'agent', 'handoff', 0, 'human', 'Capacity acceptance');
  await assert.rejects(service.snapshot(admitted.id, admitted, false));
  const desktop = await service.desktop(admitted.id, admitted, 1);
  desktop.destroy();
  await service.control(admitted.id, admitted, 'human', 'return', 1, 'agent', 'Done');
  assert.equal(store.get(admitted.id).sessionId, admitted.sessionId);
  assert.match(JSON.stringify(await service.snapshot(admitted.id, admitted, false)), /agentic-browser-acceptance/);
  checks.push('overflow_task_queues_and_resumes_after_cleanup', 'revocation_and_same_session_handoff_after_load');
  await guard();
} catch (error) {
  failure = stopped ?? (error instanceof assert.AssertionError ? error.message : `acceptance_failed_during_${stage}`);
  process.exitCode = 1;
} finally {
  cleaning = true;
  clearInterval(guardTimer);
  for (const viewer of viewers) viewer.socket.terminate();
  server.closeViewers();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  try {
    await service.close();
    const remaining = instance ? (await exec('docker', ['ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${instance}`], { timeout: 15000 })).stdout.trim().split('\n').filter(Boolean).length : 0;
    const saved = new DatabaseSync(join(directory, 'scheduler.sqlite'), { readOnly: true });
    const live = Number(saved.prepare("SELECT COUNT(*) AS n FROM leases WHERE state IN ('queued','starting','active','closing','cleanup_pending')").get()!.n);
    saved.close();
    cleanup = { passed: remaining === 0 && live === 0, remainingContainers: remaining, liveLeases: live };
  } catch { cleanup = { passed: false }; }
  if (!cleanup.passed) process.exitCode = 1;
  const report = { passed: !failure && cleanup.passed, startedAt, completedAt: new Date().toISOString(), image, directory,
    holdSecondsRequested: holdSeconds, heldSeconds: Math.round(heldMs / 1000), capacity,
    eligibleForTenSlots: capacity === 10 && !failure && cleanup.passed && heldMs >= 300000,
    workload: { exampleBrowsers: Math.ceil(capacity / 2), githubPublicBrowsers: Math.floor(capacity / 2), authenticatedJpegViewers: capacity, cycles },
    operationP95Ms: operationMs.length ? p95(operationMs) : null, healthP95Ms: healthMs.length ? p95(healthMs) : null,
    minimumAvailableMiB: Number.isFinite(minimumAvailableMiB) ? Math.round(minimumAvailableMiB) : null,
    viewers: viewers.map(viewer => ({ frames: viewer.frames, intervalP95Ms: viewer.gaps.length ? p95(viewer.gaps) : null })),
    checks, failure, cleanup, scope: 'Isolated Chrome and data server with public pages. No LLM, real accounts or private repositories; not a guarantee for arbitrary sites or day-long traffic.' };
  await mkdir(join(root, 'output/agent'), { recursive: true });
  await writeFile(join(root, `output/agent/browser-soak-${capacity}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
