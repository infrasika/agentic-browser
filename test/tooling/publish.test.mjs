import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import * as publisher from '../../scripts/build/publish-agent-images.mjs';
import { INFRA } from '../../scripts/build/package-agent.mjs';
import { run, sha } from '../../deploy/agent/lib/system.mjs';
import { temporary } from './fixtures.mjs';
function fixture() {
  const prepared={version:'v1.0.0',platforms:['linux/amd64','linux/arm64'],images:{},infrastructure:INFRA},images=new Map(),remote=new Map(),calls=[];
  for(const [i,name]of Object.keys(publisher.NAMES).entries()) {
    const target='ghcr.io/example/'+publisher.NAMES[name]+':v1.0.0';prepared.images[name]={target,platforms:{}};
    for(const [j,platform]of prepared.platforms.entries()){const id='sha256:'+String(i+1).repeat(63)+j;prepared.images[name].platforms[platform]={id,target:target+'-'+platform.split('/')[1]};images.set(id,{Id:id,RepoDigests:[]});}
  }
  const registry={manifest:async(repo,ref)=>remote.get(repo+'@'+ref)??null};
  const docker=async args=>{
    calls.push(args);
    if(args[1]==='push'){
      const target=args[2],item=Object.values(prepared.images).flatMap(i=>Object.values(i.platforms)).find(i=>i.target===target),[repo,tag]=target.slice(8).split(':');
      const value=[item.id,{config:{digest:item.id}}];remote.set(repo+'@'+tag,value);remote.set(repo+'@'+item.id,value);images.set('ghcr.io/'+repo+'@'+item.id,images.get(item.id));
    }
    if(args.slice(1,4).join(' ')==='buildx imagetools create'){
      const [repo,tag]=args[5].slice(8).split(':');remote.set(repo+'@'+tag,['sha256:'+'d'.repeat(64),{manifests:args.slice(6).map((ref,i)=>({digest:ref.split('@')[1],platform:{os:'linux',architecture:prepared.platforms[i].split('/')[1]}}))}]);
    }
    return '';
  };
  return {prepared,images,remote,calls,registry,docker};
}
test('publication preflights every final and architecture tag before uploading',async()=>{
  for(const architecture of [false,true]){
    const f=fixture();f.remote.set('example/agentic-browser-runtime@v1.0.0'+(architecture?'-arm64':''),['sha256:'+'e'.repeat(64),{config:{digest:'sha256:'+'f'.repeat(64)}}]);
    await assert.rejects(publisher.publish(f.prepared,f.registry,f.docker,ref=>f.images.get(ref)),/another image/);assert.equal(f.calls.length,0);
  }
});
test('publishes six exact children and three indices, resumes without repushing',async()=>{
  const f=fixture(),[release,receipt]=await publisher.publish(f.prepared,f.registry,f.docker,ref=>f.images.get(ref));
  assert.equal(Object.keys(release.images).length,6);assert.equal(f.calls.filter(c=>c[1]==='push').length,6);assert.equal(f.calls.filter(c=>c[1]==='buildx').length,3);assert.equal(receipt.published,true);assert.equal(receipt.anonymousPullVerified,false);
  f.calls.length=0;assert.deepEqual((await publisher.publish(f.prepared,f.registry,f.docker,ref=>f.images.get(ref)))[0],release);assert.ok(!f.calls.some(c=>['push','tag'].includes(c[1])));
});
test('incomplete architecture index and changed pullback identity stop release',async()=>{
  let f=fixture();await publisher.publish(f.prepared,f.registry,f.docker,ref=>f.images.get(ref));f.remote.get('example/agentic-browser-agent@v1.0.0')[1].manifests.pop();f.calls.length=0;
  await assert.rejects(publisher.publish(f.prepared,f.registry,f.docker,ref=>f.images.get(ref)),/another image/);assert.equal(f.calls.length,0);
  f=fixture();await assert.rejects(publisher.publish(f.prepared,f.registry,f.docker,ref=>ref.includes('@')?{Id:'sha256:'+'f'.repeat(64)}:f.images.get(ref)),/Pulled image/);assert.equal(f.calls.filter(c=>c[1]==='push').length,1);
});
test('authorization failure never means a tag is available',async t=>{
  for(const status of [401,403,404,500]){
    t.mock.method(globalThis,'fetch',async()=>new Response('',{status}));
    await assert.rejects(new publisher.Registry(['fixture','fixture-secret']).manifest('example/image','v1'),/unknown/);t.mock.restoreAll();
  }
});
test('registry checks manifest digests and only accepts manifest 404 as absent',async t=>{
  let request=0;t.mock.method(globalThis,'fetch',async()=>++request%2?Response.json({token:'fixture'}):new Response('',{status:404}));
  assert.equal(await new publisher.Registry().manifest('example/image','v1'),null);t.mock.restoreAll();
  const body=JSON.stringify({schemaVersion:2}),digest='sha256:'+sha(body);request=0;
  t.mock.method(globalThis,'fetch',async()=>++request%2?Response.json({token:'fixture'}):new Response(body,{headers:{'Docker-Content-Digest':digest}}));
  assert.equal((await new publisher.Registry().manifest('example/image','v1'))[0],digest);t.mock.restoreAll();
});
test('plan rejects mixed sources, duplicate platforms and wrong image architecture',async()=>{
  const report={passed:true,sourceMode:'committed',platform:'linux/amd64',sourceCommits:{browser:'a'.repeat(40),librechat:'b'.repeat(40)},librechatTree:'c'.repeat(40),images:Object.fromEntries(Object.keys(publisher.NAMES).map((n,i)=>[n,{id:'sha256:'+String(i+1).repeat(64)}]))};
  const deps={command:async()=>'a'.repeat(40),validateSources:async()=>{},imageInfo:async Id=>({Id,Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':'a'.repeat(40),'dev.agentic-browser.librechat-revision':'b'.repeat(40),'dev.agentic-browser.librechat-tree':'c'.repeat(40)}}})};
  await assert.rejects(publisher.plan([report,report],'v1.0.0','example',deps),/Duplicate/);
  const arm=structuredClone(report);arm.platform='linux/arm64';await assert.rejects(publisher.plan([report,arm],'v1.0.0','example',deps),/platform mismatch/);
  arm.sourceCommits.browser='f'.repeat(40);await assert.rejects(publisher.plan([report,arm],'v1.0.0','example',deps),/same source/);
});
test('credential helper is reused without saving its secret',()=>temporary(async root=>{
  const config=path.join(root,'config.json'),helper=path.join(root,'docker-credential-osxkeychain');
  const original=JSON.stringify({credsStore:'desktop',credHelpers:{'ghcr.io':'osxkeychain'}});fs.writeFileSync(config,original);
  fs.writeFileSync(helper,`#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(input!=='ghcr.io\\n')process.exit(2);console.log(JSON.stringify({Username:'fixture',Secret:'fixture-secret'}));});`,{mode:0o755});
  const before={PATH:process.env.PATH,DOCKER_CONFIG:process.env.DOCKER_CONFIG};process.env.PATH=root+path.delimiter+before.PATH;process.env.DOCKER_CONFIG=root;
  try{assert.deepEqual(await publisher.credentials(),['fixture','fixture-secret']);assert.equal(fs.readFileSync(config,'utf8'),original);assert.equal(fs.readdirSync(root).length,2);}
  finally{process.env.PATH=before.PATH;if(before.DOCKER_CONFIG===undefined)delete process.env.DOCKER_CONFIG;else process.env.DOCKER_CONFIG=before.DOCKER_CONFIG;}
}));
test('child failures never expose credential helper output',async()=>{
  await assert.rejects(run([process.execPath,'-e',"process.stdout.write('fixture-secret');process.stderr.write('fixture-secret');process.exit(1)"]),error=>!String(error).includes('fixture-secret'));
});
test('anonymous verification refuses extra services and replaced infrastructure',async()=>{
  const refs={...Object.fromEntries(Object.keys(publisher.NAMES).map(n=>[n,'ghcr.io/example/image@sha256:'+'a'.repeat(64)])),...INFRA};
  for(const images of [{...refs,extra:'untrusted:latest'},{...refs,mongo:'untrusted:latest'}])await assert.rejects(publisher.verifyPublic({images}));
});
