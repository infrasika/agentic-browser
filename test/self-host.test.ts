import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorkspace, startService } from './helpers.js';

const exec = promisify(execFile);
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

test('public self-host download is reproducible, pinned, source-free, and available without credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentic-self-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await exec('python3', ['scripts/package-self-host.py']);
  const service = await startService({ create: async () => fakeWorkspace(), close: async () => {} });
  t.after(() => service.close());
  const installer = await fetch(service.base + '/install.sh');
  assert.equal(installer.status, 200);
  assert.equal(await installer.text(), await readFile('web/self-host-downloads/install.sh', 'utf8'));
  const backupHelper = await fetch(service.base + '/self-host/download/workspace-backup.sh');
  assert.equal(backupHelper.status, 200);
  assert.equal(await backupHelper.text(), await readFile('scripts/workspace-backup.sh', 'utf8'));
  for (const name of ['PUBLIC_DEMO.md', 'SELF_HOST.md', 'ARCHITECTURE.md', 'RELEASING.md']) {
    const guide = await fetch(service.base + '/self-host/download/' + name);
    assert.equal(guide.status, 200);
    assert.equal(await guide.text(), await readFile('docs/' + name, 'utf8'));
  }
  for (const [alias, canonical] of [['AGENT_CLIENT.md', 'ARCHITECTURE.md'], ['STATUS.md', 'RELEASING.md']]) {
    const guide = await fetch(service.base + '/self-host/download/' + alias);
    assert.equal(guide.status, 200);
    const expected = await readFile('docs/' + canonical, 'utf8');
    assert.equal(await guide.text(), expected);
    assert.equal(await readFile('web/self-host-downloads/' + alias, 'utf8'), expected, 'Earlier published controllers can serve consolidated guides');
  }
  const download = '/self-host/download/agentic-browser-self-host.tar.gz';
  const response = await fetch(service.base + download);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
  const archive = Buffer.from(await response.arrayBuffer());
  const checksum = await fetch(service.base + '/self-host/download/SHA256SUMS');
  assert.equal(checksum.status, 200);
  assert.equal(await checksum.text(), `${hash(archive)}  agentic-browser-self-host.tar.gz\n`);
  const archivePath = join(directory, 'setup.tar.gz');
  await writeFile(archivePath, archive);
  const names = (await exec('tar', ['-tzf', archivePath])).stdout.trim().split('\n');
  assert.ok(names.includes('agentic-browser/compose.yaml'));
  assert.ok(names.includes('agentic-browser/scripts/compose.sh'));
  assert.ok(names.includes('agentic-browser/scripts/workspace-backup.sh'));
  assert.ok(names.includes('agentic-browser/deploy/release.env'));
  for (const obsolete of ['docs/STATUS.md', 'docs/AGENT_CLIENT.md', 'runtime/README.md']) {
    assert.ok(!names.includes('agentic-browser/' + obsolete), 'Consolidated documents must not be duplicated in the archive');
  }
  for (const name of names) {
    assert.ok(name.startsWith('agentic-browser/') && !name.split('/').includes('..'));
    assert.doesNotMatch(name, /(?:^|\/)(?:src|test|\.git|\.data|node_modules|output)(?:\/|$)|\.(?:ts|log)$|\/(?:\.env|\.env\.public|\.env\.compose)$/);
  }
  await exec('tar', ['-xzf', archivePath, '-C', directory]);
  const root = join(directory, 'agentic-browser');
  const manifest = JSON.parse(await readFile(join(root, 'SETUP.json'), 'utf8'));
  assert.equal(manifest.kind, 'public-self-host-configuration');
  assert.equal(names.length, Object.keys(manifest.files).length + 1);
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert.equal(hash(await readFile(join(root, name))), digest);
  }
  const pinsPath = join(root, 'deploy/release.env');
  const pins = await readFile(pinsPath, 'utf8');
  assert.equal(pins, await readFile('deploy/release.env', 'utf8'));
  for (const kind of ['controller', 'runtime']) {
    assert.match(manifest.images[kind], /^ghcr\.io\/infrasika\/agentic-browser-(?:controller|runtime)@sha256:[a-f0-9]{64}$/);
    assert.ok(pins.includes(`AB_${kind.toUpperCase()}_IMAGE=${manifest.images[kind]}\n`));
  }
  // Local secrets added beside the allowlisted files cannot enter the archive.
  await writeFile(join(root, '.env'), 'PRIVATE_SENTINEL=do-not-publish\n');
  const output = join(directory, 'rebuilt');
  const build = () => exec('python3', ['scripts/package-self-host.py', '--root', root, '--output', output]);
  await build();
  assert.deepEqual(await readFile(join(output, 'agentic-browser-self-host.tar.gz')), archive);
  await writeFile(pinsPath, pins.replace(/@sha256:[a-f0-9]{64}/, ':latest'));
  await assert.rejects(build(), /immutable GHCR image pins/);
  await writeFile(pinsPath, pins);
  await rm(join(root, 'README.md'));
  await symlink(join(root, '.env'), join(root, 'README.md'));
  await assert.rejects(build(), /unsafe deployment file/);
  for (const path of ['/self-host/download/.env', '/self-host/download/src/main.ts', '/self-host/download/deploy/release.env', '/self-host-downloads/SHA256SUMS']) {
    assert.notEqual((await fetch(service.base + path)).status, 200, path);
  }
});

