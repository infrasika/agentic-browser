import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire('/app/package.json');
const Redis = require('ioredis');
const redis = new Redis('redis://redis:6379', { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 0, retryStrategy: () => null });
try {
  await redis.connect();
  let cursor = '0', running = 0, paused = 0, scans = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', '*stream:*', 'COUNT', 1000); cursor = next;
    for (const key of keys) {
      if (key.endsWith(':running')) running += await redis.scard(key);
      if (key.endsWith(':requires_action')) paused += await redis.scard(key);
    }
    if (++scans > 100) throw new Error('Task state limit');
  } while (cursor !== '0');
  let connections = 0;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const rows = (await readFile(file, 'utf8')).trim().split('\n').slice(1);
    connections += rows.filter(row => { const fields = row.trim().split(/\s+/); return fields[1].endsWith(':0C08') && fields[3] === '01'; }).length;
  }
  console.log(JSON.stringify({ idle: running === 0 && paused === 0, running, paused, connections }));
} catch { console.error('Unable to confirm idle state.'); process.exitCode = 1; }
finally { redis.disconnect(); }
