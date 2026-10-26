import assert from 'node:assert/strict';
import { acceptanceRelease } from './agent/release-fixture.mjs';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
if(!process.argv.includes('--run')) { console.log('Usage: node scripts/accept-agent-operations.mjs --run --release release.json [--hold]');process.exit(0); }
const root=resolve(import.meta.dirname,'..'), id=randomUUID(), work=resolve(root,'.deployment/agent-operations',id), directory=work+'/install', restored=work+'/restored';
const report={id,passed:false,stage:'preflight',checks:[],callsPaidModel:false}, exec=promisify(execFile);
const command=async(cmd,args,options={})=>(await exec(cmd,args,{cwd:root,timeout:300000,maxBuffer:6*1024*1024,...options})).stdout.trim();
const cliPath=resolve(root,'deploy/agent/agentctl.py');
const cli=async(args,dir=directory)=>JSON.parse(await command('python3',[cliPath,'--directory',dir,...args]));
let project,cloneProject,instance,cloneInstance,interrupted=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{interrupted=true;});
const pids=()=>command('systemctl',['show','agentic-browser-service','librechat-browser-demo','--property=MainPID','--value']);
const before=await pids();
await mkdir(work,{recursive:true,mode:0o700});
const compose=(args,dir=directory)=>command('docker',['compose','--project-directory',dir,'--env-file',dir+'/.env','-f',dir+'/compose.yaml',...args]);
async function inputFile(name,data) {const file=work+'/'+name;await writeFile(file,JSON.stringify(data),{mode:0o600});return file;}
const origin='http://127.0.0.1:3335';
async function req(path,{token,body,base=origin}={}) {return fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json','user-agent':'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36','x-librechat-generation-protocol':'2',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});}
async function call(path,options) {const response=await req(path,options);assert.equal(response.status,200,`HTTP ${response.status} during ${report.stage}`);return response.json();}
const login=async(email,password,base=origin)=>(await call('/api/auth/login',{body:{email,password},base})).token;
async function dbSnapshot(dir=directory) { return JSON.parse(await compose(['exec','-T','mongo','mongosh','--quiet','--eval',`JSON.stringify(['users','balances','sitebudgets','transactions','conversations','messages'].map(name=>({name,rows:db.getSiblingDB('AgenticBrowser').getCollection(name).find({},{updatedAt:0}).sort({_id:1}).toArray()})))`],dir)); }
try {
  const memory=Number((await readFile('/proc/meminfo','utf8')).match(/^MemAvailable:\s+(\d+)/m)?.[1]);assert.ok(memory>6*1024*1024);
  const db=new DatabaseSync(resolve(root,'.data/librechat-browser/scheduler.sqlite'),{readOnly:true});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM leases WHERE state IN ('queued','starting','active','closing','cleanup_pending')").get().n,0);db.close();
  const image=async(name)=>command('docker',['image','inspect',name,'--format','{{.Id}}']);
  const releaseManifest=await acceptanceRelease(), images=releaseManifest.images;
  report.images=images;
  const release=await inputFile('release.json',releaseManifest);
  report.stage='installer';await cli(['init','--release',release,'--port','3335','--development']);
  project=JSON.parse(await readFile(directory+'/installation.json')).project;
  const beforeSecrets=await readFile(directory+'/config/secrets.env','utf8');
  await assert.rejects(cli(['init','--release',release,'--port','3335','--development']));assert.equal(await readFile(directory+'/config/secrets.env','utf8'),beforeSecrets);
  await assert.rejects(cli(['up']));
  const settings=JSON.parse(await readFile(directory+'/config/settings.json'));
  Object.assign(settings,{adminEmail:'operator-admin@example.test',model:{name:'selfhost-fixture',baseURL:'http://fixture:9000/v1',promptRate:.276,completionRate:1.101},smtp:{host:'fixture',port:2525,encryption:'tls',from:'agent@example.test',username:''}});
  await writeFile(directory+'/config/settings.json',JSON.stringify(settings),{mode:0o600});
  await writeFile(directory+'/config/secrets.env',beforeSecrets.replace('QWEN_API_KEY=','QWEN_API_KEY=fixture-no-cloud'),{mode:0o600});
  const secrets=parseEnv(await readFile(directory+'/config/secrets.env','utf8'));
  // A test-only trusted CA for the local TLS mail sink. No insecure TLS setting.
  await command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fixture','-addext','subjectAltName=DNS:fixture','-keyout',work+'/mail.key','-out',work+'/mail.crt']);
  await cp(work+'/mail.crt',directory+'/config/test-ca.pem');
  let yaml=await readFile(directory+'/compose.yaml','utf8');yaml=yaml.replace('  agent:\n','  agent:\n    environment:\n      NODE_EXTRA_CA_CERTS: /config/test-ca.pem\n');await writeFile(directory+'/compose.yaml',yaml,{mode:0o600});
  // Render before starting the fixture on the install-owned network.
  await command('python3',['-c',`import importlib.util;from pathlib import Path;s=importlib.util.spec_from_file_location('ctl',${JSON.stringify(cliPath)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.Installation(Path(${JSON.stringify(directory)})).render()`]);
  await compose(['create']);
  for(const name of ['model-fixture.mjs','mail-fixture.mjs'])await cp(resolve(root,'scripts/agent',name),work+'/'+name);
  await writeFile(work+'/fixture.mjs',"import './model-fixture.mjs'; import './mail-fixture.mjs';\n",{mode:0o600});
  await command('docker',['run','-d','--name',project+'-fixture','--network',project+'_front','--network-alias','fixture','--read-only','--user',`${process.getuid()}:${process.getgid()}`,'--cap-drop=ALL','--security-opt=no-new-privileges','--memory=192m','--cpus=.5','-v',work+':/fixtures:ro','--entrypoint=node',images.agent,'/fixtures/fixture.mjs']);
  await cli(['up']);instance=await compose(['exec','-T','browser','cat','/data/runtimes/instance-id']);
  report.checks.push('installer_requires_configuration_preserves_secrets_and_generates_env_from_settings');
  report.stage='account_commands';
  const user={email:'operator-user@example.test',name:'Operator User',username:'operator-user',password:'Synthetic-Password-2026!'};
  const userInput=await inputFile('user-input.json',user);
  assert.equal((await cli(['user-create','--input-file',userInput])).status,'created');
  let token=await login(user.email,user.password);const balance=await call('/api/balance',{token});
  assert.equal(balance.tokenCredits,200000);
  assert.equal((await cli(['user-create','--input-file',userInput])).status,'already_exists');
  assert.deepEqual(await call('/api/balance',{token}),balance);
  assert.equal((await req('/api/demo-admin',{token})).status,403);
  const newPassword='Synthetic-New-Password-2026!';
  await cli(['user-reset','--input-file',await inputFile('reset-input.json',{email:user.email,password:newPassword})]);
  assert.equal((await req('/api/user',{token})).status,401);
  token=await login(user.email,newPassword);assert.deepEqual(await call('/api/balance',{token}),balance);
  report.checks.push('native_ordinary_user_creation_is_idempotent_and_gives_initial_credits_once','operator_password_recovery_revokes_old_token_without_changing_balance');
  report.stage='smtp';assert.equal((await call('/api/config')).emailEnabled,false);
  const accepted=await cli(['mail-test','--to','capture@example.test']);assert.equal(accepted.accepted,true);
  await cli(['apply']);
  assert.equal((await call('/api/config')).emailEnabled,true);
  await call('/api/auth/requestPasswordReset',{body:{email:user.email}});
  const captured=JSON.parse(await compose(['exec','-T','agent','node','-e',"fetch('http://fixture:9001').then(r=>r.text()).then(console.log)"]));
  assert.ok(captured.messages.length>=2);
  await writeFile(work+'/private-mail.json',JSON.stringify(captured),{mode:0o600});
  const text=captured.messages.flatMap(message=>message.split(/\r\n--[^\r\n]+/).map(part=>{
    const split=part.indexOf('\r\n\r\n');if(split<0)return part;
    const headers=part.slice(0,split),content=part.slice(split+4);
    return /Content-Transfer-Encoding: base64/i.test(headers)?Buffer.from(content.replace(/\s/g,''),'base64').toString():content.replace(/=\r\n/g,'').replace(/=([0-9A-F]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
  })).join('\n').replace(/&#x([0-9a-f]+);/gi,(_,hex)=>String.fromCodePoint(parseInt(hex,16))).replace(/&#(\d+);/g,(_,number)=>String.fromCodePoint(Number(number))).replace(/&amp;/g,'&');
  const link=text.match(/http:\/\/127\.0\.0\.1:3335\/reset-password\?token=[^\s"'<>]+/g)?.at(-1);assert.ok(link);
  const url=new URL(link),reset={userId:url.searchParams.get('userId'),token:url.searchParams.get('token'),password:'Mail-Recovered-Password-2026!',confirm_password:'Mail-Recovered-Password-2026!'};
  await call('/api/auth/resetPassword',{body:reset});assert.notEqual((await req('/api/auth/resetPassword',{body:reset})).status,200);
  assert.equal((await req('/api/user',{token})).status,401);token=await login(user.email,reset.password);
  assert.deepEqual(await call('/api/balance',{token}),balance);
  report.checks.push('verified_tls_smtp_enables_native_reset_single_use_and_revokes_old_login');
  report.stage='busy_backup';
  const adminToken=await login(settings.adminEmail,secrets.DEMO_ADMIN_PASSWORD);
  const messageId=randomUUID();const start=await call('/api/agents/chat',{token:adminToken,body:{text:'Open https://httpbin.org/anything/agentic-browser-acceptance and let me take control.',sender:'User',isCreatedByUser:true,parentMessageId:'00000000-0000-0000-0000-000000000000',conversationId:'new',messageId,responseMessageId:messageId+'_',endpoint:'agents',agent_id:'agent_browser_demo',spec:'browser-demo',isTemporary:false,isRegenerate:false}});
  let lease;for(let i=0;i<100;i++){lease=(await call('/api/agentic-browser/'+start.conversationId,{token:adminToken})).lease;if(lease?.control==='human')break;await delay(700);}
  assert.equal(lease.control,'human');await assert.rejects(cli(['backup']));assert.equal((await req('/api/config')).status,200);
  await call('/api/agentic-browser/'+start.conversationId+'/control',{token:adminToken,body:{revision:lease.revision,target:'agent',operationId:randomUUID()}});
  for(let i=0;i<100;i++){if(!(await call('/api/agents/chat/status/'+start.conversationId,{token:adminToken})).active)break;await delay(700);}
  await delay(1500);
  report.checks.push('active_handoff_defers_backup_without_interrupting_task');
  report.stage='backup_restore';
  const original=await dbSnapshot();assert.ok(original.find(c=>c.name==='sitebudgets').rows.length>0);assert.ok((await call('/api/demo-admin',{token:adminToken})).spentCredits>0);const backup=(await cli(['backup'])).backup;
  assert.equal((await cli(['verify-backup',backup])).verified,true);
  assert.equal((await cli(['doctor'])).healthy,true);
  await cli(['restore',backup,'--port','3336','--development'],restored);
  cloneProject=JSON.parse(await readFile(restored+'/installation.json')).project;
  await command('docker',['network','connect','--alias','fixture',cloneProject+'_front',project+'-fixture']);
  // Disable the copied test SMTP profile; restored origin intentionally invalidates receipt.
  const cloneSettings=JSON.parse(await readFile(restored+'/config/settings.json'));delete cloneSettings.smtp;await writeFile(restored+'/config/settings.json',JSON.stringify(cloneSettings),{mode:0o600});
  await cli(['recover'],restored);cloneInstance=await compose(['exec','-T','browser','cat','/data/runtimes/instance-id'],restored);assert.notEqual(cloneInstance,instance);
  assert.deepEqual(await dbSnapshot(restored),original);
  const cloneToken=await login(user.email,reset.password,'http://127.0.0.1:3336');assert.deepEqual(await call('/api/balance',{token:cloneToken,base:'http://127.0.0.1:3336'}),balance);
  await assert.rejects(cli(['restore',backup,'--port','3336','--development'],restored));
  report.checks.push('offline_volume_backup_verified_and_restored_into_fresh_project','restored_accounts_chats_credits_budget_unchanged_and_runtime_identity_is_new','restore_refuses_existing_installation');
  report.stage='upgrade';
  const upgraded=await cli(['upgrade','--release',release,'--development']);assert.equal(upgraded.status,'upgraded');assert.deepEqual(await dbSnapshot(),original);
  const broken=await inputFile('broken-release.json',{version:'invalid-agent-test',images:{...images,agent:await image('node:24.22.1-bookworm-slim')}});
  await assert.rejects(cli(['upgrade','--release',broken,'--development']));
  assert.equal((await req('/api/config')).status,503);
  await assert.rejects(cli(['recover']));
  report.checks.push('upgrade_preserves_data_and_takes_backup','failed_upgrade_keeps_maintenance_and_prevents_unsafe_rollback');
  // Keep the healthy restored instance for UI; the intentionally failed source is not reopened.
  report.passed=true;
  if(process.argv.includes('--hold')){console.log(JSON.stringify({uiReady:true,origin:'http://127.0.0.1:3336',work}));while(!interrupted)await delay(1000);}
} catch(error){report.failure='operations_acceptance_failed';await writeFile(work+'/private-error.log',String(error.stack),{mode:0o600});}
finally {
  for(const [dir,p] of [[restored,cloneProject],[directory,project]]) if(p){try{await writeFile(work+'/'+p+'-logs.txt',await compose(['logs','--no-color','--tail','60'],dir),{mode:0o600});}catch{}}
  if(project)await command('docker',['rm','-f',project+'-fixture']).catch(()=>{});
  for(const [dir,p] of [[restored,cloneProject],[directory,project]])if(p)await compose(['down','--volumes','--remove-orphans'],dir).catch(()=>{});
  const remaining=[];for(const p of [project,cloneProject].filter(Boolean)){
    const ids=await command('docker',['ps','-aq','--filter','label=com.docker.compose.project='+p]);if(ids)remaining.push(p);
    const volumes=await command('docker',['volume','ls','-q','--filter','label=com.docker.compose.project='+p]);if(volumes)remaining.push(p+'-volumes');
    const helpers=await command('docker',['ps','-aq','--filter','label=dev.agentic-browser.operation='+p]);if(helpers)remaining.push(p+'-helpers');
  }
  for(const identity of [instance,cloneInstance].filter(Boolean)){const ids=await command('docker',['ps','-aq','--filter','label=dev.agentic-browser.instance='+identity]);if(ids)remaining.push(identity);}
  report.cleanup={passed:remaining.length===0,remaining:remaining.length};report.productionUnchanged=(await pids())===before;
  report.passed=report.passed&&report.cleanup.passed&&report.productionUnchanged;report.completedAt=new Date().toISOString();
  await mkdir(resolve(root,'output/agent'),{recursive:true});await writeFile(resolve(root,'output/agent/operations-'+id+'.json'),JSON.stringify(report,null,2)+'\n');await writeFile(resolve(root,'output/agent/operations-latest.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));if(report.passed)await rm(work,{recursive:true,force:true});
}
process.exit(report.passed?0:1);
