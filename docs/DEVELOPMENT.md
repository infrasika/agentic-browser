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

## Source boundaries

`src/` contains Browser Service, the internal API, scheduling and isolated runtime. The LibreChat application is defined by `integrations/librechat/source.lock.json` and `customizations.patch`. Its customized chat, browser panel, accounts, tools, credits, budget and administrator features are maintained together; the upstream MIT license is retained alongside the patch.

`deploy/compose/` owns the deployment template and container operations entry point. `deploy/agent/app/` contains application setup, mail and account logic; `deploy/agent/lib/` contains shared process, file and archive utilities. See [Architecture](ARCHITECTURE.md).

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
| `npm run release` | Dispatch release CI using the version in package.json |
| `npm run source:prepare -- --output NEW_DIRECTORY` | Prepare and verify LibreChat source |
| `npm run runtime:fetch -- --arch arm64` | Download and verify pinned browser assets |
| `npm run build:agent -- --help` | Build Agent, Browser Service and Chrome runtime |
| `npm run publish:agent -- --help` | Preview publication, upload to GHCR or verify anonymous pulls |
| `npm run package:compose -- --release RELEASE_JSON --output NEW_DIRECTORY` | Create Compose deployment files from a release manifest |
| `npm run test:runtime` | Real Chrome sandbox, process/file/network isolation and failure cleanup; needs Docker |
| `npm run test:extensions` | Both extensions loading and opening their pages inside a container; needs Docker/Bash |

`test:runtime` and `test:extensions` select a fixed local image through `BROWSER_RUNTIME_IMAGE`. Build a development runtime for the host architecture, for example:

```bash
npm run build:agent -- --component runtime --platforms linux/arm64 --tag development
BROWSER_RUNTIME_IMAGE=agentic-browser-runtime:development-arm64 npm run test:extensions
```

On amd64, replace both architecture suffixes with `amd64`. The builder fetches pinned assets and emits a report. An optional soak driver is `node --import tsx test/acceptance/accept-browser-soak.ts --run --capacity=1 --hold-seconds=300`. These tests verify different isolation properties; a successful page load does not replace them.

`scripts/build/bundle-tools.mjs` is the internal esbuild entry point used by image preparation, not a separate operator command. See [Release](RELEASING.md) for the complete delivery process.

## Full Compose acceptance

`deploy/compose/compose.template.yaml` defines the named-volume deployment. The in-container initializer validates input, preserves generated keys and renders gateway configuration. `src/compose-service.ts` discovers the Docker socket group and drops Browser Service to UID 1000. The bundled operations program provides on-demand `ops` commands and the daily `backup` service. Docker CLI, Compose and their licenses are included in the Agent image.

Run acceptance on a native Linux host meeting the [deployment prerequisites](DEPLOYMENT.md#1-prepare-a-linux-server). After building the intended images, provide a manifest with `version` and six `images` entries: `agent`, `browser`, `runtime`, `gateway`, `mongo` and `redis`. A published release supplies `release.json`; a local build's `report.json` is not a substitute.

```bash
mkdir -p output
npm run package:compose -- --release /absolute/path/to/release.json --output output/compose
npm run accept:compose -- --release /absolute/path/to/release.json --work output/compose-test
```

Both output directories must be new, with an existing parent directory. Acceptance creates its own deployment; `output/compose` demonstrates packaging and is not its input. For local candidate images, use fixed local tags for the three built images in your manifest and pass `--development` to both commands; official delivery requires immutable digests. Keep the three infrastructure references pinned to the intended release. The acceptance driver uses ports 3350/3351 by default. `--port` selects the first port; the restore project uses the next. Keep these separate from any running site.

The test host needs OpenSSL and approximately 6 GiB of available RAM. The driver starts an independent Compose project with simulated model/TLS mail services and real Chrome accessing public test pages. It does not read site credentials. Deployment subprocesses have only Docker on PATH, so the test checks the absence of a host Node/npm requirement.

Coverage includes configuration rejection, initial startup, account isolation, credits and budget enforcement, queue admission, handoff/resume, logout cleanup and password recovery. Operations coverage includes persistent keys/data, account creation/reset, active-task backup rejection, verified restore, corrupt-backup rejection, failed-upgrade rollback, interrupted-backup recovery, scheduled retention and backup-service preservation across upgrades.

Cleanup includes all profiles, test containers, networks and volumes. A successful report requires `passed: true`, `cleanup.passed: true` and `cleanup.remaining: 0`. Diagnostic workspaces remain private; only summarized evidence belongs in a release. CI performs this acceptance on both native Linux platforms before publication.

## Documentation maintenance

Maintained guides are English and live in `docs/`; the [root README](../README.md#documentation) is the only documentation index and contains the repository layout. Use current npm/Node commands and keep deployment-specific paths, credentials and migration narratives out of general instructions. Record verified coverage and acceptance limits in the corresponding release notes and reports.

Deployment, configuration and operations guides are also copied into release directories. Check relative links in both source and delivery layouts. Moving files requires checking the packaging whitelist, Docker COPY instructions and `.dockerignore`. Changes to image inputs require rebuilding the affected release images. Do not silently rewrite old checksummed release assets when updating documentation.
