import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, '.deployment/librechat');
const values = parseEnv(await readFile(resolve(directory, 'private.env'), 'utf8'));
if (!/^sha256:[a-f0-9]{64}$/.test(values.BROWSER_RUNTIME_IMAGE ?? '')) throw new Error('Set BROWSER_RUNTIME_IMAGE to the verified local image ID');
const maximum = Number(values.BROWSER_MAX_SESSIONS ?? 5);
if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10) throw new Error('Invalid browser capacity');
const path = `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const common = `User=ubuntu\nGroup=ubuntu\nWorkingDirectory=${root}\nEnvironment="PATH=${path}"\nUMask=0077\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=90\nKillSignal=SIGTERM\nKillMode=mixed\n`;
const browser = `[Unit]\nDescription=Private Browser Service for LibreChat Demo\nAfter=docker.service network-online.target\nRequires=docker.service\n\n[Service]\n${common}Environment="BROWSER_RUNTIME_IMAGE=${values.BROWSER_RUNTIME_IMAGE}"\nEnvironment="BROWSER_MAX_SESSIONS=${maximum}"\nExecStart=${process.execPath} --import tsx src/service.ts\n\n[Install]\nWantedBy=multi-user.target\n`;
const agent = `[Unit]\nDescription=LibreChat Browser Demo\nAfter=network-online.target docker.service agentic-browser-service.service\nWants=agentic-browser-service.service\n\n[Service]\n${common}ExecStart=${process.execPath} scripts/run-librechat.mjs serve\n\n[Install]\nWantedBy=multi-user.target\n`;
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(resolve(directory, 'agentic-browser-service.service'), browser, { mode: 0o600 });
await writeFile(resolve(directory, 'librechat-browser-demo.service'), agent, { mode: 0o600 });
console.log(JSON.stringify({ rendered: true, maximum, node: process.version, installed: false }));
