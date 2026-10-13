import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { readConfig } from './config.js';

const execFile = promisify(execFileCallback);
let failures = 0;
async function check(name: string, operation: () => Promise<string> | string) {
  try { console.log(`PASS ${name}: ${await operation()}`); }
  catch { failures++; console.log(`FAIL ${name}: 检查配置或依赖；未输出原始错误及凭据。`); }
}
if (existsSync('.env')) process.loadEnvFile('.env');
await check('Node', () => { if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(); return process.versions.node; });
let config: ReturnType<typeof readConfig> | undefined;
await check('配置', () => { config = readConfig(); return `${config.authMode} / ${config.browserMode} / network=${config.runtimeNetwork}`; });
if (existsSync('.env')) await check('本地配置权限', async () => {
  if ((await stat('.env')).mode & 0o077) throw new Error(); return '仅当前用户可读写';
});
if (config?.browserMode === 'docker') {
  await check('平台', () => { if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.getuid?.() === 0) throw new Error(); return `Linux ${process.arch}，非 root 控制服务；浏览器固定 amd64`; });
  await check('flock', async () => { await execFile('flock', ['--version']); return '可用'; });
  await check('Docker', async () => {
    const { stdout } = await execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10000 });
    if (!/^\d+\.\d+/.test(stdout)) throw new Error(); return stdout.trim();
  });
  await check('本地运行镜像', async () => {
    const platform = process.arch === 'arm64' ? ['--platform', 'linux/amd64'] : [];
    const { stdout } = await execFile('docker', ['image', 'inspect', ...platform, config!.runtimeImage, '--format', '{{.Id}} {{.Os}}/{{.Architecture}} {{.Config.User}}'], { timeout: 10000 });
    if (!/^sha256:[a-f0-9]{64} linux\/amd64 node\s*$/.test(stdout)) throw new Error(); return stdout.trim();
  });
  if (config.runtimeVolume) await check('私有数据卷', async () => {
    const { stdout } = await execFile('docker', ['version', '--format', '{{.Server.APIVersion}}'], { timeout: 10000 });
    const version = stdout.trim().split('.').map(Number);
    if (version[0] !== 1 || !Number.isInteger(version[1]) || version[1] < 45) throw new Error();
    await execFile('docker', ['volume', 'inspect', config!.runtimeVolume!.name, '--format', '{{.Name}}'], { timeout: 10000 });
    return '卷存在；Docker 支持仅挂载 Profile/代理子目录';
  });
  await check('扩展锁文件与沙箱配置', async () => {
    const lock = JSON.parse(await readFile('runtime/assets.lock.json', 'utf8'));
    JSON.parse(await readFile('runtime/chrome-seccomp.json', 'utf8'));
    if (!Array.isArray(lock.extensions) || lock.extensions.length !== 2) throw new Error();
    return '两项固定扩展及 seccomp 配置存在；实际启用状态由每次 Session 启动检查';
  });
}
console.log('检查不会创建会话、读取网站登录数据或修改正在运行的服务。完整浏览器验收见 docs/SELF_HOST.md。');
process.exitCode = failures ? 1 : 0;
