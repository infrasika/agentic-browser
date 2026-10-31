import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { FORMAT, VOLUMES, ComposeOperations, childPath, verifyBackup, scheduledDay } from '../../deploy/compose/operations.mjs';
import { digest } from '../../deploy/agent/lib/system.mjs';

async function fixture(fn) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'compose-operations-'));
  try { await fn(root); } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
async function backup(root) {
  const data=path.join(root,'data'), folder=path.join(root,'backup');fs.mkdirSync(data);fs.mkdirSync(folder);
  fs.writeFileSync(path.join(data,'keep'),'persistent');
  for(const name of VOLUMES)await tar.c({gzip:true,cwd:data,file:path.join(folder,name+'.tar.gz')},['.']);
  for(const name of ['compose.yaml','settings.json','secrets.env'])fs.writeFileSync(path.join(folder,name),'fixture');
  const files={};for(const name of fs.readdirSync(folder))files[name]=await digest(path.join(folder,name));
  fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify({format:FORMAT,version:'test',files}));return folder;
}
test('Compose backup rejects incomplete, changed, foreign and escaping archives before restore',()=>fixture(async root=>{
  const folder=await backup(root);assert.equal((await verifyBackup(folder)).format,FORMAT);
  const file=path.join(folder,'manifest.json'), original=JSON.parse(fs.readFileSync(file));
  for(const manifest of [{...original,format:'legacy'}, {...original,files:{...original.files,'../outside':'a'.repeat(64)}}, {...original,files:{}}]) {
    fs.writeFileSync(file,JSON.stringify(manifest));await assert.rejects(verifyBackup(folder),/invalid_compose/);
  }
  fs.writeFileSync(file,JSON.stringify(original));fs.appendFileSync(path.join(folder,'secrets.env'),'changed');await assert.rejects(verifyBackup(folder),/checksum/);
}));
test('Compose backup refuses links and live browser records even with matching hashes',()=>fixture(async root=>{
  const folder=await backup(root), data=path.join(root,'data'), manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json')));
  fs.symlinkSync('/etc/passwd',path.join(data,'outside'));
  await tar.c({gzip:true,cwd:data,file:path.join(folder,'config.tar.gz')},['.']);manifest.files['config.tar.gz']=await digest(path.join(folder,'config.tar.gz'));
  fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest));await assert.rejects(verifyBackup(folder),/unsafe_backup/);
  fs.unlinkSync(path.join(data,'outside'));await tar.c({gzip:true,cwd:data,file:path.join(folder,'config.tar.gz')},['.']);manifest.files['config.tar.gz']=await digest(path.join(folder,'config.tar.gz'));
  fs.mkdirSync(path.join(data,'runtimes'));fs.writeFileSync(path.join(data,'runtimes','active.json'),'{}');
  await tar.c({gzip:true,cwd:data,file:path.join(folder,'browser-data.tar.gz')},['.']);manifest.files['browser-data.tar.gz']=await digest(path.join(folder,'browser-data.tar.gz'));
  fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest));await assert.rejects(verifyBackup(folder),/runtime_records/);
}));
test('Operation paths cannot traverse out of the deployment or follow symlinks',()=>fixture(root=>{
  for(const value of ['../outside','/tmp/outside','backup/../secrets.env','backup//file'])assert.throws(()=>childPath(root,value));
  fs.symlinkSync('/tmp',path.join(root,'link'));assert.throws(()=>childPath(root,'link/private'));
  assert.equal(childPath(root,'backups/one'),path.join(root,'backups/one'));
}));
test('Interrupted destructive operations cannot use recover to restart unverified data',()=>fixture(async root=>{
  const state=path.join(root,'state');fs.mkdirSync(state);
  const ops=new ComposeOperations({directory:root,state,command:()=>assert.fail('No Docker mutation is permitted')});
  for(const phase of ['upgrading','upgrade_failed','restoring']){
    fs.writeFileSync(ops.intent,JSON.stringify({phase}));await assert.rejects(ops.recover(),/unsafe_to_restart/);
  }
  fs.writeFileSync(ops.intent,JSON.stringify({operation:'backup',phase:'backup'}));await assert.rejects(ops.rollback(),/no_failed_upgrade/);
}));
test('Restore validates every backup checksum before touching containers or data',()=>fixture(async root=>{
  const folder=await backup(root), state=path.join(root,'state');fs.mkdirSync(state);
  fs.appendFileSync(path.join(folder,'mongo-data.tar.gz'),'changed');
  const ops=new ComposeOperations({directory:root,state,command:()=>assert.fail('No Docker mutation before verification')});
  await assert.rejects(ops.restore('backup',true),/checksum/);
}));
test('Daily backup follows the configured timezone and never repeats a completed day',()=>{
  const now=new Date('2026-10-30T20:05:00Z');
  assert.equal(scheduledDay(now,4,'Asia/Shanghai'),'2026-10-31');
  assert.equal(scheduledDay(now,4,'Asia/Shanghai','2026-10-31'),null);
  assert.equal(scheduledDay(now,5,'Asia/Shanghai'),null);
  assert.equal(scheduledDay(now,4,'UTC'),'2026-10-30');
  assert.throws(()=>scheduledDay(now,24,'UTC'));
  assert.throws(()=>scheduledDay(now,4,'Invalid/Zone'));
});
