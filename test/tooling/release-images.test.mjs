import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { bundleTools } from '../../scripts/build/bundle-tools.mjs';
import { validateReport } from '../../scripts/build/release-images.mjs';
import { run } from '../../deploy/agent/lib/system.mjs';
import { generationPending } from '../acceptance/http.mjs';
import { temporary } from './fixtures.mjs';
test('partial/uncommitted reports cannot produce releases',()=>{
  for(const report of [{},{passed:true,sourceMode:'working-tree'},{passed:true,sourceMode:'committed',images:{agent:{}}}])assert.throws(()=>validateReport(report));
});
test('compiled operations run without npm dependencies and retain bundled licenses',()=>temporary(async root=>{
  await bundleTools(root);
  assert.match(await run([process.execPath,path.join(root,'operations.mjs'),'--help'],{cwd:root,env:{PATH:'/nonexistent'}}),/docker compose/);
  const notices=fs.readFileSync(path.join(root,'LICENSES/TOOLS.txt'),'utf8');
  for(const name of ['tar','@isaacs/fs-minipass','minipass','minizlib','chownr','yallist']) assert.ok(notices.includes(name+'@'));
  assert.ok(!fs.existsSync(path.join(root,'node_modules')));
}));
test('status polling only retries the explicit generation-persistence response', () => {
  const route = '/api/agents/chat/status/conversation', body = JSON.stringify({ code: 'SERVER_NOT_READY' });
  const response = (status = 503, headers = { 'retry-after': '1' }) => new Response(body, { status, headers });
  assert.equal(generationPending(route, response(), body), true);
  for (const [url, reply, content] of [
    ['/api/config', response(), body],
    [route, response(503, { 'retry-after': '1', 'x-agent-maintenance': '1' }), body],
    [route, response(503, {}), body],
    [route, response(502), body],
    [route, response(), '{"code":"OTHER_FAILURE"}'],
    [route, response(), 'not json'],
  ]) assert.equal(generationPending(url, reply, content), false);
});
