# Releasing

Publish these two public GHCR packages while keeping the source repository private:

- `ghcr.io/infrasika/agentic-browser-controller`
- `ghcr.io/infrasika/agentic-browser-runtime`

GitHub Release attachments inherit repository access restrictions. New installations use the standalone installer; an authorized administrator can also distribute historical release bundles. Publishing the images does not publish the source or Release page.

## Run the workflow

Push reviewed code to `main`. In **Actions → Publish verified browser images → Run workflow**, choose `main` and an unused version, or use an authorized GitHub CLI:

```sh
gh workflow run publish-images.yml --ref main -f version=v0.1.0-preview.3
```

The workflow uses a job-scoped `GITHUB_TOKEN` with `packages: write`; the Release job also has `contents: write`. No personal registry token or server-side `docker login` is required. The account must permit native ARM runners and have sufficient Actions quota.

Native `ubuntu-24.04` and `ubuntu-24.04-arm` runners each build and test controller/runtime images. Checks include TypeScript, unit/API tests, locked browser/extension assets, Chrome sandbox, extension behavior, team isolation/recovery, public five-browser capacity, and human handoff. Both architectures must pass before their recorded digests are combined into versioned multi-platform indexes.

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

## Dependency locks

Base images, npm dependencies, Chrome, and extensions have fixed references or hashes. `runtime/assets.lock.json` covers both native Chrome packages and the two original CRX packages. CI must fail on a mismatch rather than refresh locks automatically.

To intentionally update browser assets, run `python3 scripts/fetch-runtime-assets.py --refresh-lock`, review both architectures, versions, extension permissions and notices, then rerun acceptance. Upstream endpoints may stop serving an old package; preserve verified asset caches needed to rebuild that version.

Deploying by digest reproduces the tested image bytes. Floating Debian repositories mean source rebuilds are not guaranteed byte-identical. Never create a release image by committing a container containing personal website state.