test('downloaded helpers run image commands and keep remote MCP clients free of server mounts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentic-image-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await exec('python3', ['scripts/package-self-host.py', '--output', directory]);
  await exec('tar', ['-xzf', join(directory, 'agentic-browser-self-host.tar.gz'), '-C', directory]);
  const root = join(directory, 'agentic-browser');
  const manifest = JSON.parse(await readFile(join(root, 'SETUP.json'), 'utf8'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const calls = join(directory, 'docker-calls.jsonl');
  const config = join(directory, 'compose.env');
  await writeFile(config, '');
  const docker = join(bin, 'docker');
  await writeFile(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'context') process.stdout.write('unix:///var/run/docker.sock\\n');
`);
  await chmod(docker, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_CALLS: calls,
    DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CONTEXT: '', AB_DOCKER_GID: '123',
    AB_DOCKER_SOCKET: '/var/run/docker.sock', AB_RELEASE_FILE: join(root, 'deploy/release.env'),
    AB_COMPOSE_ENV_FILE: config, AB_COMPOSE_VARIANT: '',
    AGENT_BROWSER_TOKEN: 'synthetic-credential-must-stay-out-of-arguments',
    AGENT_BROWSER_URL: 'https://workspace.example.test', AGENT_BROWSER_VIEW_URL: 'https://workspace.example.test' };
  const run = async (...args: string[]) => {
    await writeFile(calls, '');
    await exec('bash', [join(root, 'scripts/release-compose.sh'), ...args], { cwd: directory, env });
    return (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  };
  assert.deepEqual(await run('pull-client'), [['pull', manifest.images.controller]]);
  assert.deepEqual(await run('pull'), [['pull', manifest.images.controller], ['pull', manifest.images.runtime]]);
  assert.deepEqual((await run('doctor'))[0].slice(-7), ['exec', '-T', 'controller', 'node', '--import', 'tsx', 'src/doctor.ts']);
  const member = (await run('member', 'create', 'member with spaces'))[0];
  assert.ok(!member.includes('-T'), 'Member setup keeps an interactive password prompt');
  assert.deepEqual(member.slice(-8), ['exec', 'controller', 'node', '--import', 'tsx', 'src/members-cli.ts', 'create', 'member with spaces']);
  const local = (await run('mcp'))[0];
  assert.ok(local.includes('-T'), 'MCP must not use a terminal');
  assert.ok(local.includes('AGENT_BROWSER_TOKEN') && !local.join(' ').includes(env.AGENT_BROWSER_TOKEN));
  const remoteCalls = await run('mcp-remote');
  assert.equal(remoteCalls.length, 1, 'Remote client never probes or uses the server socket');
  const remote = remoteCalls[0];
  assert.equal(remote[0], 'run');
  for (const flag of ['--rm', '-i', '--init', '--read-only']) assert.ok(remote.includes(flag));
  for (const flag of ['--mount', '--volume', '-v', '--privileged', '-t']) assert.ok(!remote.includes(flag));
  assert.ok(!remote.join(' ').includes(env.AGENT_BROWSER_TOKEN));
  assert.deepEqual(remote.slice(-6), ['--entrypoint', 'node', manifest.images.controller, '--import', 'tsx', 'src/mcp.ts']);
  await writeFile(calls, '');
  await assert.rejects(exec('bash', [join(root, 'scripts/release-compose.sh'), 'mcp-remote'], {
    cwd: directory, env: { ...env, AGENT_BROWSER_TOKEN: '' },
  }), /Set your personal Agent credential/);
  assert.equal(await readFile(calls, 'utf8'), '', 'Missing credentials fail before starting Docker');
});
