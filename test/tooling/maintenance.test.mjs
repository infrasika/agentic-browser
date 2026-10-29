import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as ctl from '../../deploy/agent/agentctl.mjs';
import * as job from '../../deploy/agent/maintenance.mjs';
import { backupFixture, fakeInstall, temporary } from './fixtures.mjs';
const now = new Date('2026-10-28T00:00:00Z'), later = hours => new Date(now.getTime() + hours * 3600_000);
function fixture(root) {
  const install = fakeInstall(root), policy = { kind: job.POLICY, timeZone: 'Asia/Shanghai', hour: 4, keep: 2, retryMinutes: 60, copyTo: null };
  ctl.atomic(path.join(root,'config/backup.json'),policy); fs.mkdirSync(path.join(root,'backups'),{mode:0o700});
  return { install, policy };
}
test('busy retry and local date prevent repeated service interruptions', () => temporary(async root => {
  const {install} = fixture(root); let count = 0; install.idle = async () => false; install.backup = async () => {count++; return backupFixture(path.join(root,'backups/20261028T010000Z-abcdef01'));};
  assert.equal((await job.tick(install,now)).status,'deferred_busy'); assert.equal((await job.tick(install,later(.9))).status,'retry_not_due'); assert.equal(count,0);
  install.idle = async () => true; assert.equal((await job.tick(install,later(1))).status,'completed'); assert.equal((await job.tick(install,later(2))).status,'not_due'); assert.equal((await job.tick(install,later(19))).status,'not_due'); assert.equal(count,1);
}));
test('copy outage retries the same snapshot without another stop', () => temporary(async root => {
  const {install,policy} = fixture(path.join(root,'install')); const dest=path.join(root,'copies'); fs.mkdirSync(dest,{mode:0o700});
  policy.copyTo=dest; ctl.atomic(path.join(install.root,'config/backup.json'),policy); install.idle=async()=>true;
  let count=0; install.backup=async()=>{count++; const folder=await backupFixture(path.join(install.root,'backups/20261028T010000Z-abcdef01')); fs.chmodSync(dest,0o755); return folder;};
  await assert.rejects(job.tick(install,now),/maintenance_failed/); const state=ctl.readPrivate(path.join(install.root,'state/backup-status.json')); assert.equal(state.copyPending,'20261028T010000Z-abcdef01');
  fs.chmodSync(dest,0o700); assert.equal((await job.tick(install,later(1))).status,'completed'); assert.equal(count,1); assert.equal(ctl.readPrivate(path.join(install.root,'state/backup-status.json')).copyPending,null);
}));
test('retention removes only verified scheduler backups and rejects traversal', () => temporary(async root => {
  const {install,policy}=fixture(root), names=['20261028T010000Z-abcdef01','20261028T020000Z-abcdef02','20261028T030000Z-abcdef03'];
  for(const name of [...names,'manual','.pending-incomplete']) await backupFixture(path.join(root,'backups',name));
  const state={managedBackups:names}; await job.prune(install,policy,state); assert.deepEqual(state.managedBackups,names.slice(1));
  assert.ok(fs.existsSync(path.join(root,'backups/manual'))); assert.ok(fs.existsSync(path.join(root,'backups/.pending-incomplete')));
  for(const name of ['../config','/tmp/elsewhere','.pending-20261028T010000Z-abcdef01']) await assert.rejects(job.prune(install,policy,{managedBackups:[name,name,name]}));
  assert.ok(fs.existsSync(path.join(root,'config/backup.json')));
}));
test('interrupted ordinary backups recover before retry and schedule checks', () => temporary(async root => {
  const {install}=fixture(root); let recovered=0; install.recover=async()=>{recovered++;};
  ctl.atomic(install.intent,{kind:ctl.KIND,operation:'backup',phase:'stopping'}); ctl.atomic(path.join(root,'state/backup-status.json'),{lastAttemptAt:now.toISOString()});
  assert.equal((await job.tick(install,now)).status,'recovered_interrupted_backup'); assert.equal(recovered,1);
}));
test('upgrade, restore and orphan maintenance require an operator', () => temporary(async root => {
  const {install}=fixture(root); install.recover=()=>assert.fail('must not resume');
  for(const [operation,phase] of [['upgrade','drain'],['upgrade','upgrading'],['upgrade','upgrade_failed'],['restore','ready'],['restore','restoring'],['backup','unknown']]) {ctl.atomic(install.intent,{kind:ctl.KIND,operation,phase}); assert.equal((await job.tick(install,now)).status,'operator_required');}
  fs.unlinkSync(install.intent); ctl.atomic(install.gate,'maintenance'); assert.equal((await job.tick(install,now)).status,'operator_required');
}));
test('schedule emits private Node systemd units without enabling them', () => temporary(async root => {
  const {install}=fixture(root), result=await job.configure(install,{timezone:'Asia/Shanghai',hour:'4',keep:'7','retry-minutes':'60'});
  const timer=path.join(result.unitDirectory,result.timer), service=fs.readFileSync(timer.replace(/\.timer$/,'.service'),'utf8');
  assert.match(fs.readFileSync(timer,'utf8'),/Persistent=true/); assert.equal(fs.statSync(timer).mode&0o777,0o600); assert.match(service,new RegExp('User='+process.getuid())); assert.match(service,/agentctl\.mjs/); assert.doesNotMatch(service,/python|sudo/); assert.ok(fs.existsSync(path.join(root,'agentctl.mjs')));
}));
test('invalid policy, nested/symlink copy roots and invalid time zones fail', () => temporary(async root => {
  const {policy}=fixture(root); fs.mkdirSync(path.join(root,'replica'),{mode:0o700});
  for(const changes of [{hour:24},{keep:0},{retryMinutes:true},{timeZone:'../UTC'},{copyTo:path.join(root,'replica')},{copyTo:path.dirname(root)}]) assert.throws(()=>job.validate({...policy,...changes},root));
}));
test('backup policy metadata survives verified idempotent copying', () => temporary(async root => {
  const {install,policy}=fixture(path.join(root,'install')), backup=await backupFixture(path.join(install.root,'backups/20261028T010000Z-abcdef01'));
  ctl.atomic(path.join(backup,'backup.json'),'{}'); const manifest=ctl.readPrivate(path.join(backup,'manifest.json')); manifest.files['backup.json']=await ctl.digest(path.join(backup,'backup.json')); ctl.atomic(path.join(backup,'manifest.json'),manifest);
  policy.copyTo=path.join(root,'copies'); fs.mkdirSync(policy.copyTo,{mode:0o700}); await job.mirror(install,policy,backup); await job.mirror(install,policy,backup);
  assert.deepEqual(await ctl.verifyBackup(path.join(policy.copyTo,install.meta.project,path.basename(backup))),await ctl.verifyBackup(backup));
  manifest.files['unexpected.json']='a'.repeat(64); ctl.atomic(path.join(backup,'manifest.json'),manifest); await assert.rejects(ctl.verifyBackup(backup),/invalid_backup_manifest/);
}));
