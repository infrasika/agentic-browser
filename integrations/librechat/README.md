# LibreChat source integration

This directory is the complete source definition for our customized LibreChat:

- `source.lock.json` pins the public upstream commit, patch SHA-256 and final Git tree.
- `customizations.patch` contains the native browser tools, same-screen browser UI, accounts, credits, budget and administrator changes.
- `LICENSE` preserves the upstream MIT license.

No private fork, sibling checkout or source handoff archive is required. The build fetches the upstream commit and applies this patch with Git, then verifies the exact resulting tree. No runtime configuration or secret is part of the patch.

To work on LibreChat, prepare a new development checkout:

```bash
npm ci
npm run source:prepare -- --output output/sources/librechat
cd output/sources/librechat
npm ci
```

The upstream commit is HEAD; our patch is staged. Make and test changes in that checkout. Stage only reviewed application changes. If the Browser API changed, run `node scripts/sync-browser-contract.mjs output/sources/librechat` from the main repository first. The checkout needs its development dependencies for formatting.

Record the complete customization against the pinned upstream after staging changes:

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const integration = 'integrations/librechat';
const source = 'output/sources/librechat';
const lock = JSON.parse(fs.readFileSync(`${integration}/source.lock.json`, 'utf8'));
const git = (...args) => execFileSync('git', ['-C', source, ...args], { maxBuffer: 64 * 1024 * 1024 });
assert.equal(git('rev-parse', 'HEAD').toString().trim(), lock.commit);
assert.equal(git('diff', '--name-only').toString(), '', 'Stage reviewed changes first');
const patch = git('diff', '--cached', '--binary', '--full-index', 'HEAD');
fs.writeFileSync(`${integration}/customizations.patch`, patch);
lock.patchSha256 = createHash('sha256').update(patch).digest('hex');
lock.tree = git('write-tree').toString().trim();
fs.writeFileSync(`${integration}/source.lock.json`, JSON.stringify(lock, null, 2) + '\n');
NODE
```

Review the resulting main-repository diff, verify it by preparing another fresh checkout, then commit the patch and lock together. Do not add `.env`, deployment config, logs or generated frontend output. Upstream upgrades must explicitly change the base commit and revalidate the patch, license, API contract and application tests.
