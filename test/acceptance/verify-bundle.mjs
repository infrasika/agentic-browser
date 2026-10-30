#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { argumentsFor, atomic, cli, exists, Failure, json, mainModule, run, sleep } from '../../deploy/agent/lib/system.mjs';
const DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock'];
export function generationPending(route, response, body) {
  if (!/^\/api\/agents\/chat\/status\/[^/?]+$/.test(route) || response.status !== 503 || response.headers.has('x-agent-maintenance') || response.headers.get('retry-after') !== '1') return false;
  try { return JSON.parse(body).code === 'SERVER_NOT_READY'; } catch { return false; }
}
export async function main() {
  process.umask(0o077);
  const { values: args, positionals } = argumentsFor({ bundle: { type: 'string', default: path.resolve(import.meta.dirname, '..') }, work: { type: 'string' }, port: { type: 'string', default: '3340' } });
  if (args.help) return console.log('Isolated bundle acceptance: --work NEW_PRIVATE_DIRECTORY [--bundle DIRECTORY] [--port 3340]');
  const port = Number(args.port);
  if (positionals.length || !args.work || !Number.isInteger(port) || port < 1024 || port > 65533) throw new Failure('New work directory and three consecutive loopback ports required');
  const bundle = fs.realpathSync(args.bundle), work = path.resolve(args.work);
  if (exists(work)) throw new Failure('New work directory required');
  await run([process.execPath, path.join(bundle, 'bundle.mjs'), 'verify'], { timeout: 300_000 });
  const build = json(path.join(bundle, 'BUILD.json')), development = build.distribution === 'offline-candidate' ? ['--development'] : [];
  for (const info of Object.values(build.images)) assert.equal(JSON.parse(await run([...DOCKER, 'image', 'inspect', info.id]))[0].Id, info.id);
  fs.mkdirSync(work, { mode: 0o700, recursive: true });
  if (fs.realpathSync(work) !== work) throw new Failure('Non-symlink work directory required');
  const source = path.join(work, 'installation'), restored = path.join(work, 'restored'), rollback = path.join(work, 'rollback');
  const projects = new Map(), instances = new Set(); let fixture;
  const report = { passed: false, stage: 'init', checks: [], hostApplicationDependencies: ['Node.js 24+', 'Docker Engine', 'Docker Compose', 'flock'], hostTools: { node: process.versions.node, docker: await run([...DOCKER, 'version', '--format', '{{.Server.Version}}']), compose: await run([...DOCKER, 'compose', 'version', '--short']) }, scope: 'bundle-only disposable projects; independent-host status requires external evidence', callsPaidModel: false, bundleVersion: build.version, imageSources: build.sourceCommits, packageCommit: build.packageCommit, images: build.images };
  const command = async (directory, ...args) => {
    report.operation = args[0];
    const diagnostics = process.env.AGENT_ACCEPTANCE_DIAGNOSTICS === '1';
    if (diagnostics) console.log('Installer operation: ' + args[0]);
    // agentctl's CLI emits sanitized failure codes, never child stderr or secrets.
    return JSON.parse(await run([process.execPath, path.join(bundle, 'agentctl.mjs'), '--directory', directory, ...args], { timeout: 360_000, stderr: diagnostics ? 2 : undefined }));
  };
  const compose = (directory, ...args) => run([...DOCKER, 'compose', '--project-directory', directory, '--env-file', path.join(directory, '.env'), '-f', path.join(directory, 'compose.yaml'), ...args], { timeout: 360_000 });
  const control = await import(pathToFileURL(path.join(bundle, 'agentctl.mjs')).href);
  async function request(route, { token, body, target = port, expected = 200 } = {}) {
    const base = 'http://127.0.0.1:' + target;
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { origin: base, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-librechat-generation-protocol': '2', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const raw = await response.text();
    // The generation protocol deliberately returns this response while a
    // terminal checkpoint is being persisted. The caller's 120s poll bounds
    // the retry; maintenance responses and other errors still fail.
    if (body === undefined && expected === 200 && generationPending(route, response, raw)) { report.generationStatusRetries = (report.generationStatusRetries ?? 0) + 1; return { active: true }; }
    assert.equal(response.status, expected, 'Unexpected HTTP status in ' + report.stage + ': ' + route); return expected === 200 && raw ? JSON.parse(raw) : null;
  }
  const login = async (user, target) => (await request('/api/auth/login', { body: { email: user.email, password: user.password }, target })).token;
  const snapshot = async directory => JSON.parse(await compose(directory, 'exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', "JSON.stringify(['users','balances','sitebudgets','transactions','conversations','messages'].map(name=>({name,rows:db.getSiblingDB('AgenticBrowser').getCollection(name).find({},{updatedAt:0}).sort({_id:1}).toArray()})))"));
  async function browserTask(token, target) {
    const mid = randomUUID();
    const start = await request('/api/agents/chat', { token, target, body: { text: 'Open https://httpbin.org/anything/agentic-browser-acceptance, let me take control, then read the page and close the browser.', sender: 'User', isCreatedByUser: true, parentMessageId: '00000000-0000-0000-0000-000000000000', conversationId: 'new', messageId: mid, responseMessageId: mid + '_', endpoint: 'agents', agent_id: 'agent_browser_demo', spec: 'browser-demo', isTemporary: false, isRegenerate: false } });
    const cid = start.conversationId, route = '/api/agentic-browser/' + cid; let lease;
    for (let i = 0; i < 120; i++) { lease = (await request(route, { token, target })).lease; if (lease?.control === 'human') break; await sleep(1000); }
    assert.equal(lease?.control, 'human', 'handoff timeout');
    if (target === port) { await assert.rejects(() => command(source, 'backup')); assert.equal((await command(source, 'maintain')).status, 'deferred_busy'); await request('/api/config'); }
    await request(route + '/control', { token, target, body: { revision: lease.revision, target: 'agent', operationId: randomUUID() } });
    for (let i = 0; i < 120; i++) {
      if (!(await request('/api/agents/chat/status/' + cid, { token, target })).active) {
        const result = await request('/api/messages/' + cid, { token, target });
        const calls = (Array.isArray(result) ? result : result.messages).flatMap(msg => msg.content ?? []).filter(p => p.type === 'tool_call').map(p => p.tool_call);
        const snapshots = calls.filter(c => c.name === 'browser_snapshot' && c.output && JSON.parse(c.output).value?.result?.text?.includes('agentic-browser-acceptance'));
        const closed = calls.filter(c => c.name === 'browser_close' && c.output).map(c => JSON.parse(c.output));
        if (snapshots.length && closed.some(c => c.ok && ['completed', 'closing', 'cleanup_pending'].includes(c.value.state))) {
          const directory = target === port ? source : target === port + 1 ? restored : rollback;
          const script = `const d=new(require('node:sqlite').DatabaseSync)('/data/scheduler.sqlite',{readOnly:true});const row=d.prepare('SELECT state FROM leases WHERE id=?').get(${JSON.stringify(lease.id)});d.close();console.log(JSON.stringify({state:row?.state,records:require('fs').readdirSync('/data/runtimes').filter(n=>n.endsWith('.json')).length}))`;
          const final = JSON.parse(await compose(directory, 'exec', '-T', 'browser', 'node', '-e', script)); if (final.state === 'completed' && final.records === 0) return;
        }
      }
      await sleep(1000);
    }
    throw new Failure('real snapshot and automatic completion timeout');
  }
  async function interruptedBackup(directory) {
    const script = `import {Installation,operationLock,execute,DOCKER} from ${JSON.stringify(pathToFileURL(path.join(bundle, 'agentctl.mjs')).href)}; const job=new Installation(${JSON.stringify(directory)}); const unlock=await operationLock(${JSON.stringify(path.join(directory, 'state/lock'))}); await job.enter('backup'); await execute([...DOCKER,'run','-d','--name',job.meta.project+'-fault-helper','--label','dev.agentic-browser.operation='+job.meta.project,'--network=none','--read-only','--cap-drop=ALL','--memory=64m','--entrypoint=node',job.release.images.agent,'-e','setTimeout(()=>{},600000)']);console.log('writers_stopped');await new Promise(resolve=>setTimeout(resolve,600000));await unlock();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }); child.stderr.resume();
    const exited = new Promise(resolve => child.once('close', resolve));
    try {
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Failure('backup interruption timeout')), 180_000); child.stdout.once('data', data => { clearTimeout(timer); data.toString().trim() === 'writers_stopped' ? resolve() : reject(new Failure('backup interruption fixture failed')); }); child.once('error', () => { clearTimeout(timer); reject(new Failure('backup interruption fixture unavailable')); }); child.once('exit', () => { clearTimeout(timer); reject(new Failure('backup interruption fixture exited early')); }); });
      child.kill('SIGKILL'); await exited; await request('/api/config', { target: port + 1, expected: 503 });
      // Allow the lock helper to consume EOF after its owner was killed.
      await sleep(100); assert.equal((await command(directory, 'maintain')).status, 'recovered_interrupted_backup'); await command(directory, 'doctor');
      assert.equal(await run([...DOCKER, 'ps', '-aq', '--filter', 'label=dev.agentic-browser.operation=' + projects.get(directory)]), '');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
  }
  try {
    await command(source, 'init', '--release', path.join(bundle, 'release.json'), '--port', String(port), ...development); projects.set(source, json(path.join(source, 'installation.json')).project);
    await assert.rejects(() => command(source, 'up')); await assert.rejects(() => command(source, 'init', '--release', path.join(bundle, 'release.json'), ...development));
    const settings = json(path.join(source, 'config/settings.json')); Object.assign(settings, { adminEmail: 'bundle-admin@example.test', model: { name: 'selfhost-fixture', baseURL: 'http://fixture:9000/v1', promptRate: 1, completionRate: 1 } });
    atomic(path.join(source, 'config/settings.json'), settings);
    const secretsFile = path.join(source, 'config/secrets.env'); atomic(secretsFile, fs.readFileSync(secretsFile, 'utf8').replace('QWEN_API_KEY=', 'QWEN_API_KEY=synthetic-bundle-key'));
    await new control.Installation(source).render(); await compose(source, 'create'); fixture = projects.get(source) + '-fixture';
    await run([...DOCKER, 'run', '-d', '--name', fixture, '--network', projects.get(source) + '_front', '--network-alias', 'fixture', '--read-only', '--user', `${process.getuid()}:${process.getgid()}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=192m', '--cpus=.5', '--mount', 'type=bind,src=' + path.join(bundle, 'acceptance/model-fixture.mjs') + ',dst=/fixture.mjs,readonly', '--entrypoint=node', build.images.agent.id, '/fixture.mjs']);
    await command(source, 'up'); await command(source, 'doctor');
    const replica = path.join(work, 'replica'); fs.mkdirSync(replica, { mode: 0o700 });
    await command(source, 'schedule', '--timezone', 'Asia/Shanghai', '--hour', '0', '--retry-minutes', '1', '--copy-to', replica);
    const identity = await compose(source, 'exec', '-T', 'browser', 'cat', '/data/runtimes/instance-id'); instances.add(identity);
    await request('/mcp', { expected: 404 }); report.checks.push('configuration_required_and_existing_installation_preserved; private_gateway_healthy_mcp_closed');
    report.stage = 'accounts_and_real_browser';
    const user = { email: 'bundle-user@example.test', name: 'Bundle User', username: 'bundle-user', password: 'Synthetic-Bundle-Password-2026!' }, input = path.join(work, 'user.json'); atomic(input, user);
    assert.equal((await command(source, 'user-create', '--input-file', input)).status, 'created');
    let token = await login(user, port); const balance = await request('/api/balance', { token }); assert.equal(balance.tokenCredits, settings.credits.initial);
    assert.equal((await command(source, 'user-create', '--input-file', input)).status, 'already_exists'); assert.deepEqual(await request('/api/balance', { token }), balance);
    await request('/api/demo-admin', { token, expected: 403 }); await browserTask(token, port);
    report.checks.push('ordinary_account_isolation_and_credits_once', 'real_chrome_snapshot_handoff_and_automatic_resume', 'active_task_defers_backup');
    report.stage = 'backup_restore'; await sleep(2000); let before = await snapshot(source);
    const stateFile = path.join(source, 'state/backup-status.json'), state = json(stateFile); state.lastAttemptAt = '2000-01-01T00:00:00Z'; atomic(stateFile, state);
    assert.equal((await command(source, 'maintain')).status, 'completed');
    const completed = (await command(source, 'maintenance-status')).state;
    assert.equal((await command(source, 'verify-backup', path.join(replica, projects.get(source), completed.lastBackup))).verified, true);
    assert.ok(['retry_not_due', 'not_due'].includes((await command(source, 'maintain')).status)); assert.deepEqual(await snapshot(source), before);
    report.checks.push('scheduled_idle_backup_busy_retry_verified_copy_and_daily_deduplication; copy_is_same_host_fixture');
    const backup = (await command(source, 'backup')).backup; assert.equal((await command(source, 'verify-backup', backup)).verified, true); await compose(source, 'stop');
    await command(restored, 'restore', backup, '--port', String(port + 1), ...development); projects.set(restored, json(path.join(restored, 'installation.json')).project);
    await run([...DOCKER, 'network', 'connect', '--alias', 'fixture', projects.get(restored) + '_front', fixture]); await command(restored, 'recover'); await command(restored, 'doctor');
    const newIdentity = await compose(restored, 'exec', '-T', 'browser', 'cat', '/data/runtimes/instance-id'); instances.add(newIdentity); assert.notEqual(identity, newIdentity);
    assert.deepEqual(await snapshot(restored), before); await assert.rejects(() => command(restored, 'restore', backup, '--port', String(port + 1), ...development));
    token = await login(user, port + 1); await browserTask(token, port + 1); report.checks.push('new_project_restore_preserves_accounts_chats_credits_budget_and_runs_new_real_browser');
    report.stage = 'upgrade_rehearsal'; await sleep(2000); before = await snapshot(restored);
    const next = json(path.join(bundle, 'release.json')); next.version += '-rehearsal'; const nextFile = path.join(work, 'next-release.json'); atomic(nextFile, next);
    assert.equal((await command(restored, 'upgrade', '--release', nextFile, ...development)).status, 'upgraded'); assert.deepEqual(await snapshot(restored), before);
    report.checks.push('same_build_upgrade_procedure_takes_backup_and_preserves_data; not_a_cross_version_migration_test');
    report.stage = 'interrupted_backup'; before = await snapshot(restored); await interruptedBackup(restored); assert.deepEqual(await snapshot(restored), before);
    report.checks.push('SIGKILL_after_stopping_writers_recovers_health_data_and_owned_orphan_helper');
    report.stage = 'failed_upgrade_and_rollback';
    const broken = { ...next, version: 'injected-invalid-agent', images: { ...next.images, agent: next.images.runtime } }, brokenFile = path.join(work, 'broken-release.json'); atomic(brokenFile, broken);
    await assert.rejects(() => command(restored, 'upgrade', '--release', brokenFile, ...development)); assert.equal((await command(restored, 'maintain')).status, 'operator_required');
    await request('/api/config', { target: port + 1, expected: 503 }); const operation = json(path.join(restored, 'state/operation.json')); assert.equal(operation.phase, 'upgrade_failed');
    await command(rollback, 'restore', operation.backup, '--port', String(port + 2), ...development); projects.set(rollback, json(path.join(rollback, 'installation.json')).project);
    await run([...DOCKER, 'network', 'connect', '--alias', 'fixture', projects.get(rollback) + '_front', fixture]); await command(rollback, 'recover'); await command(rollback, 'doctor');
    instances.add(await compose(rollback, 'exec', '-T', 'browser', 'cat', '/data/runtimes/instance-id')); assert.deepEqual(await snapshot(rollback), before);
    await browserTask(await login(user, port + 2), port + 2); report.checks.push('invalid_image_upgrade_retains_maintenance_and_pre_upgrade_backup_restores_data_and_real_task'); report.passed = true;
  } catch (error) { atomic(path.join(work, 'private-error.txt'), error.stack ?? String(error)); }
  finally {
    for (const directory of [source, restored, rollback]) if (exists(path.join(directory, 'installation.json'))) projects.set(directory, json(path.join(directory, 'installation.json')).project);
    if (fixture) await run([...DOCKER, 'rm', '-f', fixture]).catch(() => {});
    const cleanup = [];
    for (const [directory, project] of projects) {
      try {
        const helpers = (await run([...DOCKER, 'ps', '-aq', '--filter', 'label=dev.agentic-browser.operation=' + project])).split(/\s+/).filter(Boolean); if (helpers.length) await run([...DOCKER, 'rm', '-f', ...helpers]);
        if (exists(path.join(directory, '.env'))) {
          atomic(path.join(work, project + '-logs.txt'), await compose(directory, 'logs', '--no-color', '--tail', '80')); await compose(directory, 'down', '--volumes', '--remove-orphans');
          await run([...DOCKER, 'run', '--rm', '--network=none', '--read-only', '--user=0:0', '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--security-opt=no-new-privileges', '--volume', path.join(directory, 'data') + ':/data', '--entrypoint=chown', build.images.agent.id, '-R', `${process.getuid()}:${process.getgid()}`, '/data']);
        }
        for (const command of [['ps', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']]) if (await run([...DOCKER, ...command, '--filter', 'label=com.docker.compose.project=' + project])) cleanup.push(project + ':' + command[0]);
        if (await run([...DOCKER, 'ps', '-aq', '--filter', 'label=dev.agentic-browser.operation=' + project])) cleanup.push(project + ':helpers');
      } catch { cleanup.push(project); }
    }
    for (const instance of instances) if (await run([...DOCKER, 'ps', '-aq', '--filter', 'label=dev.agentic-browser.instance=' + instance])) cleanup.push('runtime');
    if (fixture && await run([...DOCKER, 'ps', '-aq', '--filter', 'name=^/' + fixture + '$'])) cleanup.push('fixture');
    try { await run([process.execPath, path.join(bundle, 'bundle.mjs'), 'verify'], { timeout: 300_000 }); } catch { cleanup.push('bundle_integrity_after_acceptance'); }
    report.cleanup = { passed: !cleanup.length, remaining: cleanup.length }; report.passed &&= !cleanup.length; atomic(path.join(work, 'report.json'), report);
    if (report.passed) for (const name of fs.readdirSync(work)) if (name !== 'report.json') fs.rmSync(path.join(work, name), { recursive: true, force: true });
    console.log(JSON.stringify(report));
  }
  if (!report.passed) process.exitCode = 1;
}
if (mainModule('verify-bundle.mjs') || mainModule('verify.mjs')) cli(main);
