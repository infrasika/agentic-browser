import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Only rejected requests: this never supplies an actual account or valid challenge.
const origin = process.argv[2] ?? 'http://127.0.0.1:3080';
assert.ok(['http://127.0.0.1:3080', 'https://agentic-browser.zkpass.org'].includes(origin));
const checks = [];
for (const action of ['login', 'register']) {
  for (const challenge of ['missing', 'invalid']) {
    const response = await fetch(`${origin}/api/auth/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(challenge === 'missing' ? {} : { turnstileToken: 'invalid-preflight-token' }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 400, `${action}: ${challenge} challenge must be rejected`);
    assert.deepEqual(await response.json(), {
      error: challenge === 'missing' ? 'challenge_required' : 'challenge_invalid',
    });
    checks.push(`${action}_${challenge}_rejected`);
  }
}
const report = { passed: true, completedAt: new Date().toISOString(), origin, checks };
await mkdir('output/librechat', { recursive: true });
await writeFile(`output/librechat/turnstile-${origin.startsWith('https') ? 'public' : 'origin'}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
