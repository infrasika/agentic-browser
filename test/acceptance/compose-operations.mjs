import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeCompose} from '../../scripts/build/package-compose.mjs';
import {run, sleep} from '../../deploy/agent/lib/system.mjs';

export async function verifyOperations({compose, deployment, release, env, port, development, checks}) {
  const ops=async (...args)=>{console.log('Compose operations: '+args[0]);return JSON.parse(await compose('run','--rm','-T','ops',...args));};
  const account=async (action,input)=>{
    const output=await run(['docker','compose','run','--rm','-T','ops',action],{cwd:deployment,env,input:JSON.stringify(input),timeout:120000});return JSON.parse(output);
  };
  const snapshot=async command=>JSON.parse(await command('exec','-T','mongo','mongosh','--quiet','--eval',"print(EJSON.stringify(['users','balances','sitebudgets','transactions','conversations','messages'].map(name=>({name,rows:db.getSiblingDB('AgenticBrowser').getCollection(name).find({},{updatedAt:0}).sort({_id:1}).toArray()}))));"));
  const identity=async command=>(await command('exec','-T','agent','node','-e',"console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/config/identity.json')).digest('hex'))")).trim();
  assert.equal((await ops('status')).healthy,true);
  const suffix=randomUUID().slice(0,8);
  const user={email:'operations-'+suffix+'@example.test',password:'Initial-Operations-2026!',name:'Operations test',username:'operations_'+suffix};
  assert.equal((await account('user-create',user)).status,'created');
  const password='Reset-Operations-2026!';
  assert.equal((await account('user-reset',{email:user.email,password})).sessionsRevoked,true);
  const authenticate=async value=>fetch('http://127.0.0.1:'+port+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:'http://127.0.0.1:'+port},body:JSON.stringify({email:user.email,password:value})});
  let response=await authenticate(user.password);assert.ok([401,404].includes(response.status),'Old password must be rejected');await response.arrayBuffer();
  response=await authenticate(password);assert.equal(response.status,200);await response.arrayBuffer();
  checks.push('container_account_creation_and_password_reset');
  const before=await snapshot(compose), key=await identity(compose);
  const backup=await ops('backup');assert.equal(backup.status,'backed_up');assert.equal((await ops('verify-backup',backup.backup)).verified,true);
  assert.deepEqual(await snapshot(compose),before);assert.equal(await identity(compose),key);
  const root=path.join(deployment,'releases','test');fs.mkdirSync(root,{recursive:true});
  const original=fs.readFileSync(path.join(deployment,'compose.yaml'),'utf8');fs.writeFileSync(path.join(root,'compose.yaml'),original);
  assert.equal((await ops('upgrade','releases/test/compose.yaml')).status,'upgraded');
  assert.deepEqual(await snapshot(compose),before);assert.equal(await identity(compose),key);
  checks.push('container_consistent_backup_and_upgrade_preserve_data_and_identity');
  const broken=original.replace('entrypoint: [node, /app/selfhost/compose-init.mjs]', "entrypoint: [node, -e, 'process.exit(1)']");assert.notEqual(broken,original);
  fs.writeFileSync(path.join(root,'compose.yaml'),broken);
  await assert.rejects(ops('upgrade','releases/test/compose.yaml'));
  const failed=await ops('status');assert.equal(failed.operation.phase,'upgrade_failed');assert.equal(failed.maintenance,true);
  await assert.rejects(ops('recover'));
  assert.equal((await ops('rollback')).status,'rolled_back');assert.deepEqual(await snapshot(compose),before);assert.equal(await identity(compose),key);
  checks.push('failed_upgrade_stays_closed_and_rollback_restores_full_backup');
  // Kill the one-off controller while writers are stopped and volume archives
  // are being created. Recovery must release its kernel lock and orphan helper.
  const job=env.COMPOSE_PROJECT_NAME+'-interrupted';
  const pending=compose('run','--rm','--name',job,'ops','backup').then(()=>false,()=>true);
  let found=false;
  for(let n=0;n<1500;n++){
    if(fs.readdirSync(path.join(deployment,'backups')).some(x=>x.startsWith('.pending-'))){found=true;break;}
    await sleep(20);
  }
  assert(found,'Did not observe archive window');await run(['docker','kill',job]);assert.equal(await pending,true);
  assert.equal((await ops('recover')).status,'recovered');assert.deepEqual(await snapshot(compose),before);assert.equal(await identity(compose),key);
  checks.push('killed_backup_controller_recovers_lock_helpers_and_services');
  const restored=path.join(deployment,'restore-test');writeCompose(release,restored,{development});
  fs.mkdirSync(path.join(restored,'backups'));fs.cpSync(path.join(deployment,backup.backup),path.join(restored,'backups','copy'),{recursive:true});
  for(const name of ['compose.override.yaml','model-fixture.mjs'])fs.copyFileSync(path.join(deployment,name),path.join(restored,name));
  const restoreProject='restore-'+randomUUID().slice(0,12), restoreEnv={...env,COMPOSE_PROJECT_NAME:restoreProject,AGENT_CONFIG_DIR:restored,AGENT_PORT:String(port+1)};
  const restoredCompose=(...args)=>run(['docker','compose',...args],{cwd:restored,env:restoreEnv,timeout:360000});
  try {
    assert.equal(JSON.parse(await restoredCompose('run','--rm','ops','restore','backups/copy')).status,'restored_stopped');
    const settings=JSON.parse(fs.readFileSync(path.join(restored,'settings.json')));settings.origin='http://127.0.0.1:'+(port+1);fs.writeFileSync(path.join(restored,'settings.json'),JSON.stringify(settings));
    assert.equal(JSON.parse(await restoredCompose('run','--rm','ops','recover')).status,'recovered');
    assert.deepEqual(await snapshot(restoredCompose),before);assert.equal(await identity(restoredCompose),key);
    await assert.rejects(restoredCompose('run','--rm','ops','restore','backups/copy'));
    const checksumFile=path.join(restored,'backups','copy','secrets.env');fs.appendFileSync(checksumFile,'\nCORRUPTION=1');
    await assert.rejects(restoredCompose('run','--rm','ops','restore','backups/copy','--replace'));
    assert.equal(JSON.parse(await restoredCompose('run','--rm','ops','status')).healthy,true);assert.deepEqual(await snapshot(restoredCompose),before);
    checks.push('new_project_restore_preserves_identity_data_and_rejects_corrupt_overwrite');
  } finally {
    await restoredCompose('--profile','*','down','--volumes','--remove-orphans');
    for(const args of [['ps','-aq'],['volume','ls','-q'],['network','ls','-q']])assert.equal(await run(['docker',...args,'--filter','label=com.docker.compose.project='+restoreProject]),'');
  }
  const scheduler=(...args)=>run(['docker','compose',...args],{cwd:deployment,env:{...env,AGENT_BACKUP_HOUR:'0',AGENT_BACKUP_KEEP:'2'},timeout:360000});
  await scheduler('up','-d','--no-deps','backup');
  try {
    let receipt;
    for(let n=0;n<120;n++){
      try { receipt=(await ops('status')).dailyBackup; } catch {}
      if(receipt?.completedAt)break;await sleep(1000);
    }
    assert.ok(receipt?.completedAt,'Scheduled backup did not complete');
    const archives=fs.readdirSync(path.join(deployment,'backups')).filter(x=>/^\d{8}T\d{6}Z-/.test(x));assert.equal(archives.length,2);
    await scheduler('stop','backup');await scheduler('up','-d','--no-deps','backup');await sleep(2000);
    assert.equal((await ops('status')).dailyBackup.backup,receipt.backup);
    assert.deepEqual(await snapshot(compose),before);assert.equal(await identity(compose),key);
    checks.push('daily_backup_container_retention_and_same_day_restart_deduplication');
  } finally {await scheduler('stop','backup');}
}
