import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED, verify } from '../../deploy/agent/bundle.mjs';
import { bundleTools } from '../../scripts/build/bundle-tools.mjs';
import { validateReport, platformReference, inspectImage, FILES } from '../../scripts/build/package-agent.mjs';
import { digest, run, walk } from '../../deploy/agent/lib/system.mjs';
import { hostPlatform } from '../../deploy/agent/agentctl.mjs';
import { temporary } from './fixtures.mjs';
async function sums(root) {let value='';for(const file of walk(root).sort())if(fs.lstatSync(file).isFile()&&path.basename(file)!=='SHA256SUMS')value+=`${await digest(file)}  ${path.relative(root,file)}\n`;fs.writeFileSync(path.join(root,'SHA256SUMS'),value);}
async function fixture(root) {
  for(const name of [...REQUIRED,'images.tar.gz']) {const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');}
  const images=Object.fromEntries(['agent','browser','runtime','gateway','mongo','redis'].map(n=>[n,'sha256:'+'a'.repeat(64)]));
  fs.writeFileSync(path.join(root,'release.json'),JSON.stringify({version:'v1.0.0',images}));fs.writeFileSync(path.join(root,'BUILD.json'),JSON.stringify({version:'v1.0.0',distribution:'offline-candidate',images:Object.fromEntries(Object.entries(images).map(([k,id])=>[k,{id,platform:'linux/amd64'}]))}));await sums(root);
}
test('complete bundle accepts one architecture and rejects changed or extra files',()=>temporary(async root=>{
  await fixture(root); assert.equal((await verify(root)).version,'v1.0.0'); fs.writeFileSync(path.join(root,'README.md'),'tampered'); await assert.rejects(verify(root),/checksum/); await sums(root);
  fs.writeFileSync(path.join(root,'secret.env'),'private'); await assert.rejects(verify(root),/unexpected/);
}));
test('unsafe checksum paths, duplicates and symlinks fail',()=>temporary(async root=>{
  await fixture(root); const file=path.join(root,'SHA256SUMS'), original=fs.readFileSync(file,'utf8');
  for(const value of [original+original.split('\n')[0]+'\n','a'.repeat(64)+'  ../outside\n','a'.repeat(64)+'  /outside\n']){fs.writeFileSync(file,value);await assert.rejects(verify(root));}
  fs.writeFileSync(file,original); fs.symlinkSync(path.join(root,'README.md'),path.join(root,'linked'));await assert.rejects(verify(root),/symlink/);
}));
test('tools, licenses and configuration guide must be distributed',()=>temporary(async root=>{
  for(const name of ['CONFIGURATION.md','agentctl.mjs','acceptance/verify.mjs','LICENSES/TOOLS.txt']) {
    await fixture(root); fs.unlinkSync(path.join(root,name)); await sums(root); await assert.rejects(verify(root),/incomplete/);
  }
}));
test('mixed platforms and mutable registry refs fail verification',()=>temporary(async root=>{
  await fixture(root); const file=path.join(root,'BUILD.json'), build=JSON.parse(fs.readFileSync(file));build.images.agent.platform='linux/arm64';fs.writeFileSync(file,JSON.stringify(build));await sums(root);await assert.rejects(verify(root),/mixed/);
  for(const entry of Object.values(build.images))entry.platform='linux/arm64';fs.writeFileSync(file,JSON.stringify(build));await sums(root);await verify(root);
  build.distribution='registry-candidate';fs.writeFileSync(file,JSON.stringify(build));await sums(root);await assert.rejects(verify(root),/immutable/);
}));
test('partial/uncommitted reports cannot produce releases',()=>{
  for(const report of [{},{passed:true,sourceMode:'working-tree'},{passed:true,sourceMode:'committed',images:{agent:{}}}])assert.throws(()=>validateReport(report));
});
test('platform selection needs exactly one matching manifest',async()=>{
  const child={digest:'sha256:'+'b'.repeat(64),platform:{os:'linux',architecture:'arm64'}};
  for(const entries of [[],[child,child]]) await assert.rejects(platformReference('example/image@sha256:'+'a'.repeat(64),'linux/arm64',async()=>JSON.stringify({manifests:entries})),/unique/);
  assert.equal(await platformReference('example/image@sha256:'+'a'.repeat(64),'linux/arm64',async()=>JSON.stringify({manifests:[child]})),'example/image@'+child.digest);
});
test('official images are pulled by child digest before platform inspect/export',async()=>{
  const calls=[],digest='sha256:'+'c'.repeat(64),command=async args=>{calls.push(args);if(args.includes('imagetools'))return JSON.stringify({manifests:[{digest,platform:{os:'linux',architecture:'arm64'}}]});return args.includes('inspect')?'[{"Id":"fixture"}]':'';};
  assert.equal((await inspectImage('mongo','mongo@sha256:'+'a'.repeat(64),'linux/arm64',command)).Id,'fixture');assert.deepEqual(calls[1],['docker','pull','--platform','linux/arm64','mongo@'+digest]);assert.ok(calls[2].includes('linux/arm64'));
});
test('installer accepts native Linux amd64/arm64 and refuses desktop or unsupported CPUs',()=>{
  assert.equal(hostPlatform('linux','x64'),'linux/amd64');assert.equal(hostPlatform('linux','arm64'),'linux/arm64');for(const [os,arch]of[['darwin','arm64'],['linux','ia32']])assert.throws(()=>hostPlatform(os,arch));
});
test('compiled release tools run outside the repository with no npm dependencies',()=>temporary(async root=>{
  await bundleTools(root);
  for(const file of ['agentctl.mjs','bundle.mjs','acceptance/verify.mjs']) assert.ok((await run([process.execPath,path.join(root,file),'--help'],{cwd:root,env:{PATH:'/nonexistent'}})).length);
  assert.match(fs.readFileSync(path.join(root,'LICENSES/TOOLS.txt'),'utf8'),/tar@/);assert.ok(!fs.existsSync(path.join(root,'node_modules')));
  assert.equal(FILES['README.md'],'deploy/agent/INSTALL.md');
}));
