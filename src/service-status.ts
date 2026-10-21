import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import type { readConfig } from './config.js';

const execFile = promisify(execFileCallback);
export const buildInfo = (() => {
  try {
    const data = JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8'));
    if (typeof data.version === 'string' && typeof data.revision === 'string')
      return { version: data.version, revision: data.revision };
  } catch { /* Source runs have no image build receipt. */ }
  return { version: 'development', revision: 'unknown' };
})();

type Check = { state: 'ready' | 'unavailable' | 'not_checked'; message: string };
export type RuntimeStatus = {
  browserMode: string;
  platform: string;
  docker: Check;
  runtime: Check;
  storage: { state: 'ready' | 'low' | 'unavailable'; freeMiB?: number; message: string };
  checkedAt: string;
};
export type StatusReader = () => Promise<RuntimeStatus>;

// Bounded, read-only probes. Never return raw Docker errors, paths or environment.
export function createStatusReader(config: Pick<ReturnType<typeof readConfig>, 'browserMode' | 'runtimePlatform' | 'runtimeImage' | 'dataDirectory'>,
  probes = {
    run: async (args: string[]) => (await execFile('docker', args, { timeout: 4000, maxBuffer: 65536 })).stdout.trim(),
    freeMiB: async () => { const fs = await statfs(config.dataDirectory); return Math.floor(fs.bavail * fs.bsize / 1048576); },
  }): StatusReader {
  let pending: Promise<RuntimeStatus> | undefined;
  let expires = 0;
  return () => {
    if (pending && Date.now() < expires) return pending;
    expires = Date.now() + 15000;
    pending = (async () => {
      const status: RuntimeStatus = { browserMode: config.browserMode, platform: config.runtimePlatform,
        docker: { state: 'not_checked', message: 'Docker is not used in this browser mode.' },
        runtime: { state: 'not_checked', message: 'Open a session to check browser startup.' },
        storage: { state: 'unavailable', message: 'Cannot read workspace free space. Check the data volume and run doctor.' },
        checkedAt: new Date().toISOString() };
      await Promise.all([
        (async () => {
          if (config.browserMode !== 'docker') return;
          try {
            await probes.run(['version', '--format', '{{.Server.Version}}']);
            status.docker = { state: 'ready', message: 'Docker daemon reachable.' };
          } catch {
            status.docker = { state: 'unavailable', message: 'Docker is unreachable. Start Docker and check the controller socket mount/group.' };
            status.runtime = { state: 'not_checked', message: 'Restore Docker access before checking the runtime image.' };
            return;
          }
          try {
            const actual = await probes.run(['image', 'inspect', config.runtimeImage, '--format', '{{.Os}}/{{.Architecture}} {{.Config.User}}']);
            if (actual !== `${config.runtimePlatform} node`) throw new Error('Incompatible image');
            status.runtime = { state: 'ready', message: 'Native runtime image available. A new session still needs to start Chrome successfully.' };
          } catch {
            status.runtime = { state: 'unavailable', message: 'Runtime image missing or incompatible. Pull the pinned runtime image for this host and run doctor.' };
          }
        })(),
        (async () => {
          try {
            const freeMiB = await probes.freeMiB();
            status.storage = { state: freeMiB < 1024 ? 'low' : 'ready', freeMiB,
              message: freeMiB < 1024 ? 'Less than 1 GiB free on the workspace filesystem. Free space before opening more browsers.' : 'Workspace filesystem space available.' };
          } catch { /* Keep the safe, actionable unavailable message. */ }
        })(),
      ]);
      return status;
    })();
    return pending;
  };
}
