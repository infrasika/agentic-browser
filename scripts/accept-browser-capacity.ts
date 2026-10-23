import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerEngine } from '../src/docker-runtime.js';
import { SchedulerStore } from '../src/scheduling/store.js';
import { BrowserService } from '../src/scheduling/service.js';

const image = process.env.BROWSER_RUNTIME_IMAGE;
if (!image) throw new Error('Set BROWSER_RUNTIME_IMAGE');
const directory = await mkdtemp(join(tmpdir(), 'browser-capacity-'));
const engine = new DockerEngine({ dataDirectory: directory, image, network: 'public' });
await engine.initialize();
const store = new SchedulerStore(join(directory, 'scheduler.sqlite'), 10);
const service = new BrowserService(store, engine, { ttlMs: 600000, maxLifetimeMs: 600000, queueTtlMs: 600000, maxQueued: 25 });
const available = async () => Number(/MemAvailable:\s+(\d+)/.exec(await readFile('/proc/meminfo', 'utf8'))?.[1] ?? 0) / 1024;
const stages: unknown[] = [];
const leases: ReturnType<typeof service.acquire>[] = [];
let failure: string | undefined;
let recommendedMax = 0;
const startedAt = new Date().toISOString();
try {
  for (const count of [1, 5, 10]) {
    const started = Date.now();
    while (leases.length < count) {
      if (await available() < 3072) throw new Error('memory_reserve_3_gib');
      const n = leases.length;
      const lease = service.acquire({ userId: `capacity-user-${n}`, conversationId: `capacity-chat-${n}`, taskId: `capacity-task-${n}` },
        { acquisitionId: `open-${n}`, purpose: 'Isolated capacity acceptance', url: 'https://example.com' });
      leases.push(lease);
      for (let attempts = 0; store.get(lease.id).state !== 'active'; attempts++) {
        if (attempts >= 120 || store.get(lease.id).state === 'failed') throw new Error('startup_deadline');
        if (await available() < 2048) throw new Error('memory_reserve_2_gib');
        await delay(500);
      }
    }
    const latencies: number[] = [];
    // Three rounds exercise every browser, rather than counting idle containers.
    for (let round = 0; round < 3; round++) {
      await Promise.all(leases.map(async lease => {
        const before = Date.now();
        const snapshot = await service.snapshot(lease.id, lease, false);
        assert.match(JSON.stringify(snapshot), /Example Domain/);
        assert.ok((await service.frame(lease.id, lease, 0)).length > 1000);
        latencies.push(Date.now() - before);
      }));
      await delay(2000);
    }
    latencies.sort((a, b) => a - b);
    const p95Ms = latencies[Math.ceil(latencies.length * 0.95) - 1];
    const availableMiB = Math.round(await available());
    const passed = p95Ms < 10000 && availableMiB >= 3072;
    const result = { count, passed, elapsedMs: Date.now() - started, p95SnapshotAndFrameMs: p95Ms, availableMiB };
    stages.push(result); console.log(JSON.stringify(result));
    if (!passed) throw new Error('latency_or_memory_budget');
    recommendedMax = count;
  }
  const waiting = service.acquire({ userId: 'capacity-user-11', conversationId: 'capacity-chat-11', taskId: 'capacity-task-11' },
    { acquisitionId: 'open-11', purpose: 'Queue overflow acceptance', url: 'https://example.com' });
  assert.equal(waiting.state, 'queued');
  await service.release(waiting.id, waiting);
  assert.equal(store.capacity().occupied, 10);
} catch (error) {
  failure = error instanceof Error ? error.message : 'capacity_failed';
} finally {
  await service.close();
  await mkdir('output/librechat', { recursive: true });
  const report = { startedAt, completedAt: new Date().toISOString(), image, stages, recommendedMax, failure,
    scope: 'Short synthetic example.com workload, real isolated Chrome containers; not sustained load or a guarantee for arbitrary sites.' };
  await writeFile('output/librechat/browser-capacity.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ recommendedMax, failure, cleanup: 'complete' }));
}
