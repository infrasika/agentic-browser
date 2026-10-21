import { buildInfo } from "./service-status.js";
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { readConfig } from './config.js';

const execFile = promisify(execFileCallback);
console.log(`Controller ${buildInfo.version} (${buildInfo.revision})`);
const remedies: Record<string, string> = {
  Configuration: 'Check mode, public URL, initial username/password and documented ranges in .env.',
  Docker: 'Start Docker and check the controller socket mount and supplementary socket group.',
  'Local runtime image': 'Pull the pinned runtime image and confirm it matches the native host architecture.',
  'Private data volume': 'Check the workspace volume exists and Docker Engine is 26+.',
  'Local configuration permissions': 'Restrict the configuration file to its owner: chmod 600 .env.',
  Platform: 'Use a non-root Linux amd64/arm64 controller; Docker Desktop supplies Linux on Mac.',
};
let failures = 0;
async function check(name: string, operation: () => Promise<string> | string) {
  try { console.log(`PASS ${name}: ${await operation()}`); }
  catch { failures++; console.log(`FAIL ${name}: ${remedies[name] ?? "Check the configuration and dependencies."} Raw errors and credentials are omitted.`); }
}
if (existsSync('.env')) process.loadEnvFile('.env');
await check('Node', () => { if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(); return process.versions.node; });
let config: ReturnType<typeof readConfig> | undefined;
await check('Configuration', () => { config = readConfig(); return `${config.authMode} / ${config.browserMode} / network=${config.runtimeNetwork}`; });
if (existsSync('.env')) await check('Local configuration permissions', async () => {
  if ((await stat('.env')).mode & 0o077) throw new Error(); return 'Readable and writable only by the current user';
});
if (config?.browserMode === 'docker') {
  await check('Platform', () => { if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.getuid?.() === 0) throw new Error(); return `Linux ${process.arch}, non-root controller; browser ${config!.runtimePlatform}`; });
  await check('flock', async () => { await execFile('flock', ['--version']); return 'Available'; });
  await check('Docker', async () => {
    const { stdout } = await execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10000 });
    if (!/^\d+\.\d+/.test(stdout)) throw new Error(); return stdout.trim();
  });
  await check('Local runtime image', async () => {
    const nativePlatform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    const platform = config!.runtimePlatform === nativePlatform ? [] : ['--platform', config!.runtimePlatform];
    const { stdout } = await execFile('docker', ['image', 'inspect', ...platform, config!.runtimeImage, '--format', '{{.Id}} {{.Os}}/{{.Architecture}} {{.Config.User}}'], { timeout: 10000 });
    if (!/^sha256:[a-f0-9]{64} linux\/(amd64|arm64) node\s*$/.test(stdout) || !stdout.includes(` ${config!.runtimePlatform} `)) throw new Error(); return stdout.trim();
  });
  if (config.runtimeVolume) await check('Private data volume', async () => {
    const { stdout } = await execFile('docker', ['version', '--format', '{{.Server.APIVersion}}'], { timeout: 10000 });
    const version = stdout.trim().split('.').map(Number);
    if (version[0] !== 1 || !Number.isInteger(version[1]) || version[1] < 45) throw new Error();
    await execFile('docker', ['volume', 'inspect', config!.runtimeVolume!.name, '--format', '{{.Name}}'], { timeout: 10000 });
    return 'Volume exists; Docker supports scoped profile and proxy subdirectory mounts';
  });
  await check('Extension lock and sandbox configuration', async () => {
    const lock = JSON.parse(await readFile('runtime/assets.lock.json', 'utf8'));
    JSON.parse(await readFile('runtime/chrome-seccomp.json', 'utf8'));
    if (!Array.isArray(lock.extensions) || lock.extensions.length !== 2) throw new Error();
    return 'Both extension pins and the seccomp configuration exist; session startup verifies that extensions are enabled';
  });
}
console.log('This check does not create sessions, read website login data, or change the running service. See docs/SELF_HOST.md for browser validation.');
process.exitCode = failures ? 1 : 0;
