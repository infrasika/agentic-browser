import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Read-only admission check. Only aggregate counts leave this process.
const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, '../librechat-agent/package.json'));
const Redis = require('ioredis');
const values = parseEnv(await readFile(resolve(root, '.deployment/librechat/production.env'), 'utf8'));
if (values.REDIS_URI !== 'redis://127.0.0.1:6381') throw new Error('Unexpected deployment');
const redis = new Redis(values.REDIS_URI, { lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: 0, retryStrategy: () => null });
try {
  await redis.connect();
  let cursor = '0', running = 0, paused = 0, scans = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', '*stream:*', 'COUNT', 1000);
    cursor = next;
    for (const key of keys) {
      if (key.endsWith(':running')) running += await redis.scard(key);
      if (key.endsWith(':requires_action')) paused += await redis.scard(key);
    }
    if (++scans > 100) throw new Error('Task state too large');
  } while (cursor !== '0');
  console.log(JSON.stringify({ idle: running === 0 && paused === 0, running, paused }));
} catch {
  console.error('Cannot verify task idleness. No private diagnostics were emitted.');
  process.exitCode = 2;
} finally { redis.disconnect(); }
