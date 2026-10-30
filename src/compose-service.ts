import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

// This entrypoint is only used by the standalone Compose distribution. Discover
// the mounted socket group inside Linux, then drop root before loading service code.
try {
  const socket = statSync('/var/run/docker.sock');
  if (!socket.isSocket() || process.getuid?.() !== 0) throw new Error('Root bootstrap and a local Docker socket are required');
  process.setgroups!([socket.gid]);
  process.setgid!(1000);
  process.setuid!(1000);
  const settings = z.object({ origin: z.string().url(), maximum: z.number().int().min(1).max(10) }).strict()
    .parse(JSON.parse(readFileSync('/service-config/settings.json', 'utf8')));
  Object.assign(process.env, {
    BROWSER_SERVICE_TOKEN_FILE: '/service-config/browser_token',
    DOMAIN_CLIENT: settings.origin, BROWSER_MAX_SESSIONS: String(settings.maximum),
  });
} catch {
  console.error('Browser initialization failed: check configuration volume and local Docker socket.');
  process.exit(1);
}
await import('./service.js');
