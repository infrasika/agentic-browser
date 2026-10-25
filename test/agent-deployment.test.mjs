import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentConfiguration } from '../deploy/agent/app/config.mjs';
import { validateSettings } from '../deploy/agent/app/settings.mjs';
import { gatewayConfiguration } from '../deploy/agent/app/gateway.mjs';
const exec = promisify(execFile);
const settings = { version: 1, origin: 'http://127.0.0.1:3333', adminEmail: 'admin@example.test',
  model: { name: 'fixture', baseURL: 'http://fixture:8080/v1', promptRate: 1, completionRate: 2 },
  credits: {}, browser: {} };
const secrets = { QWEN_API_KEY: 'private-model-key', DEMO_ADMIN_PASSWORD: 'fixture-password-long',
  ...Object.fromEntries(['JWT_SECRET','JWT_REFRESH_SECRET','CREDS_KEY','CREDS_IV'].map(k=>[k,randomBytes(k==='CREDS_IV'?16:32).toString('hex')])) };
test('private settings require no Cloudflare and retain independent credits and capacity', () => {
  const { config } = validateSettings(settings, secrets);
  assert.equal(config.registration, 'closed'); assert.equal(config.browser.maximum, 1);
  assert.equal(config.credits.initial, 200000); assert.equal(config.credits.daily, 20000000);
  assert.throws(()=>validateSettings({...settings,browser:{maximum:11}},secrets));
  assert.throws(()=>validateSettings({...settings,model:{...settings.model,promptRate:-1}},secrets));
  assert.throws(()=>validateSettings({...settings,credits:{timeZone:'not-a-zone'}},secrets));
});
test('public registration requires HTTPS and a complete Turnstile key pair', () => {
  assert.throws(()=>validateSettings({...settings,registration:'public'},secrets));
  assert.throws(()=>validateSettings({...settings,origin:'https://agent.example.test',registration:'public',turnstileSiteKey:'site'},secrets));
  const { config }=validateSettings({...settings,origin:'https://agent.example.test',registration:'public',turnstileSiteKey:'site'},{...secrets,TURNSTILE_SECRET_KEY:'secret'});
  assert.equal(config.registration,'public');
  for(const origin of ['http://public.example.test','https://user:pass@example.test','https://example.test/path','https://foo$bar.example.test']) assert.throws(()=>validateSettings({...settings,origin},secrets));
});
test('the shared configuration preserves tool restrictions and never embeds private credentials', () => {
  const config=createAgentConfiguration({origin:settings.origin,model:'fixture',promptRate:1,completionRate:2,startCredits:123,dailyCredits:456,timeZone:'UTC',name:'Private Agent',starters:['Open GitHub'],browserURL:'http://browser:8081'});
  assert.equal(config.turnstile,undefined); assert.equal(config.interface.customWelcome,'Private Agent');
  assert.equal(config.interface.mcpServers.use,false); assert.equal(config.balance.startBalance,123);
  assert.equal(config.balance.siteBudget.dailyCredits,456); assert.equal(config.balance.siteBudget.timeZone,'UTC');
  assert.equal(config.browser.baseURL,'http://browser:8081');
  assert.equal(config.endpoints.custom[0].apiKey,'${QWEN_API_KEY}');
  assert.equal(config.endpoints.custom[0].titleConvo,true);
});
test('setup preserves keys and configuration, validation rejects secrets or unsafe links without echoing them', async () => {
  const dir=await mkdtemp(join(tmpdir(),'agent-init-')), script=resolve('deploy/agent/app/init.mjs');
  try {
    await exec(process.execPath,[script,'init',dir]);
    const before=await readFile(join(dir,'secrets.env'),'utf8');
    await exec(process.execPath,[script,'init',dir]);
    assert.equal(await readFile(join(dir,'secrets.env'),'utf8'),before);
    assert.equal((await stat(join(dir,'secrets.env'))).mode & 0o777,0o600);
    try { await exec(process.execPath,[script,'check',dir]); assert.fail(); }
    catch(error) { assert.equal(error.code,1); assert.ok(!`${error.stdout}${error.stderr}`.includes(before)); }
    await writeFile(join(dir,'settings.json'),JSON.stringify(settings));
    await writeFile(join(dir,'secrets.env'),Object.entries(secrets).map(([k,v])=>`${k}=${v}`).join('\n'));
    await exec(process.execPath,[script,'render',dir]);
    assert.ok((await readFile(join(dir,'nginx.conf'),'utf8')).includes('browser:8082 resolve'));
    await rm(join(dir,'secrets.env')); const outside=join(dir,'outside'); await writeFile(outside,'keep');
    await symlink(outside,join(dir,'secrets.env'));
    await assert.rejects(exec(process.execPath,[script,'check',dir]));
    assert.equal(await readFile(outside,'utf8'),'keep');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('gateway restricts the browser surface and does not trust supplied identity or forwarding headers', () => {
  const nginx=gatewayConfiguration('https://agent.example.test');
  assert.match(nginx,/location = \/browser\/v1\/observe/);
  assert.match(nginx,/location \^~ \/browser\/ \{ return 404/);
  assert.match(nginx,/proxy_set_header X-User-ID ''/);
  assert.match(nginx,/proxy_set_header X-Forwarded-Proto https/);
  assert.match(nginx,/proxy_next_upstream off/);
  assert.throws(()=>gatewayConfiguration('https://foo$bar.example.test'));
});
