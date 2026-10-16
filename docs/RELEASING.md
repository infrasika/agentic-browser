# Releasing

Publish these two public GHCR packages while keeping the source repository private:

- `ghcr.io/infrasika/agentic-browser-controller`
- `ghcr.io/infrasika/agentic-browser-runtime`

GitHub Release attachments inherit repository access restrictions. New installations use the standalone installer; an authorized administrator can also distribute historical release bundles. Publishing the images does not publish the source or Release page.

## Run the workflow

Push reviewed code to `main`. In **Actions → Publish verified browser images → Run workflow**, choose `main` and an unused version, or use an authorized GitHub CLI:

```sh
gh workflow run publish-images.yml --ref main -f version=v0.1.0-preview.5
```

The workflow uses a job-scoped `GITHUB_TOKEN` with `packages: write`; the Release job also has `contents: write`. No personal registry token or server-side `docker login` is required. The account must permit native ARM runners and have sufficient Actions quota.

Native `ubuntu-24.04` and `ubuntu-24.04-arm` runners each build and test controller/runtime images. Checks include TypeScript, unit/API tests, locked browser/extension assets, Chrome sandbox, extension behavior, team isolation/recovery, public five-browser capacity, and human handoff. Both architectures must pass before their recorded digests are combined into versioned multi-platform indexes.

The reliability gate also runs repeated five-browser cycles, simultaneous excess requests, cross-session access checks, Agent reconnects, a real five-minute expiry, browser/controller termination, and five-member token revocation. It uses a separate loopback deployment, synthetic identities, and a disposable volume; it does not load the server's `.env`. Cleanup targets only the test project's containers and volume. Browser termination must release its slot without another Agent request, and a failed cleanup must retain its reservation until retry succeeds (covered by unit tests).

To run the same check locally, build the candidate images first, then select them explicitly:

```sh
AB_CONTROLLER_IMAGE=agentic-browser:controller-preview \
AB_RUNTIME_IMAGE=agentic-browser:zkpass-prototype \
npm run test:reliability
```

The default is three capacity cycles with 15 seconds of repeated observations per cycle, followed by expiry and failure checks. For a longer run, add `AB_RELIABILITY_ROUNDS=20 AB_RELIABILITY_HOLD_SECONDS=60` before `npm`. Reports under `output/reliability/<run>/report.json` record source hashes, image IDs, host/Docker versions, sampled container resources, recovery times, and final cleanup. These bounded synthetic runs do not replace extended real-workload testing, fresh-host acceptance, or a physical Mac test. The release workflow retains the reports with its validation artifacts.

Intermediate tags include the full source commit and architecture. Published versions are immutable: the script rejects an existing version and does not interpret an authentication/network failure as proof that a tag is available. Use a new version after a partially published run.

## Bundle contents and public verification

The Release contains:

- `agentic-browser-deploy.tar.gz`: configuration, scripts, guides, notices, and `deploy/release.env` with both image-index digests.
- `RELEASE.json`: source revision, platforms, digests, and browser/extension asset locks.
- `SHA256SUMS`: hashes for the archive and manifest.

The allowlist excludes source code, private environment files, user profiles, logs, and credentials. Actions also retains validation artifacts. The source-preview archive is a different artifact for authorized source recipients.

The public website also serves `agentic-browser-self-host.tar.gz` and `SHA256SUMS` at `/self-host/download/`. `npm run package:self-host` builds this configuration-only archive from the same deployment allowlist and the accepted `deploy/release.env`. The controller Docker build generates it automatically; `npm start` and `npm run dev` generate it for source deployments. Only the explicitly named installer, archive, checksum, and user-guide routes are public. `SETUP.json` records the configuration hashes and both image pins. This setup archive may include newer instructions while retaining the last accepted image release only when those images support every advertised setting and flow; it never modifies historical release assets. Verify an anonymous download and a clean-directory installation whenever changing the kit or pins.

The same packaging step generates `/install.sh`. This script embeds the accepted Compose configuration with literal image digests, pulls both images, detects the controller socket group, and writes a new directory containing only `compose.yaml` and `.env`. It refuses existing files and requires no repository scripts afterward. Verify the standalone installer and native Compose lifecycle as well as the compatibility archive when changing this setup.

New GHCR packages default to private. On first publication, set **only the two package visibilities** to Public and verify anonymous pulls for both images on both platforms. Keep the source repository private. For later releases, verify that visibility and anonymous access still work.

The initial `RELEASE.json` has `publicPullVerified: false` because the publishing job has not independently verified unauthenticated downloads. Record later checks in a separate `PUBLIC-VERIFICATION.json`; do not overwrite the original manifest, archive, or checksums.

