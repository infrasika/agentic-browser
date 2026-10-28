# LibreChat source integration

This directory is the complete source definition for our customized LibreChat:

- `source.lock.json` pins the public upstream commit, patch SHA-256 and final Git tree.
- `customizations.patch` contains the native browser tools, same-screen browser UI, accounts, credits, budget and administrator changes.
- `LICENSE` preserves the upstream MIT license.

No private fork, sibling checkout or source handoff archive is required. The build fetches the upstream commit and applies this patch with Git, then verifies the exact resulting tree. No runtime configuration or secret is part of the patch.

To work on LibreChat, prepare a new development checkout:

```bash
python3 scripts/build/prepare-librechat.py --output output/sources/librechat
cd output/sources/librechat
npm ci
```

The upstream commit is HEAD; our patch is staged. Make and test changes in that checkout. Stage only reviewed application changes. If the Browser API changed, run `node scripts/sync-browser-contract.mjs output/sources/librechat` from the main repository first. The checkout needs its development dependencies for formatting.

Record the complete customization against the pinned upstream after staging changes:

```bash
python3 - <<'PY'
import hashlib, json, subprocess
from pathlib import Path
integration = Path('integrations/librechat')
source = Path('output/sources/librechat')
lock = json.loads((integration / 'source.lock.json').read_text())
def git(*args):
    return subprocess.check_output(['git', '-C', str(source), *args])
assert git('rev-parse', 'HEAD').decode().strip() == lock['commit']
assert not git('diff', '--name-only'), 'Stage reviewed changes first'
patch = git('diff', '--cached', '--binary', '--full-index', 'HEAD')
(integration / 'customizations.patch').write_bytes(patch)
lock['patchSha256'] = hashlib.sha256(patch).hexdigest()
lock['tree'] = git('write-tree').decode().strip()
(integration / 'source.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
PY
```

Review the resulting main-repository diff, verify it by preparing another fresh checkout, then commit the patch and lock together. Do not add `.env`, deployment config, logs or generated frontend output. Upstream upgrades must explicitly change the base commit and revalidate the patch, license, API contract and application tests.
