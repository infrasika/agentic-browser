#!/usr/bin/env node
// Maintainer harness: the deployed directory contains only Compose and user
// configuration; every startup/initialization command executes inside containers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeCompose } from '../../scripts/build/package-compose.mjs';
import { run, sleep } from '../../deploy/agent/lib/system.mjs';
import { generationPending } from './verify-bundle.mjs';
const root = path.resolve(import.meta.dirname, '../..');
export async function waitForGateway(base, { fetcher = fetch, pause = sleep, attempts = 60 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(base + '/api/config', { signal: AbortSignal.timeout(3000) });
      if (response.status === 200) return await response.json();
      await response.arrayBuffer();
      if (![502, 503].includes(response.status)) throw new Error('Unexpected gateway readiness status: ' + response.status);
    } catch (error) {
      if (!['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code) && error.name !== 'TimeoutError') throw error;
    }
    if (attempt + 1 < attempts) await pause(1000);
  }
  throw new Error('Gateway did not become ready within the startup deadline');
}
export function redactDiagnostics(text, values) {
  for (const value of values.filter(value => typeof value === 'string' && value.length >= 4).sort((a, b) => b.length - a.length)) text = text.replaceAll(value, '[REDACTED]');
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
}
export async function verifyCompose({ release, work, port = 3350, development = false }) {
  const project = 'compose-test-' + randomUUID().slice(0, 12);
  const report = { passed: false, checks: [], hostPlatform: process.platform, architecture: process.arch, version: release.version, images: release.images, callsPaidModel: false, hostDeploymentTools: ['Docker', 'Docker Compose'], stage: 'prepare' };
  writeCompose(release, work, { development });
  const deployment = path.resolve(work), base = 'http://127.0.0.1:' + port;
  const tools = path.join(deployment, 'host-tools'); fs.mkdirSync(tools);
  fs.symlinkSync(await run(['which', 'docker']), path.join(tools, 'docker'));
  const env = { ...process.env, COMPOSE_PROJECT_NAME: project, AGENT_PORT: String(port), PATH: tools };
  report.hostNodeOnDeploymentPath = false;
  // Only the fixture adds a file beyond the public deployment files.
  fs.copyFileSync(path.join(root, 'test/acceptance/fixtures/model-fixture.mjs'), path.join(deployment, 'model-fixture.mjs'));
  fs.chmodSync(path.join(deployment, 'model-fixture.mjs'), 0o644);
  fs.writeFileSync(path.join(deployment, 'compose.override.yaml'), JSON.stringify({ services: { fixture: {
    image: release.images.agent, entrypoint: ['node', '/fixture.mjs'], user: '1000:1000', read_only: true,
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], networks: ['front'],
    volumes: [{ type: 'bind', source: './model-fixture.mjs', target: '/fixture.mjs', read_only: true }],
  } } }));
  const compose = async (...args) => {
    const fd = fs.openSync(path.join(deployment, 'private-compose.log'), 'a', 0o600);
    try { return await run(['docker', 'compose', ...args], { cwd: deployment, env, stderr: fd, timeout: 360_000, maxBuffer: 4 * 1024 * 1024 }); }
    finally { fs.closeSync(fd); }
  };
  let identity;
  const request = async (route, { token, body, expected = 200 } = {}) => {
    const res = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { origin: base, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-librechat-generation-protocol': '2', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const raw = await res.text();
    if (body === undefined && generationPending(route, res, raw)) return { active: true };
    assert.equal(res.status, expected, report.stage + ': ' + route);
    return raw && expected === 200 ? JSON.parse(raw) : null;
  };
  const password = 'Synthetic-Compose-Password-2026!';
  const login = async () => (await request('/api/auth/login', { body: { email: 'compose-admin@example.test', password } })).token;
  const configurationHash = () => compose('exec', '-T', 'agent', 'node', '-e', "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/config/identity.json')).digest('hex'))");
  const settingsFile = path.join(deployment, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile));
  Object.assign(settings, { adminEmail: 'compose-admin@example.test', origin: base, model: { name: 'selfhost-fixture', baseURL: 'http://fixture:9000/v1', promptRate: 1, completionRate: 1 } });
  try {
    const docker = JSON.parse(await run(['docker', 'info', '--format', '{{json .}}']));
    report.docker = { os: docker.OSType, architecture: docker.Architecture, version: docker.ServerVersion };
    assert.equal(docker.OSType, 'linux');
    assert.equal(({ aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' })[docker.Architecture], process.arch);
    console.log('Compose acceptance: reject unconfigured templates');
    await assert.rejects(compose('up', '-d'));
    report.checks.push('unconfigured_templates_block_startup');
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    fs.writeFileSync(path.join(deployment, 'secrets.env'), 'QWEN_API_KEY=synthetic-compose-key\nDEMO_ADMIN_PASSWORD=' + password + '\n', { mode: 0o600 });
    report.stage = 'startup'; console.log('Compose acceptance: docker compose up -d');
    await compose('up', '-d');
    report.stage = 'gateway_ready'; await waitForGateway(base); await request('/mcp', { expected: 404 });
    report.stage = 'browser_identity';
    identity = (await compose('exec', '-T', '--user', '1000:1000', 'browser', 'cat', '/data/runtimes/instance-id')).trim();
    report.stage = 'browser_privileges';
    const processState = JSON.parse(await compose('exec', '-T', '--user', '1000:1000', 'browser', 'node', '-e', "const s=require('fs').readFileSync('/proc/1/status','utf8'); const rows=require('fs').readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).map(p=>{try {return {cmd:require('fs').readFileSync('/proc/'+p+'/cmdline','utf8'),status:require('fs').readFileSync('/proc/'+p+'/status','utf8')}}catch{return null}}).filter(r=>r?.cmd.includes('src/compose-service.ts')); console.log(JSON.stringify(rows.map(r=>({uid:r.status.match(/^Uid:\\s+(\\d+)/m)?.[1],cap:r.status.match(/^CapEff:\\s+(\\w+)/m)?.[1]}))))"));
    // Exclude the diagnostic process itself (its command line contains the needle).
    assert.ok(processState.some(p => p.uid === '1000' && /^0+$/.test(p.cap)));
    report.stage = 'compose_shape';
    const rendered = JSON.parse(await compose('config', '--format', 'json'));
    for (const name of ['agent', 'browser', 'mongo', 'redis']) assert.equal(rendered.services[name].ports, undefined);
    assert.ok(!rendered.services.browser.volumes.some(v => ['config', project + '_config'].includes(v.source)));
    const beforeHash = await configurationHash();
    report.stage = 'admin_login';
    let token = await login();
    report.checks.push('healthy_gateway_and_admin_login', 'browser_process_drops_root_and_capabilities', 'private_ports_and_separate_browser_credentials');
    report.stage = 'real_browser'; console.log('Compose acceptance: real Chrome task and handoff');
    const mid = randomUUID();
    const start = await request('/api/agents/chat', { token, body: { text: 'Open https://httpbin.org/anything/agentic-browser-acceptance, let me take control, then read the page and close the browser.', sender: 'User', isCreatedByUser: true, parentMessageId: '00000000-0000-0000-0000-000000000000', conversationId: 'new', messageId: mid, responseMessageId: mid + '_', endpoint: 'agents', agent_id: 'agent_browser_demo', spec: 'browser-demo', isTemporary: false, isRegenerate: false } });
    const route = '/api/agentic-browser/' + start.conversationId; let lease;
    for (let i = 0; i < 120; i++) { lease = (await request(route, { token })).lease; if (lease?.control === 'human') break; await sleep(1000); }
    assert.equal(lease?.control, 'human');
    await request(route + '/control', { token, body: { revision: lease.revision, target: 'agent', operationId: randomUUID() } });
    let completed = false;
    for (let i = 0; i < 120; i++) {
      if (!(await request('/api/agents/chat/status/' + start.conversationId, { token })).active) {
        const result = await request('/api/messages/' + start.conversationId, { token });
        const calls = (Array.isArray(result) ? result : result.messages).flatMap(msg => msg.content ?? []).filter(p => p.type === 'tool_call').map(p => p.tool_call);
        completed = calls.some(c => c.name === 'browser_snapshot' && c.output && JSON.parse(c.output).value?.result?.text?.includes('agentic-browser-acceptance')) && calls.some(c => c.name === 'browser_close' && c.output && JSON.parse(c.output).ok);
        if (completed) break;
      }
      await sleep(1000);
    }
    assert.equal(completed, true); report.checks.push('real_chrome_snapshot_handoff_resume_and_close');
    await sleep(2000);
    const beforeBalance = await request('/api/balance', { token });
    const beforeMessages = await request('/api/messages/' + start.conversationId, { token });
    report.stage = 'repeat'; console.log('Compose acceptance: repeated up and down/up preserve data');
    await compose('up', '-d'); assert.equal(await configurationHash(), beforeHash);
    await compose('down'); await compose('up', '-d'); await waitForGateway(base);
    token = await login();
    assert.equal(await configurationHash(), beforeHash);
    assert.deepEqual(await request('/api/balance', { token }), beforeBalance);
    assert.deepEqual(await request('/api/messages/' + start.conversationId, { token }), beforeMessages);
    assert.equal((await compose('exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', "db.getSiblingDB('AgenticBrowser').users.countDocuments({email:'compose-admin@example.test'})")).trim(), '1');
    assert.equal((await compose('exec', '-T', '--user', '1000:1000', 'browser', 'cat', '/data/runtimes/instance-id')).trim(), identity);
    report.checks.push('repeat_up_and_down_up_preserve_keys_admin_credits_chats');
    report.stage = 'invalid_configuration'; console.log('Compose acceptance: reject bad settings and recover');
    await compose('down');
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, model: { ...settings.model, promptRate: null } }));
    await assert.rejects(compose('up', '-d'));
    const logs = await compose('logs', '--no-color', 'init');
    assert.match(logs, /model.promptRate/); assert.ok(!logs.includes(password) && !logs.includes('synthetic-compose-key'));
    fs.writeFileSync(settingsFile, JSON.stringify(settings)); await compose('up', '-d'); await waitForGateway(base);
    assert.equal(await configurationHash(), beforeHash); await login();
    report.checks.push('invalid_configuration_rejected_without_secret_logs_or_key_rotation');
    report.passed = true;
  } catch (error) {
    fs.writeFileSync(path.join(deployment, 'private-error.log'), error.stack ?? String(error), { mode: 0o600 });
    report.failure = { type: error.name, code: error.code, cause: error.cause?.code };
  } finally {
    const cleanup = [];
    try { fs.writeFileSync(path.join(deployment, 'private-containers.log'), await compose('logs', '--no-color', '--tail', '80'), { mode: 0o600 }); } catch {}
    if (!report.passed) {
      try {
        const stored = JSON.parse(await compose('run', '--rm', '--no-deps', '--entrypoint', 'node', 'init', '-e', "const fs=require('fs'); console.log(fs.existsSync('/config/identity.json')?fs.readFileSync('/config/identity.json','utf8'):'{}')"));
        const values = [password, 'synthetic-compose-key', ...Object.values(stored)];
        report.diagnostics = {};
        for (const [key, file] of Object.entries({ compose: 'private-compose.log', containers: 'private-containers.log' })) if (fs.existsSync(path.join(deployment, file))) report.diagnostics[key] = redactDiagnostics(fs.readFileSync(path.join(deployment, file), 'utf8'), values).slice(-8000);
      } catch { report.diagnostics = { unavailable: true }; }
    }
    try { await compose('down', '--volumes', '--remove-orphans'); } catch { cleanup.push('compose'); }
    if (identity && /^[a-f0-9-]{36}$/.test(identity)) {
      const ids = (await run(['docker', 'ps', '-aq', '--filter', 'label=dev.agentic-browser.instance=' + identity])).split(/\s+/).filter(Boolean);
      if (ids.length) { cleanup.push('runtime'); await run(['docker', 'rm', '-f', ...ids]); }
    }
    for (const command of [['ps', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']]) {
      if (await run(['docker', ...command, '--filter', 'label=com.docker.compose.project=' + project])) cleanup.push(command[0]);
    }
    report.cleanup = { passed: !cleanup.length, remaining: cleanup.length }; report.passed &&= !cleanup.length;
    fs.writeFileSync(path.join(deployment, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { release: { type: 'string' }, work: { type: 'string' }, port: { type: 'string', default: '3350' }, development: { type: 'boolean' } } });
  if (!values.release || !values.work) throw new Error('Use --release FILE --work NEW_DIRECTORY [--development]');
  const port = Number(values.port); assert(Number.isInteger(port) && port >= 1024 && port < 65536);
  const result = await verifyCompose({ release: JSON.parse(fs.readFileSync(values.release)), work: path.resolve(values.work), port, development: values.development });
  if (!result.passed) process.exitCode = 1;
}