Unpack the bundle in a clean directory with an empty Docker credential configuration. Pull the pinned images, start the controller, run `doctor`, and exercise a synthetic member's create → handoff → handback → close flow. Record the tested platform and whether this was a new directory or a genuinely new host. Linux ARM CI does not substitute for a Mac Docker Desktop test.

After acceptance, update `deploy/release.env` and [Progress](PROGRESS.md). Keep earlier versioned receipts for auditability. Update the live demo only after its active sessions finish, retaining its existing limits and private configuration.

## Independent installation acceptance

After the official installer serves the accepted image pins, run **Actions → Verify published self-host installation**, or:

```sh
gh workflow run accept-self-host.yml --ref main
```

This workflow starts separate, fresh Ubuntu amd64 and arm64 runners. It does not build application images, restore browser image caches, or log in to a registry. The checkout supplies the test client and the expected configuration only. The actual installation downloads the public `/install.sh`, checks it against the reviewed installer, and receives only `compose.yaml` and `.env`. An empty Docker credential configuration verifies anonymous pulls; platform assertions reject architecture emulation.

The test verifies initial sign-in with literal password punctuation, a personal token, native desktop connection/reconnection, human typing and handback, a saved synthetic profile cookie across controller recreation, preserved access after bootstrap settings are removed, and switching to public mode. Every run uses a new loopback port, synthetic accounts, a separate volume, and scoped cleanup. Reports under `output/self-host/<run>/report.json` record the host, Docker/Compose versions, installer hash, image references/platforms, resource sample, checkpoints, and cleanup result. Both CI reports are retained as artifacts for 30 days. Copy their accepted summary into a versioned receipt before artifact expiry.

Maintainers can run the same verifier from an authorized checkout on Ubuntu or an Apple Silicon Mac with Docker Desktop running:

```sh
npm ci
npx playwright install chromium
npm run test:self-host
```

This checkout and its Node.js/Playwright dependencies are requirements of the external verifier, not of self-hosting. Linux verification clients may additionally need Playwright system dependencies (`npx playwright install --with-deps chromium`). The test never loads the checkout's `.env` or operates on an existing installation. Local runs are recorded as existing-host checks; only the isolated GitHub-hosted workflow asserts a fresh runner. A Linux arm64 pass does not establish a physical Mac pass, and recreation with the same images does not establish cross-version upgrade/rollback compatibility.

## Published upgrade and rollback acceptance

Run `npm run test:upgrade` from an authorized checkout, or dispatch `accept-upgrade.yml` for independent native Ubuntu amd64/arm64 runs. The test pulls the published preview.3 and preview.4 controller/runtime digests with an empty registry credential configuration. It uses two synthetic members and separate disposable volumes; it does not read the deployment's `.env` or touch existing workspaces.

Acceptance includes a stopped-workspace backup through the downloadable helper, rejection of live/mounted volumes and overwritten backups, member/profile isolation, persistent cookies and website storage, both extensions' private state, existing credentials and revocations, a corrupt archive, refusal to overwrite an existing volume, and recovery into a new volume using the old images. It also confirms that revocations made after the backup must be reapplied and that resetting a member password invalidates restored credentials. Only sanitized reports under `output/upgrade/<run>/report.json` become CI artifacts; private backup archives are removed with the test fixture.

Retain the accepted reports in a versioned `*-upgrade-verification.json` receipt and attach a separate `UPGRADE-VERIFICATION.json` to the release. Do not overwrite the original image manifest or publication evidence. The reports include both releases' image digests, host details, browser/extension versions, backup hash/size, scenario checkpoints, and cleanup. Preview.3 and preview.4 use identical Chrome and extension versions: this test establishes application release upgrade and backup-based rollback, not browser-format migration or safe in-place Chrome downgrades.

## Dependency locks

Base images, npm dependencies, Chrome, and extensions have fixed references or hashes. `runtime/assets.lock.json` covers both native Chrome packages and the two original CRX packages. CI must fail on a mismatch rather than refresh locks automatically.

To intentionally update browser assets, run `python3 scripts/fetch-runtime-assets.py --refresh-lock`, review both architectures, versions, extension permissions and notices, then rerun acceptance. Upstream endpoints may stop serving an old package; preserve verified asset caches needed to rebuild that version.

Deploying by digest reproduces the tested image bytes. Floating Debian repositories mean source rebuilds are not guaranteed byte-identical. Never create a release image by committing a container containing personal website state.
