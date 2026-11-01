import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { run } from '../../deploy/agent/lib/system.mjs';
import { generationPending } from './http.mjs';

export async function verifyBusiness({compose:runCompose, account, base:origin, settings, password, report, identity}) {
  const compose=args=>runCompose(...args); let socket;
const headers = { origin, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36', 'x-librechat-generation-protocol': '2', 'x-user-id': 'untrusted-spoof' };
async function request(token, path, body) {
  return fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
}
async function call(token, path, body) {
  const response = await request(token, path, body);
  const raw=await response.text();
  if(generationPending(path,response,raw)) return {active:true};
  assert.equal(response.status,200,`HTTP ${response.status} in ${report.stage}`); return raw?JSON.parse(raw):null;
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
      const closed=messages?.flatMap(m=>m.content??[]).find(part=>{
        if(part.type!=='tool_call'||part.tool_call?.name!=='browser_close'||!part.tool_call.output) return false;
        try { return JSON.parse(part.tool_call.output).value?.id===leaseId; } catch { return false; }
      });
      if (closed?.tool_call.output) {
        const value=JSON.parse(closed.tool_call.output);
        assert.equal(value.ok,true); assert.equal(value.value.id,leaseId); assert.ok(['completed','closing','cleanup_pending'].includes(value.value.state));
        const row=JSON.parse(await compose(['exec','-T','--user','1000:1000','browser','node','-e',"const db=new(require('node:sqlite').DatabaseSync)('/data/scheduler.sqlite',{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT id,state FROM leases WHERE id=?').get("+JSON.stringify(leaseId)+")));db.close();"]));
        if (row.state === 'completed') return;
      }
    }
    await delay(750);
  }
  throw new Error('Completion deadline in '+report.stage);
}
async function start(account, largeContext = false, followUp = false) {
  const messageId=randomUUID();
  let parentMessageId='00000000-0000-0000-0000-000000000000';
  if(followUp) {
    const response=await call(account.token,'/api/messages/'+account.conversationId);
    const messages=Array.isArray(response)?response:response.messages;
    const parent=messages.filter(m=>m.isCreatedByUser===false).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
    assert.ok(parent?.messageId,'Follow-up attaches to the previous assistant response');
    parentMessageId=parent.messageId;
  }
  // The long synthetic briefing crosses the former ~31 KiB budget gate while
  // remaining well inside the model context and 256 KiB transport limits.
  const briefing=largeContext?'\nReference notes:\n'+'Synthetic repository description for browser acceptance.\n'.repeat(700):'';
  const result=await call(account.token,'/api/agents/chat',{text:'Open https://httpbin.org/anything/agentic-browser-acceptance, let me take control, then read the page and close the browser.'+briefing, sender:'User',isCreatedByUser:true,parentMessageId,conversationId:followUp?account.conversationId:'new',messageId,responseMessageId:messageId+'_',endpoint:'agents',agent_id:'agent_browser_demo',spec:'browser-demo',isTemporary:false,isRegenerate:false});
  if(followUp) assert.equal(result.conversationId,account.conversationId);
  assert.ok(result.conversationId); account.conversationId=result.conversationId;
}

