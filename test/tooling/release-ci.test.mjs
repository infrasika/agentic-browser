import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, digest } from '../../deploy/agent/lib/system.mjs';
import { temporary } from './fixtures.mjs';

const script=path.resolve('scripts/build/release-ci.mjs');
test('release collection requires both native receipts and checksums every delivered file',()=>temporary(async root=>{
  const version='v1.0.0-preview.1', commit='a'.repeat(40);
  const images=Object.fromEntries(['agent','browser','runtime','gateway','mongo','redis'].map(n=>[n,'example/'+n+'@sha256:'+'b'.repeat(64)]));
  fs.mkdirSync(path.join(root,'publication'));fs.mkdirSync(path.join(root,'delivery'));
  const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  write('publication/release.json',{version,images});write('publication/publication.json',{version,images});
  for(const arch of ['amd64','arm64']) {
    write('delivery/public-pull-'+arch+'.json',{version,images,anonymousPullVerified:true});
    write('delivery/compose-acceptance-'+arch+'.json',{passed:true,cleanup:{passed:true},version,images,packageCommit:commit,architecture:arch==='amd64'?'x64':'arm64',hostPlatform:'linux',hostNodeOnDeploymentPath:false});
  }
  const collect=()=>run([process.execPath,script,'collect'],{cwd:root,env:{...process.env,RELEASE_VERSION:version,GITHUB_REPOSITORY_OWNER:'fixture',GITHUB_SHA:commit}});
  await collect();
  const output=path.join(root,'delivery'),names=fs.readdirSync(output).sort();
  for(const name of ['compose.yaml','settings.json','secrets.env','DEPLOYMENT.md','CONFIGURATION.md','OPERATIONS.md','LICENSE','nginx.host.conf'])assert.ok(names.includes(name));
  assert.ok(!names.some(n=>n.endsWith('.tar.gz')||n==='agentctl.mjs'));
  const lines=fs.readFileSync(path.join(output,'SHA256SUMS'),'utf8').trim().split('\n');
  assert.equal(lines.length,names.length-1);
  for(const line of lines){const [hash,name]=line.split('  ');assert.equal(hash,await digest(path.join(output,name)));}
  const reportFile=path.join(root,'delivery/compose-acceptance-arm64.json'), original=JSON.parse(fs.readFileSync(reportFile));
  for(const change of [{passed:false},{cleanup:{passed:false}},{architecture:'x64'},{packageCommit:'changed'},{images:{}}]) {
    fs.writeFileSync(reportFile,JSON.stringify({...original,...change}));await assert.rejects(collect());
  }
}));
