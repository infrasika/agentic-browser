import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerEngine } from '../src/docker-runtime.js';
import { SchedulerStore } from '../src/scheduling/store.js';
import { BrowserService } from '../src/scheduling/service.js';
import { ServiceError } from '../src/contracts.js';

const directory = await mkdtemp(join(tmpdir(), 'librechat-browser-accept-'));
const runtimeImage = process.env.BROWSER_RUNTIME_IMAGE;
if (!runtimeImage) throw new Error('Set BROWSER_RUNTIME_IMAGE to an installed, pinned runtime image');
const engine = new DockerEngine({ dataDirectory: directory, image: runtimeImage, network: 'public' });
await engine.initialize();
const store = new SchedulerStore(join(directory, 'scheduler.sqlite'), 1);
const service = new BrowserService(store, engine, { ttlMs: 120000, maxLifetimeMs: 180000, queueTtlMs: 120000, maxQueued: 10 });
const checks: string[] = [];
const first = { userId: '507f1f77bcf86cd799439011', conversationId: 'accept-one', taskId: 'generation-one' };
const second = { userId: '507f1f77bcf86cd799439012', conversationId: 'accept-two', taskId: 'generation-two' };
async function active(id: string) {
  for (let i = 0; i < 180; i++) {
    const lease = store.get(id);
    if (lease.state === 'active') return lease;
    if (lease.state === 'failed') throw new Error('Runtime startup failed');
    await delay(500);
  }
  throw new Error('Runtime startup deadline exceeded');
}
const startedAt = new Date().toISOString();
let passed = false;
try {
  const lease = service.acquire(first, { acquisitionId: 'open-one', purpose: 'Real Docker acceptance', url: 'https://example.com' });
  const queued = service.acquire(second, { acquisitionId: 'open-two', purpose: 'FIFO acceptance', url: 'https://example.com' });
  assert.equal(store.get(queued.id).state, 'queued');
  await active(lease.id);
  const snapshot = await service.snapshot(lease.id, first, false);
  assert.match(JSON.stringify(snapshot), /Example Domain/);
  checks.push('real_chrome_navigation_and_snapshot');
  const frame = await service.frame(lease.id, first, 0);
  assert.ok(frame.length > 1000);
  checks.push('real_jpeg_observation');
  await service.control(lease.id, first, 'agent', 'handoff-one', 0, 'human', 'Confirm demo');
  await assert.rejects(service.snapshot(lease.id, first, false), error => error instanceof ServiceError && error.status === 409);
  const desktop = await service.desktop(lease.id, first, 1);
  desktop.destroy();
  checks.push('human_desktop_and_agent_observation_denied');
  await service.control(lease.id, first, 'human', 'return-one', 1, 'agent', 'Done');
  assert.match(JSON.stringify(await service.snapshot(lease.id, first, false)), /Example Domain/);
  checks.push('same_page_survives_control_return');
  await service.release(lease.id, first, 'completed');
  await active(queued.id);
  assert.equal(store.get(lease.id).state, 'completed');
  assert.equal(store.capacity().occupied, 1);
  checks.push('fifo_admitted_after_confirmed_cleanup');
  await service.release(queued.id, second);
  assert.equal(store.capacity().occupied, 0);
  checks.push('all_runtime_capacity_reclaimed');
  passed = true;
} finally {
  await service.close();
  const output = resolve('output/librechat');
  await mkdir(output, { recursive: true });
  const report = { startedAt, completedAt: new Date().toISOString(), passed, runtimeImage, checks,
    scope: 'Two real Docker browsers, sequentially admitted at capacity 1. Not a 10-browser load test.' };
  await writeFile(join(output, 'browser-service-real.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
