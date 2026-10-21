import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
test('standalone setup produces native Compose files, detects Linux/Mac socket groups and preserves existing settings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ab-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec('python3', ['scripts/package-self-host.py', '--output', root]);
  const installer = join(root, 'install.sh');
  await exec('bash', ['-n', installer]);
  const source = await readFile(installer, 'utf8');
  assert.doesNotMatch(source, /@@[A-Z_]+@@/);
  const bin = join(root, 'bin'); await mkdir(bin);
  const calls = join(root, 'docker-calls');
  await writeFile(join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify(args)+'\\n');
if(args[0]==='version') console.log(process.env.TEST_API || '1.45');
else if(args[0]==='compose' && args[1]==='version') console.log(process.env.TEST_COMPOSE || '2.24.4');
else if(args[0]==='context') console.log(process.env.TEST_ENDPOINT || 'unix:///var/run/docker.sock');
else if(args[0]==='image' && args[1]==='inspect') console.log(args[2].split(':')[0]+'@sha256:'+('a'.repeat(64)));
else if(args[0]==='run') console.log(process.env.TEST_GID || '987');
`, { mode: 0o755 });
  await writeFile(join(bin, 'uname'), '#!/bin/sh\nprintf "%s\\n" "${TEST_OS:-Linux}"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_CALLS: calls, DOCKER_CONTEXT: '', DOCKER_HOST: '' };
  const run = (target: string, extra = {}) => exec('bash', [installer, target], { env: { ...env, ...extra }, cwd: root });
  for (const [platform, endpoint, socket, gid] of [
    ['Linux', 'unix:///run/my socket.sock', '/run/my socket.sock', '987'],
    ['Darwin', 'unix:///Users/test/.docker/run/docker.sock', '/var/run/docker.sock', '654'],
  ]) {
    const target = join(root, platform + ' installation');
    await writeFile(calls, '');
    await run(target, { TEST_OS: platform, TEST_ENDPOINT: endpoint, TEST_GID: gid });
    assert.deepEqual((await readdir(target)).sort(), ['.env', 'compose.yaml']);
    assert.equal((await stat(join(target, '.env'))).mode & 0o777, 0o600);
    const settings = await readFile(join(target, '.env'), 'utf8');
    assert.ok(settings.includes(`AB_DOCKER_SOCKET='${socket}'\nAB_DOCKER_GID=${gid}`));
    const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    const pulls = commands.filter(a => a[0] === 'pull');
    assert.equal(pulls.length, 2);
    for (const pull of pulls) assert.match(pull[1], /^ghcr\.io\/infrasika\/agentic-browser-(controller|runtime)@sha256:[a-f0-9]{64}$/);
    const probes = commands.filter(a => a[0] === 'run');
    assert.equal(probes.length, 1);
    assert.ok(probes[0].includes(pulls[0][1]), 'Only the controller receives the socket');
    assert.ok(probes[0].includes(`type=bind,src=${socket},dst=/var/run/docker.sock`));
    assert.ok(probes[0].includes('1000:1000') && probes[0].includes('--read-only'));
    const actualEnv = { ...process.env };
    for (const key of Object.keys(actualEnv)) if (key.startsWith('AB_') || key.startsWith('COMPOSE_')) delete actualEnv[key];
    const rendered = JSON.parse((await exec('docker', ['compose', '--project-directory', target, 'config', '--format', 'json'], { env: actualEnv })).stdout);
    const controller = rendered.services.controller;
    assert.deepEqual(Object.keys(rendered.services), ['controller']);
    assert.equal(controller.image, pulls[0][1]);
    assert.equal(controller.environment.BROWSER_RUNTIME_IMAGE, pulls[1][1]);
    assert.equal(controller.user, '1000:1000');
    assert.deepEqual(controller.group_add, [gid]);
    assert.equal(controller.volumes.find((v: any) => v.target === '/var/run/docker.sock').source, socket);
    assert.equal(controller.ports[0].host_ip, '127.0.0.1');
    assert.ok(controller.read_only);
    assert.match(source, /does not start services/);
    await writeFile(calls, '');
    await assert.rejects(run(target), /existing settings are never overwritten/);
    assert.equal(await readFile(calls, 'utf8'), '', 'Refusal happens before any Docker command');
    assert.equal(await readFile(join(target, '.env'), 'utf8'), settings);
  }
  // An image-embedded kit starts from an immutable version, then writes only digests.
  await exec('python3', ['scripts/package-self-host.py', '--output', root, '--version', 'v0.1.0-preview.5']);
  const releaseTarget = join(root, 'release-image-kit');
  await run(releaseTarget);
  const releaseCompose = await readFile(join(releaseTarget, 'compose.yaml'), 'utf8');
  assert.ok(releaseCompose.includes(`ghcr.io/infrasika/agentic-browser-controller@sha256:${'a'.repeat(64)}`));
  assert.ok(releaseCompose.includes(`ghcr.io/infrasika/agentic-browser-runtime@sha256:${'a'.repeat(64)}`));
  assert.ok(!releaseCompose.includes(':v0.1.0-preview.5'));
  await exec('python3', ['scripts/package-self-host.py', '--output', root]);
  for (const [name, options, message] of [
    ['remote', { TEST_ENDPOINT: 'ssh://remote-host' }, /local Docker Unix socket/],
    ['unsafe-path', { TEST_ENDPOINT: 'unix:///run/$socket.sock' }, /Unsupported Docker socket/],
    ['old-engine', { TEST_API: '1.44' }, /Docker Engine 26/],
    ['old-compose', { TEST_COMPOSE: '2.24.3' }, /Docker Compose 2.24.4/],
    ['bad-group', { TEST_GID: 'not-a-number' }, /Could not detect/],
  ] as const) {
    const target = join(root, name);
    await assert.rejects(run(target, options), message);
    await assert.rejects(stat(join(target, '.env')), /ENOENT/);
  }
});
