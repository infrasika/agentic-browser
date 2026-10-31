import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createAgentConfiguration } from '../deploy/agent/app/config.mjs';
import { validateSettings } from '../deploy/agent/app/settings.mjs';
import { gatewayConfiguration } from '../deploy/agent/app/gateway.mjs';
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
test('gateway restricts the browser surface and does not trust supplied identity or forwarding headers', () => {
  const nginx=gatewayConfiguration('https://agent.example.test');
  assert.match(nginx,/location = \/browser\/v1\/observe/);
  assert.match(nginx,/location \^~ \/browser\/ \{ return 404/);
  assert.match(nginx,/proxy_set_header X-User-ID ''/);
  assert.match(nginx,/proxy_set_header X-Forwarded-Proto https/);
  assert.match(nginx,/proxy_next_upstream off/);
  assert.throws(()=>gatewayConfiguration('https://foo$bar.example.test'));
});

test('SMTP requires a credential pair and verification bound to sender, credentials and origin', async () => {
  const { mailConfiguration } = await import('../deploy/agent/app/mail.mjs');
  const smtp={host:'smtp.example.test',port:465,encryption:'tls',from:'agent@example.test',username:'account'};
  assert.throws(()=>validateSettings({...settings,smtp},secrets));
  assert.throws(()=>validateSettings({...settings,smtp:{...smtp,encryption:'none'}},{...secrets,SMTP_PASSWORD:'secret'}));
  const {config,credentials}=validateSettings({...settings,smtp},{...secrets,SMTP_PASSWORD:'secret'});
  const unverified=mailConfiguration(config,credentials);
  assert.equal(unverified.env.ALLOW_PASSWORD_RESET,'false');
  const receipt={fingerprint:unverified.fingerprint,accepted:true};
  assert.equal(mailConfiguration(config,credentials,receipt).env.ALLOW_PASSWORD_RESET,'true');
  assert.equal(mailConfiguration({...config,origin:'https://other.example.test'},credentials,receipt).enabled,false);
  assert.equal(mailConfiguration(config,{...credentials,SMTP_PASSWORD:'changed'},receipt).enabled,false);
});

test('only explicit trusted reverse proxies can supply client IP addresses', () => {
  const config=validateSettings({...settings,trustedProxyIPs:['172.30.0.1']},secrets).config;
  const nginx=gatewayConfiguration(config.origin,config.trustedProxyIPs);
  assert.match(nginx,/set_real_ip_from 172\.30\.0\.1;/);
  assert.match(nginx,/real_ip_header X-Real-IP/);
  assert.doesNotMatch(gatewayConfiguration(config.origin),/set_real_ip_from/);
  const ipv6=validateSettings({...settings,trustedProxyIPs:['fd00::1']},secrets).config;
  assert.match(gatewayConfiguration(ipv6.origin,ipv6.trustedProxyIPs),/set_real_ip_from fd00::1;/);
  assert.throws(()=>validateSettings({...settings,trustedProxyIPs:Array(9).fill('172.30.0.1')},secrets));
  for (const ip of ['0.0.0.0/0','127.0.0.1; return 200','example.test']) {
    assert.throws(()=>validateSettings({...settings,trustedProxyIPs:[ip]},secrets));
    assert.throws(()=>gatewayConfiguration(config.origin,[ip]));
  }
});
