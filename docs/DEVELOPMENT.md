# Development

Use Node.js 24+ and npm. Run `npm ci` initially and after lockfile changes; do not share `node_modules` across operating systems. Image builds also need Git, tar and Docker/Buildx; see [Build](BUILD.md). Linux locking utilities used by deployment operations are supplied inside the image, not installed through a host Node installer.

## Branches

Maintainers merge verified changes into `main` and use `feature` for ongoing development. Synchronize before starting:

```bash
git fetch origin
git switch feature
git pull --ff-only origin feature
git merge origin/main
```

Commit and push reviewed changes, then open a PR into `main`. Contributors without repository write access can use a branch in their own fork. Build releases from committed source or a fixed tag, not an unreviewed working tree.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Browser Service, protocol, scheduling, streaming and isolated runtime |
| `integrations/librechat/` | Upstream source lock, customization patch and license |
| `runtime/` | Chrome Dockerfile, extension assets, sandbox rules and licenses |
| `deploy/agent/` | Application Dockerfiles, setup, shared tools and host Nginx template |
| `deploy/compose/` | Compose template and container-based operations |
| `config/` | Tracked settings/secret examples; operator files in `config/local/` are ignored |
| `scripts/` | Build/release tools and browser-contract synchronization |
| `test/` | Unit, tooling and acceptance tests |
| `docs/` | Maintained guides; the root README is the documentation index |

Generated `output/`, `.deployment/` and `.playwright-cli/` directories are ignored. They hold build/test output, local deployments and browser-debugging output, respectively; none is a fresh-clone build prerequisite. Preserve active deployment files, named volumes and backups when cleaning local output. See [Architecture](ARCHITECTURE.md) for component responsibilities.

## Change LibreChat

Prepare a new development checkout from the repository root; no adjacent private repository is required:

```bash
npm run source:prepare -- --output output/sources/librechat
npm --prefix output/sources/librechat ci
```

The tool fetches the pinned public upstream commit, applies the patch and verifies its complete Git tree, patch digest, license and protocol. The output directory must not exist. Its HEAD is the upstream commit, with the customization patch staged. Make changes there and run the affected upstream tests. Upstream dependency development may require native build tools; that is separate from building our images inside Docker. Keep local application configuration and build output out of the patch.

The browser contract originates in `src/api/actions.ts` and `src/api/protocol.ts`. After changing it, run from the main repository root:

```bash
node scripts/sync-browser-contract.mjs output/sources/librechat
node scripts/sync-browser-contract.mjs output/sources/librechat --check
```

Synchronization uses the checkout's development dependencies and Prettier configuration. Stage only reviewed application and protocol changes there, then regenerate the complete patch and lock from the main repository root:

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

Review the main repository diff and run `source:prepare` into another new directory to verify it before committing the patch and lock together. An upstream upgrade must explicitly update the base commit and revalidate the license, contract and application tests.

## Tests and npm entry points

```bash
npm run check
npm test
```

The default suite covers browser behavior, scheduling, egress policy, configuration and build/operations/release tooling. It does not start a full site or call a paid model. Two Linux-only `flock` tests are skipped on Mac and must pass on Linux.

Run individual tests directly when debugging:

```bash
node --import tsx --test test/browser-service.test.ts
node --test test/tooling/compose-operations.test.mjs
```

`.github/workflows/ci.yml` runs Node 24 dependency installation, type checks and tests on Ubuntu 24.04 amd64, Ubuntu 24.04 arm64 and macOS 15 arm64. It runs on pushes to `main`, PRs, manual dispatch and release-workflow calls. It has source-read permission and needs no deployment credentials. macOS checks cover source and Node tooling; Linux runners perform image builds and deployment acceptance.

| Command | Purpose |
| --- | --- |
| `npm run source:prepare -- --output NEW_DIRECTORY` | Prepare and verify LibreChat source |
| `npm run runtime:fetch -- --arch arm64` | Download and verify pinned browser assets |
| `npm run test:runtime` | Real Chrome sandbox, process/file/network isolation and failure cleanup; needs Docker |
| `npm run test:extensions` | Original extension UIs, native TransGate popup navigation, new-tab online state and Schema Validator handoff; needs Docker/Bash |

`test:runtime` and `test:extensions` select a fixed local image through `BROWSER_RUNTIME_IMAGE`. Build a development runtime for the host architecture, for example:

```bash
npm run build:agent -- --component runtime --platforms linux/arm64 --tag development
BROWSER_RUNTIME_IMAGE=agentic-browser-runtime:development-arm64 npm run test:extensions
```

On amd64, replace both architecture suffixes with `amd64`. The builder fetches pinned assets and emits a report. An optional soak driver is `node --import tsx test/acceptance/accept-browser-soak.ts --run --capacity=1 --hold-seconds=300`. These tests verify different isolation properties; a successful page load does not replace them.

`scripts/build/bundle-tools.mjs` is the internal esbuild entry point used by image preparation, not a separate operator command. See [Release](RELEASING.md) for the complete delivery process.

## Full Compose acceptance

Run this test on a native Linux host meeting the [deployment prerequisites](DEPLOYMENT.md#1-prepare-a-linux-server), with Node.js 24+, OpenSSL and approximately 6 GiB of available RAM. It creates an independent Compose project with real Chrome and simulated model/TLS mail services, without site credentials, paid model calls or external mail.

Provide a manifest with `version` and six `images` entries: `agent`, `browser`, `runtime`, `gateway`, `mongo` and `redis`. A published release supplies `release.json`; a local build's `report.json` is not a substitute.

```bash
npm ci
mkdir -p output/tests
npm run accept:compose -- \
  --release /absolute/path/to/release.json \
  --work output/tests/compose-test --port 3350
```

The work directory must be new, with an existing parent directory. Acceptance generates its own deployment files. For local candidate images, use fixed local tags for the three built images in the manifest and add `--development`; official releases require immutable digests. Keep infrastructure references pinned. Ports 3350/3351 must be free; `--port` selects the first, and the restore project uses the next. Deployment subprocesses have only Docker on PATH to check that operators need no host Node/npm installation.

Coverage includes configuration rejection, initial startup, account isolation, credits and budget enforcement, queue admission, handoff/resume, logout cleanup and password recovery. Operations coverage includes persistent keys/data, account creation/reset, active-task backup rejection, verified restore, corrupt-backup rejection, failed-upgrade rollback, interrupted-backup recovery, scheduled retention and backup-service preservation across upgrades.

Inspect `report.json` in the work directory. Confirm the intended version, host architecture and image references, plus `passed: true`, `cleanup.passed: true` and `cleanup.remaining: 0`. Cleanup includes all test profiles, containers, networks and volumes. Keep diagnostic workspaces private; only summarized evidence belongs in a release. Release CI requires this acceptance on both native Linux architectures; emulated builds are not a substitute.

## Documentation maintenance

Maintained guides are English; the [root README](../README.md#documentation) introduces the product and indexes them. Keep installation steps in Deployment, file/parameter/storage definitions in Configuration, running-site procedures in Operations, local image builds in Build, and publication in Release. Development owns source changes and testing; Architecture explains system behavior. Link to the owning guide instead of copying whole explanations or procedures.

Use current npm/Node commands and keep deployment-specific paths, credentials and migration narratives out of general instructions. Record verified coverage and acceptance limits in the corresponding release notes and reports.

Deployment, configuration and operations guides are also copied into release directories. Check relative links in both source and delivery layouts. Moving files requires checking the packaging whitelist, Docker COPY instructions and `.dockerignore`. Changes to image inputs require rebuilding the affected release images. Do not silently rewrite old checksummed release assets when updating documentation.
