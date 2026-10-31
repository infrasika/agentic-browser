import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, resolvePublicTarget } from '../src/egress-policy.js';

test('egress: special/private address ranges and alternate localhost encodings are denied', async () => {
  for (const address of ['0.0.0.0', '10.2.3.4', '100.64.1.1', '127.0.0.1', '169.254.169.254', '172.17.0.1', '192.168.0.1', '192.0.2.2', '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::', '3fff::1', 'not-an-address']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const value of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://1.1.1.1:2375/', 'http://user:password@1.1.1.1/', 'file:///etc/passwd']) await assert.rejects(resolvePublicTarget(new URL(value)));
});

test('egress: every DNS answer is checked and the dial target is pinned; management aliases fail closed', async () => {
  await assert.rejects(resolvePublicTarget(new URL('https://synthetic.invalid'), async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]));
  let calls = 0;
  const resolved = await resolvePublicTarget(new URL('https://synthetic.invalid'), async () => { calls++; return [{ address: '1.1.1.1', family: 4 }]; });
  assert.equal(resolved.address, '1.1.1.1'); assert.equal(calls, 1);
  await assert.rejects(resolvePublicTarget(new URL('https://control.invalid'), async () => [{ address: '1.1.1.1', family: 4 }], ['control.invalid']));
  await assert.rejects(resolvePublicTarget(new URL('https://1.1.1.1'), async () => [{ address: '1.1.1.1', family: 4 }], ['control.invalid']));
  await assert.rejects(resolvePublicTarget(new URL('https://1.1.1.1'), async () => { throw new Error('DNS failure'); }, ['control.invalid']));
  await assert.rejects(resolvePublicTarget(new URL('https://1.1.1.1'), async () => [], ['control.invalid']));
  await assert.rejects(resolvePublicTarget(new URL('https://[2606:4700:4700::1111]'), async () => [{ address: '2606:4700:4700:0:0:0:0:1111', family: 6 }], ['control.invalid']));
  await assert.rejects(resolvePublicTarget(new URL('https://[2606:4700:4700::1111]'), async () => [], ['2606:4700:4700:0:0:0:0:1111']));
});

test('egress: unrelated hostnames may share management CDN addresses without resolving the management hostname', async () => {
  for (const addresses of [
    [{ address: '104.26.0.214', family: 4 }],
    [{ address: '2606:4700:20::681a:d6', family: 6 }],
    [{ address: '104.26.0.214', family: 4 }, { address: '2606:4700:20::681a:d6', family: 6 }],
  ]) {
    const queries: string[] = [];
    const target = await resolvePublicTarget(new URL('https://portal.example/'), async host => {
      queries.push(host);
      return addresses;
    }, ['agent.example']);
    assert.equal(target.hostname, 'portal.example');
    assert.equal(target.address, addresses[0].address);
    assert.deepEqual(queries, ['portal.example']);
  }
});

test('egress: a management DNS outage does not block unrelated named websites', async () => {
  const target = await resolvePublicTarget(new URL('https://portal.example/'), async host => {
    if (host === 'agent.example') throw new Error('Management DNS unavailable');
    return [{ address: '1.1.1.1', family: 4 }];
  }, ['agent.example']);
  assert.equal(target.address, '1.1.1.1');
});

test('egress: management hostnames are blocked with case and trailing-dot variations before DNS', async () => {
  for (const blocked of ['agent.example', 'AGENT.EXAMPLE', 'agent.example.']) {
    for (const hostname of ['agent.example', 'AGENT.EXAMPLE', 'agent.example.']) {
      let queried = false;
      await assert.rejects(resolvePublicTarget(new URL(`https://${hostname}/`), async () => {
        queried = true;
        return [{ address: '1.1.1.1', family: 4 }];
      }, [blocked]), /Management target denied/);
      assert.equal(queried, false);
    }
  }
});

test('egress: explicit management IPs still block named aliases and mixed DNS answers', async () => {
  for (const [blocked, address, family] of [
    ['1.1.1.1', '1.1.1.1', 4],
    ['[2606:4700:4700:0:0:0:0:1111]', '2606:4700:4700::1111', 6],
  ] as const) {
    for (const addresses of [[{ address, family }], [{ address: '8.8.8.8', family: 4 }, { address, family }]]) {
      await assert.rejects(resolvePublicTarget(new URL('https://alias.example/'), async () => addresses, [blocked]), /Management address denied/);
    }
  }
});

test('egress: shared public addresses never exempt a private DNS answer', async () => {
  await assert.rejects(resolvePublicTarget(new URL('https://portal.example/'), async () => [
    { address: '104.26.0.214', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ], ['agent.example']), /Address denied/);
});
