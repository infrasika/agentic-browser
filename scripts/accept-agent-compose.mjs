import assert from 'node:assert/strict';
import { acceptanceRelease } from './agent/release-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { WebSocket } from 'ws';

if (!process.argv.includes('--run')) { console.log('Usage: node scripts/accept-agent-compose.mjs --run --release release.json [--hold]'); process.exit(0); }
const root = resolve(import.meta.dirname, '..');
const exec = promisify(execFile), runId = randomUUID(), project = 'agent-test-' + runId.slice(0, 8);
const directory = resolve(root, '.deployment/agent-acceptance', runId);
const origin = 'http://127.0.0.1:3334';
const report = { runId, project, passed: false, stage: 'preflight', checks: [], callsPaidModel: false };
let instance, socket, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; });
const command = async (cmd, args, timeout = 60000) => (await exec(cmd, args, { cwd: root, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const compose = (args, timeout) => command('docker', ['compose', '--project-directory', directory, '--env-file', directory + '/.env', '-f', directory + '/compose.yaml', '-f', directory + '/fixture.yaml', ...args], timeout);
await mkdir(directory, { recursive: true, mode: 0o700 });
async function guard() {
  assert.ok(!interrupted, 'Interrupted');
  const memory = Number((await readFile('/proc/meminfo','utf8')).match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  assert.ok(memory > 3 * 1024 * 1024, 'Memory reserve');
}
const headers = { origin, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-librechat-generation-protocol': '2', 'x-user-id': 'untrusted-spoof' };
async function request(token, path, body) {
  await guard();
  return fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
}
async function call(token, path, body) {
  const response = await request(token, path, body);
  if(response.status!==200) await writeFile(resolve(directory,'private-http-failure.json'),JSON.stringify({path,status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()}),{mode:0o600});
  assert.equal(response.status, 200, `HTTP ${response.status} in ${report.stage}`); return response.json();
}
async function login(email, password) { return (await call(undefined, '/api/auth/login', { email, password })).token; }
const browserPath = account => '/api/agentic-browser/' + account.conversationId;
const modelCalls = async () => JSON.parse(await compose(['exec','-T','agent','node','-e',"fetch('http://fixture:9000/stats').then(r=>r.text()).then(console.log)"])).calls;
async function waitLease(account, condition) {
  for (let i=0;i<80;i++) { const {lease}=await call(account.token,browserPath(account)); if(condition(lease)) return lease; await delay(750); }
  throw new Error('Lease deadline in ' + report.stage);
}
async function waitCompleted(account, leaseId) {
  for (let i=0;i<80;i++) {
    const status=await call(account.token,'/api/agents/chat/status/'+account.conversationId);
    if (!status.active) {
      const result=await call(account.token,'/api/messages/'+account.conversationId);
      const messages=Array.isArray(result)?result:result.messages;
      const closed=messages?.flatMap(m=>m.content??[]).find(part=>part.type==='tool_call'&&part.tool_call?.name==='browser_close');
      if (closed?.tool_call.output) {
        const value=JSON.parse(closed.tool_call.output);
        assert.equal(value.ok,true); assert.equal(value.value.id,leaseId); assert.ok(['completed','closing','cleanup_pending'].includes(value.value.state));
        const row=JSON.parse(await compose(['exec','-T','browser','node','-e',"const db=new(require('node:sqlite').DatabaseSync)('/data/scheduler.sqlite',{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT id,state FROM leases WHERE id=?').get("+JSON.stringify(leaseId)+")));db.close();"]));
        if (row.state === 'completed') return;
      }
    }
    await delay(750);
  }
  throw new Error('Completion deadline in '+report.stage);
}
async function start(account) {
  const messageId=randomUUID();
  const result=await call(account.token,'/api/agents/chat',{text:'Open https://httpbin.org/anything/agentic-browser-acceptance, let me take control, then read the page and close the browser.', sender:'User',isCreatedByUser:true,parentMessageId:'00000000-0000-0000-0000-000000000000',conversationId:'new',messageId,responseMessageId:messageId+'_',endpoint:'agents',agent_id:'agent_browser_demo',spec:'browser-demo',isTemporary:false,isRegenerate:false});
  assert.ok(result.conversationId); account.conversationId=result.conversationId;
}
try {
  await guard();
  for(const [source,target] of [['deploy/agent/compose.yaml','compose.yaml'],['scripts/agent/model-fixture.mjs','model-fixture.mjs'],['scripts/agent/users-fixture.cjs','users-fixture.cjs']]) await cp(resolve(root,source),resolve(directory,target));
  const {images}=await acceptanceRelease();
  report.images=images;
  const uid=process.getuid(),gid=process.getgid(),socketGroup=(await stat('/var/run/docker.sock')).gid;
  await writeFile(resolve(directory,'.env'),[
    `AGENT_PROJECT=${project}`,`AGENT_IMAGE=${images.agent}`,`BROWSER_IMAGE=${images.browser}`,`RUNTIME_IMAGE=${images.runtime}`,
    `GATEWAY_IMAGE=${images.gateway}`,`MONGO_IMAGE=${images.mongo}`,`REDIS_IMAGE=${images.redis}`,
    `AGENT_UID=${uid}`,`AGENT_GID=${gid}`,`DOCKER_GID=${socketGroup}`,'AGENT_PORT=3334',`AGENT_DATA_DIR=${directory}/data`,`AGENT_ORIGIN=${origin}`,'BROWSER_MAX_SESSIONS=1',''].join('\n'),{mode:0o600});
  await mkdir(resolve(directory,'data'),{mode:0o700});
  for(const name of ['browser-data','mongo-data','redis-data','uploads','images','logs']) await mkdir(resolve(directory,'data',name),{mode:0o700});
  await mkdir(resolve(directory,'config'),{mode:0o700});
  // Create bind sources ourselves; Docker-created parents are owned by root.
  await mkdir(resolve(directory,'state/maintenance'),{recursive:true,mode:0o700});
  // Init and render run in the shipped image, without host Node dependencies.
  const configCommand=mode=>command('docker',['run','--rm','--network=none','--user',`${uid}:${gid}`,'--volume',`${directory}/config:/config`,'--entrypoint','node',images.agent,'/app/selfhost/init.mjs',mode,'/config']);
  await configCommand('init');
  const settings=JSON.parse(await readFile(resolve(directory,'config/settings.json'),'utf8'));
  Object.assign(settings,{origin,adminEmail:'private-admin@example.test',model:{name:'selfhost-fixture',baseURL:'http://fixture:9000/v1',promptRate:0.276,completionRate:1.101}});
  await writeFile(resolve(directory,'config/settings.json'),JSON.stringify(settings),{mode:0o600});
  const secretPath=resolve(directory,'config/secrets.env');
  await writeFile(secretPath,(await readFile(secretPath,'utf8')).replace('QWEN_API_KEY=','QWEN_API_KEY=synthetic-model-key'),{mode:0o600});
  const secrets=parseEnv(await readFile(secretPath,'utf8'));
  await configCommand('render');
  await writeFile(resolve(directory,'fixture.yaml'),`services:\n  agent:\n    volumes: ['./users-fixture.cjs:/fixture/users.cjs:ro']\n  fixture:\n    image: node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d\n    user: '${uid}:${gid}'\n    command: [node, /fixture.mjs]\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    volumes: ['./model-fixture.mjs:/fixture.mjs:ro']\n    networks: [front]\n    mem_limit: 128m\n    cpus: 0.5\n`,{mode:0o600});
  report.stage='compose_start';
  await compose(['up','-d','--wait','--wait-timeout','240'],270000);
  report.checks.push('starts_from_images_with_private_volumes_and_no_host_node');
  instance=await compose(['exec','-T','browser','cat','/data/runtimes/instance-id']); assert.match(instance,/^[a-f0-9-]{36}$/);
  const services=JSON.parse(await compose(['config','--format','json']));
  for(const name of ['agent','browser','mongo','redis']) assert.equal(services.services[name].ports,undefined);
  assert.ok(!services.services.agent.volumes.some(v=>v.target==='/var/run/docker.sock'));
  for(const name of ['agent','browser','volumes-init']) for(const mount of services.services[name].volumes??[]) if(mount.type==='volume') assert.equal(mount.volume.nocopy,true);
  report.checks.push('only_gateway_has_published_port_and_only_browser_has_docker_socket');
  report.stage='accounts';
  const config=await call(undefined,'/api/config'); assert.ok(config);
  const registration=await request(undefined,'/api/auth/register',{email:'blocked@example.test',password:'Fixture-Long-Password!',confirm_password:'Fixture-Long-Password!',name:'Blocked',username:'blocked'});
  assert.ok([403,404].includes(registration.status));
  const owner={token:await login(settings.adminEmail,secrets.DEMO_ADMIN_PASSWORD)};
  await compose(['exec','-T','agent','node','/fixture/users.cjs']);
  const other={token:await login('private-user@example.test','Acceptance-User-2026!')};
  assert.equal((await request(other.token,'/api/demo-admin')).status,403);
  assert.equal((await request(undefined,'/api/demo-admin')).status,401);
  const budgetBefore=await call(owner.token,'/api/demo-admin'); assert.equal(budgetBefore.limitCredits,20000000);
  for(const path of ['/mcp','/internal/v1/leases','/browser/internal/v1/leases']) assert.equal((await request(undefined,path)).status,404);
  report.checks.push('closed_registration_local_login_roles_and_public_api_boundary');
  report.stage='credits_and_budget';
  const userId=await compose(['exec','-T','mongo','mongosh','--quiet','--eval',"db.getSiblingDB('AgenticBrowser').users.findOne({email:'private-user@example.test'})._id.toString()"]);
  assert.match(userId,/^[a-f0-9]{24}$/);
  const balanceBefore=await call(other.token,'/api/balance');
  const credit={credits:1000,id:randomUUID()};
  for(let i=0;i<2;i++) await call(owner.token,'/api/demo-admin/users/'+userId+'/credits',credit);
  const credited=await call(other.token,'/api/balance');
  assert.equal(credited.tokenCredits,balanceBefore.tokenCredits+1000);
  report.checks.push('admin_credit_retry_is_idempotent');
  await call(owner.token,'/api/demo-admin/budget',{credits:0,revision:budgetBefore.revision});
  const callsBefore=await modelCalls();
  await start(other);
  const events=await fetch(origin+'/api/agents/chat/stream/'+other.conversationId+'?resume=true',{headers:{...headers,authorization:'Bearer '+other.token},signal:AbortSignal.timeout(60000)});
  assert.equal(events.status,200);
  const deniedEvents=await events.text();
  assert.match(deniedEvents,/site_budget_exceeded/);
  assert.equal(await modelCalls(),callsBefore);
  assert.deepEqual(await call(other.token,'/api/balance'),credited);
  const blockedBudget=await call(owner.token,'/api/demo-admin');
  await call(owner.token,'/api/demo-admin/budget',{credits:budgetBefore.limitCredits,revision:blockedBudget.revision});
  report.checks.push('zero_daily_budget_prevents_provider_calls_and_personal_spend');
  report.stage='human_handoff'; await start(owner);
  const lease=await waitLease(owner,l=>l?.state==='active'&&l.control==='human');
  assert.deepEqual(await call(other.token,browserPath(owner)),{lease:null});
  assert.equal((await request(other.token,browserPath(owner)+'/viewer',{revision:lease.revision,role:'input'})).status,404);
  assert.equal((await request(other.token,browserPath(owner)+'/control',{revision:lease.revision,target:'agent',operationId:randomUUID()})).status,404);
  assert.equal((await request(other.token,browserPath(owner)+'/cancel',{})).status,404);
  assert.ok([403,404].includes((await request(other.token,'/api/messages/'+owner.conversationId)).status));
  report.checks.push('native_model_tools_open_real_chrome_and_isolate_accounts');
  report.stage='queue'; await start(other);
  const waiting=await waitLease(other,l=>l?.state==='queued'); assert.equal(waiting.position,1);
  const grant=await call(owner.token,browserPath(owner)+'/viewer',{revision:lease.revision,role:'input'});
  socket=new WebSocket(origin.replace('http:','ws:')+grant.path,{origin}); socket.on('error',()=>{});
  await once(socket,'open',{signal:AbortSignal.timeout(15000)});
  const frame=once(socket,'message',{signal:AbortSignal.timeout(15000)}); socket.send(JSON.stringify({grant:grant.grant}));
  assert.ok(Buffer.from((await frame)[0]).toString('ascii').startsWith('RFB '));
  report.checks.push('capacity_one_queues_second_account_and_input_websocket_works');
  report.stage='return_and_resume';
  const closed=once(socket,'close',{signal:AbortSignal.timeout(30000)});
  await call(owner.token,browserPath(owner)+'/control',{revision:lease.revision,target:'agent',operationId:randomUUID()});
  assert.equal((await closed)[0],1008);
  await waitCompleted(owner,lease.id);
  const next=await waitLease(other,l=>l?.state==='active'&&l.control==='human'); assert.equal(next.id,waiting.id);
  await call(other.token,browserPath(other)+'/control',{revision:next.revision,target:'agent',operationId:randomUUID()});
  await waitCompleted(other,next.id);
  for(const account of [owner,other]) {
    let status;
    for(let i=0;i<30;i++) { status=await call(account.token,'/api/agents/chat/status/'+account.conversationId); if(!status.active) break; await delay(500); }
    assert.equal(status.active,false);
    const result=await call(account.token,'/api/messages/'+account.conversationId);
    const messages=Array.isArray(result)?result:result.messages;
    const snapshots=messages.flatMap(m=>m.content??[]).filter(p=>p.type==='tool_call'&&p.tool_call?.name==='browser_snapshot'&&p.tool_call.output).map(p=>JSON.parse(p.tool_call.output));
    assert.ok(snapshots.some(output=>output.ok&&output.value?.result?.text?.includes('agentic-browser-acceptance')));
  }
  const budgetAfter=await call(owner.token,'/api/demo-admin');
  assert.ok(budgetAfter.spentCredits>0); assert.equal(budgetAfter.reservedCredits,0);
  report.checks.push('done_revokes_old_viewer_and_resumes_without_new_chat','queued_task_automatically_admitted','chat_title_and_tool_resume_share_budget');
  report.stage='restart_persistence';
  await compose(['restart','agent'],120000);
  await compose(['up','-d','--wait','--wait-timeout','120','agent'],150000);
  const loginAgain=await login(settings.adminEmail,secrets.DEMO_ADMIN_PASSWORD);
  const restored=await call(loginAgain,'/api/demo-admin');
  assert.equal(restored.spentCredits,budgetAfter.spentCredits); assert.equal(restored.limitCredits,budgetAfter.limitCredits);
  report.checks.push('container_restart_preserves_accounts_passwords_and_budget');
  report.stage='logout_cleanup'; owner.token=loginAgain;
  await start(owner);
  const logoutLease=await waitLease(owner,l=>l?.state==='active'&&l.control==='human');
  const logoutGrant=await call(owner.token,browserPath(owner)+'/viewer',{revision:logoutLease.revision,role:'input'});
  socket=new WebSocket(origin.replace('http:','ws:')+logoutGrant.path,{origin}); socket.on('error',()=>{});
  await once(socket,'open',{signal:AbortSignal.timeout(15000)});
  const logoutFrame=once(socket,'message',{signal:AbortSignal.timeout(15000)});
  socket.send(JSON.stringify({grant:logoutGrant.grant}));
  assert.ok(Buffer.from((await logoutFrame)[0]).toString('ascii').startsWith('RFB '));
  const logoutClosed=once(socket,'close',{signal:AbortSignal.timeout(30000)});
  assert.equal((await request(owner.token,'/api/auth/logout',{})).status,200);
  await logoutClosed;
  owner.token=await login(settings.adminEmail,secrets.DEMO_ADMIN_PASSWORD);
  let stopped=false;
  for(let i=0;i<60;i++) {
    const status=await call(owner.token,'/api/agents/chat/status/'+owner.conversationId);
    const current=await call(owner.token,browserPath(owner));
    if(!status.active&&!current.lease) { stopped=true; break; }
    await delay(500);
  }
  assert.equal(stopped,true,'Logout terminates generation and releases browser');
  const logoutCalls=await modelCalls();
  await delay(5000);
  assert.equal(await modelCalls(),logoutCalls,'Background worker must not resume a logged-out task');
  assert.deepEqual(await call(owner.token,browserPath(owner)),{lease:null});
  assert.equal((await command('docker',['ps','-q','--filter','label=dev.agentic-browser.instance='+instance])), '');
  report.checks.push('logout_revokes_viewer_releases_browser_and_prevents_worker_resume');
  report.passed=true;
  if(process.argv.includes('--hold')) { await writeFile(resolve(directory,'ui-ready.json'),JSON.stringify({origin,adminEmail:settings.adminEmail}),{mode:0o600}); console.log(JSON.stringify({uiReady:true,directory})); while(!interrupted) await delay(1000); }
} catch(error) {
  report.failure=error?.message?.startsWith('HTTP ')||error?.message?.startsWith('Lease deadline')?error.message:'acceptance_failed';
  await writeFile(resolve(directory,'private-failure.log'),String(error?.stack),{mode:0o600});
} finally {
  socket?.terminate();
  try { await writeFile(resolve(directory,'private-messages.json'),await compose(['exec','-T','mongo','mongosh','--quiet','--eval',"JSON.stringify(db.getSiblingDB('AgenticBrowser').messages.find({},{text:1,content:1,isCreatedByUser:1}).toArray())"]),{mode:0o600}); } catch {}
  try { await writeFile(resolve(directory,'private-compose.log'),await compose(['logs','--no-color','--tail','200']),{mode:0o600}); } catch {}
  try {
    await compose(['down','--volumes','--remove-orphans'],150000);
    // Reclaim only this disposable fixture's stopped database files.
    await command('docker',['run','--rm','--network=none','--read-only','--user=0:0','--cap-drop=ALL','--cap-add=CHOWN','--cap-add=DAC_OVERRIDE','--security-opt=no-new-privileges','--volume',directory+'/data:/data','--entrypoint=chown',report.images.agent,'-R',`${process.getuid()}:${process.getgid()}`,'/data']);
    const remaining=await command('docker',['ps','-aq','--filter','label=com.docker.compose.project='+project]);
    const runtimes=instance?await command('docker',['ps','-aq','--filter','label=dev.agentic-browser.instance='+instance]):'';
    report.cleanup={passed:!remaining&&!runtimes,remainingContainers:remaining.split('\n').filter(Boolean).length,runtimeContainers:runtimes.split('\n').filter(Boolean).length};
  } catch { report.cleanup={passed:false}; }
  report.passed=report.passed&&report.cleanup.passed;
  if(report.passed) {
    try { await rm(directory,{recursive:true,force:true}); report.cleanup.localFiles=true; }
    catch { report.cleanup.localFiles=false; report.cleanup.passed=false; report.passed=false; report.failure='fixture_directory_cleanup_failed'; }
  }
  report.completedAt=new Date().toISOString();
  await mkdir(resolve(root,'output/agent'),{recursive:true});
  await writeFile(resolve(root,'output/agent/compose-'+runId+'.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(resolve(root,'output/agent/compose-latest.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}
process.exit(report.passed?0:1);
