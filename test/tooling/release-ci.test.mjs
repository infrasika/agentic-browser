import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, digest } from '../../deploy/agent/lib/system.mjs';
import { temporary } from './fixtures.mjs';

const script=path.resolve('scripts/build/release-ci.mjs');
for (const version of ['v1.0.0-preview.1', 'v0.1.0-rc.1']) {
test('release collection verifies native receipts and checksums for '+version,()=>temporary(async root=>{
  const commit='a'.repeat(40);
  const images=Object.fromEntries(['agent','browser','runtime','gateway','mongo','redis'].map(n=>[n,'example/'+n+'@sha256:'+'b'.repeat(64)]));
  fs.mkdirSync(path.join(root,'publication'));fs.mkdirSync(path.join(root,'delivery'));
  const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  write('publication/release.json',{version,images});write('publication/publication.json',{version,images,published:true,namespace:'fixture',toolCommit:commit});
  for(const arch of ['amd64','arm64']) {
    write('delivery/public-pull-'+arch+'.json',{version,images,anonymousPullVerified:true});
    write('delivery/compose-acceptance-'+arch+'.json',{passed:true,cleanup:{passed:true,remaining:0},version,images,packageCommit:commit,architecture:arch==='amd64'?'x64':'arm64',hostPlatform:'linux',hostNodeOnDeploymentPath:false});
  }
  const collect=()=>run([process.execPath,script,'collect'],{cwd:root,env:{...process.env,RELEASE_VERSION:version,GITHUB_REPOSITORY_OWNER:'fixture',GITHUB_REPOSITORY:'fixture/agentic-browser',GITHUB_SHA:commit}});
  await collect();
  const output=path.join(root,'delivery'),names=fs.readdirSync(output).sort();
  for(const name of ['compose.yaml','settings.json','secrets.env','DEPLOYMENT.md','CONFIGURATION.md','OPERATIONS.md','LICENSE','nginx.host.conf'])assert.ok(names.includes(name));
  assert.ok(!names.some(n=>n.endsWith('.tar.gz')||n==='agentctl.mjs'));
  const lines=fs.readFileSync(path.join(output,'SHA256SUMS'),'utf8').trim().split('\n');
  assert.equal(lines.length,names.length-1);
  for(const line of lines){const [hash,name]=line.split('  ');assert.equal(hash,await digest(path.join(output,name)));}
  const notes=fs.readFileSync(path.join(root,'release-notes.md'),'utf8');
  assert.ok(notes.includes('Agentic Browser '+version));
  assert.ok(notes.includes(version.includes('-rc.') ? 'release candidate' : 'preview'));
  assert.ok(notes.includes('https://github.com/fixture/agentic-browser/blob/'+commit+'/docs/DEPLOYMENT.md'));
  write('publication/release.json',{version:'v9.0.0-preview.1',images});await assert.rejects(collect());
  write('publication/release.json',{version,images});
  const reportFile=path.join(root,'delivery/compose-acceptance-arm64.json'), original=JSON.parse(fs.readFileSync(reportFile));
  for(const change of [{passed:false},{cleanup:{passed:false}},{architecture:'x64'},{packageCommit:'changed'},{images:{}}]) {
    fs.writeFileSync(reportFile,JSON.stringify({...original,...change}));await assert.rejects(collect());
  }
}));
}

test('merge validates staged repository references before pulling and can traverse a complete native receipt',()=>temporary(async root=>{
  const version='v1.0.0-preview.1', names=['agent','browser','runtime'];
  const packageNames={agent:'agentic-browser-agent',browser:'agentic-browser-service',runtime:'agentic-browser-runtime'};
  const callFile=path.join(root,'docker-calls.jsonl');
  fs.writeFileSync(path.join(root,'docker'),`#!${process.execPath}\nimport fs from 'node:fs'; const args=process.argv.slice(2);fs.appendFileSync(process.env.DOCKER_CALLS,JSON.stringify(args)+'\\n');if(args[0]==='image'&&args[1]==='inspect')console.log(JSON.stringify([{Id:args.at(-1).split('@')[1]}]));else if(args[0]!=='pull')process.exit(2);`,{mode:0o755});
  for(const arch of ['amd64','arm64']){
    const dir=path.join(root,'artifacts','build-'+arch);fs.mkdirSync(dir,{recursive:true});
    const id='sha256:'+(arch==='amd64'?'b':'c').repeat(64), platform='linux/'+arch;
    const report={passed:true,sourceMode:'committed',platform,sourceCommits:{browser:'a'.repeat(40),librechat:'b'.repeat(40)},librechatTree:'c'.repeat(40),images:Object.fromEntries(names.map(n=>[n,{id}]))};
    const receipt={version,namespace:'fixture',staged:true,images:Object.fromEntries(names.map(n=>[n,{platforms:{[platform]:{id,reference:'ghcr.io/fixture/'+packageNames[n]+'@'+id}}}]))};
    if(arch==='arm64')receipt.images.agent.platforms[platform].reference='ghcr.io/wrong-owner/agentic-browser-agent@'+id;
    fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report));fs.writeFileSync(path.join(dir,'publication.json'),JSON.stringify(receipt));
  }
  const result=spawnSync(process.execPath,[script,'merge'],{cwd:root,encoding:'utf8',env:{...process.env,PATH:root+path.delimiter+process.env.PATH,DOCKER_CALLS:callFile,RELEASE_VERSION:version,GITHUB_REPOSITORY_OWNER:'fixture'}});
  assert.equal(result.status,1);assert.match(result.stderr,/Invalid staged image reference: agent/);
  const calls=fs.readFileSync(callFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.length,6);assert.equal(calls.filter(c=>c[0]==='pull').length,3);
  assert(calls.filter(c=>c[0]==='pull').every(c=>c[2]==='linux/amd64'&&c[3].startsWith('ghcr.io/fixture/')));
}));