try {
  report.stage='accounts';
  const config=await call(undefined,'/api/config'); assert.ok(config);
  const registration=await request(undefined,'/api/auth/register',{email:'blocked@example.test',password:'Fixture-Long-Password!',confirm_password:'Fixture-Long-Password!',name:'Blocked',username:'blocked'});
  assert.ok([403,404].includes(registration.status));
  const owner={token:await login(settings.adminEmail,password)};
  await account('user-create',{email:'private-user@example.test',name:'Private User',username:'private_user',password:'Acceptance-User-2026!'});
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
  const ownerId=await compose(['exec','-T','mongo','mongosh','--quiet','--eval',"db.getSiblingDB('AgenticBrowser').users.findOne({role:'ADMIN'})._id.toString()"]);
  assert.match(ownerId,/^[a-f0-9]{24}$/);
  const ownerBalanceBefore=await call(owner.token,'/api/balance');
  const selfCredit={credits:1000,id:randomUUID()};
  assert.equal((await request(other.token,'/api/demo-admin/users/'+ownerId+'/credits',selfCredit)).status,403);
  assert.equal((await request(undefined,'/api/demo-admin/users/'+ownerId+'/credits',selfCredit)).status,401);
  const selfResults=await Promise.all(Array.from({length:3},()=>call(owner.token,'/api/demo-admin/users/'+ownerId+'/credits',selfCredit)));
  assert.equal(selfResults.filter(result=>result.outcome==='applied').length,1);
  assert.equal(selfResults.filter(result=>result.outcome==='duplicate').length,2);
  assert.equal((await call(owner.token,'/api/balance')).tokenCredits,ownerBalanceBefore.tokenCredits+1000);
  assert.deepEqual(await call(other.token,'/api/balance'),credited);
  assert.deepEqual(await call(owner.token,'/api/demo-admin'),budgetBefore);
  report.checks.push('admin_self_credit_is_authorized_idempotent_and_preserves_site_budget');
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
  report.stage='human_handoff'; await start(owner,true);
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
    assert.equal(snapshots.length,2);
    assert.ok(snapshots.some(output=>output.ok&&output.value?.result?.text?.includes('agentic-browser-acceptance')));
  }
  report.stage='follow_up_same_conversation';
  await start(owner,false,true);
  const followUp=await waitLease(owner,l=>l?.state==='active'&&l.control==='human');
  assert.notEqual(followUp.id,lease.id);
  assert.notEqual(followUp.taskId,lease.taskId);
  assert.notEqual(followUp.sessionId,lease.sessionId);
  const followUpGrant=await call(owner.token,browserPath(owner)+'/viewer',{revision:followUp.revision,role:'input'});
  socket=new WebSocket(origin.replace('http:','ws:')+followUpGrant.path,{origin});socket.on('error',()=>{});
  await once(socket,'open',{signal:AbortSignal.timeout(15000)});
  const followUpFrame=once(socket,'message',{signal:AbortSignal.timeout(15000)});
  socket.send(JSON.stringify({grant:followUpGrant.grant}));
  assert.ok(Buffer.from((await followUpFrame)[0]).toString('ascii').startsWith('RFB '));
  const followUpClosed=once(socket,'close',{signal:AbortSignal.timeout(30000)});
  await call(owner.token,browserPath(owner)+'/control',{revision:followUp.revision,target:'agent',operationId:randomUUID()});
  await followUpClosed;
  await waitCompleted(owner,followUp.id);
  report.checks.push('same_conversation_follow_up_creates_fresh_browser_viewer_and_completes');
  const modelStats=JSON.parse(await compose(['exec','-T','agent','node','-e',"fetch('http://fixture:9000/stats').then(r=>r.text()).then(console.log)"]));
  assert.ok(modelStats.maxSnapshotRequestBytes>32000&&modelStats.maxSnapshotRequestBytes<=262144);
  const budgetAfter=await call(owner.token,'/api/demo-admin');
  assert.ok(budgetAfter.spentCredits>0); assert.equal(budgetAfter.reservedCredits,0);
  report.checks.push('done_revokes_old_viewer_and_resumes_without_new_chat','queued_task_automatically_admitted','chat_title_and_tool_resume_share_budget','large_context_with_repeated_snapshots_resumes_and_settles');
  report.stage='restart_persistence';
  await compose(['restart','agent'],120000);
  await compose(['up','-d','--wait','--wait-timeout','120','agent'],150000);
  const loginAgain=await login(settings.adminEmail,password);
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
  owner.token=await login(settings.adminEmail,password);
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
  assert.equal((await run(['docker','ps','-q','--filter','label=dev.agentic-browser.instance='+identity])), '');
  report.checks.push('logout_revokes_viewer_releases_browser_and_prevents_worker_resume');

  await delay(6500);
  const attempts=await Promise.all(Array.from({length:8},async()=>{
    const response=await request(undefined,'/api/auth/login',{email:settings.adminEmail,password});
    const status=response.status;await response.arrayBuffer();return status;
  }));
  assert.ok(attempts.every(status=>[200,429].includes(status)));
  const limited=attempts.includes(429);
  assert.equal(limited,true,'Login limit must remain enabled in the fixture');
  await delay(6500);
  await login(settings.adminEmail,password);
  report.checks.push('login_rate_limit_enforced_and_recovers_after_window');
} finally { socket?.terminate(); }
}
