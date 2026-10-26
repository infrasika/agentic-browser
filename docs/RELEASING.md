> **Archived MCP v0.1.x documentation.** These instructions describe the older external-agent product. The current public site is a LibreChat Agent and its public MCP endpoint is closed. For the complete Agent, see [installation](../deploy/agent/INSTALL.md), [current demo](AGENT_DEMO.md), and [release preparation](../deploy/agent/RELEASING.md).

# Release maintenance

This guide covers browser assets, GitHub Actions, image publication and the official deployment. For source structure and local development, see [Technical architecture](ARCHITECTURE.md). For installation and operator backup procedures, see [Self-hosting](SELF_HOST.md).

The hosted Agent migration is tracked separately in the [LibreChat integration plan](plans/LIBRECHAT_INTEGRATION.md) and [development progress](plans/LIBRECHAT_PROGRESS.md). The current [deployment guide](../deploy/librechat/README.md) uses native tools and a private HTTP Browser Service; complete its acceptance gates before switching the public site. The procedures below describe the existing browser-only release.

## Release verification

The accepted stable release is **v0.1.1**, built from `683b26aece0751e1923407f17e4073e189d07d68`. Both public images support native Linux amd64/arm64, and their `latest` aliases match the immutable version indexes. This maintenance release updates both images and CI to Node.js 24.22.1, with Chrome and extension locks unchanged. The official site and installer use the same digests in [deploy/release.env](../deploy/release.env).

| Evidence | Verified scope |
| --- | --- |
| [Publication and anonymous pulls](../deploy/releases/v0.1.1-public-verification.json) | Native isolation, handoff, capacity/recovery, both public platforms, stable/latest equality |
| [Fresh installation](../deploy/releases/v0.1.1-install-verification.json) | Native amd64/arm64 account/token setup, workspace diagnostics, handoff and saved profiles |
| [Upgrade and rollback](../deploy/releases/v0.1.1-upgrade-verification.json) | v0.1.0 to v0.1.1, offline backup and fresh-volume restore on both platforms |
| [Official HTTPS demo](../deploy/releases/v0.1.1-demo-verification.json) | MCP, live WSS display, takeover, handback, Agent reading, cleanup and setup downloads |
| [Previous physical Apple Silicon Mac acceptance](../deploy/releases/v0.1.0-mac-verification.json) | v0.1.0 only: installation, real GitHub handoff, saved-login retention and same-version backup/restore on Mac16,10 / macOS 26.6.2 / Docker Desktop 4.95.0 |

The release source passed 63 unit/API/packaging tests. Physical Apple Silicon acceptance for v0.1.1 has not been run; native Linux arm64 CI and the previous v0.1.0 Mac receipt do not replace that check. The older Mac run's same-version restore does not establish Mac upgrade/downgrade or Chrome/profile-format migration compatibility. Long-duration and optional-client checks from older releases are not new v0.1.1 evidence. Live zkPass proofs remain outside these results and are skipped by request. Keep these limits explicit in release notes.

## GitHub Actions

All release and acceptance workflows are manually dispatched. The two matrix runners are `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64); builds run natively rather than emulating ARM on x86.

| Workflow file | Input and purpose |
| --- | --- |
| `.github/workflows/publish-images.yml` | Required unused `version`; checks source, builds and validates both images, then publishes indexes and a GitHub Release; advances `latest` only for a newer stable release |
| `.github/workflows/accept-self-host.yml` | No inputs; verifies anonymous image installation using the official installer |
| `.github/workflows/accept-upgrade.yml` | No inputs; verifies the version pair in `test/upgrade.integration.ts`, including backup/restore |
| `.github/workflows/accept-soak.yml` | `minutes` (default 120); sustained public/authenticated browser workloads |
| `.github/workflows/accept-experience.yml` | `minutes` (default 15); desktop input, changing display, reconnect and website tasks |
| `.github/workflows/accept-remote-client.yml` | No inputs; optional stdio client without server-volume/socket mounts |
| `.github/workflows/accept-https.yml` | No inputs; HTTPS/WSS, secure cookies and proxy failure handling |

The publication build jobs need `packages: write`; the publication job also needs `contents: write` to create the release. Acceptance workflows need only `contents: read`, use anonymous registry pulls and create disposable installations. Actions are commit-pinned. Publication is serialized across versions to protect the moving channel; acceptance artifacts are finite-retention reports, not permanent release evidence.

## Fixed inputs and public artifacts

Keep the source repository private. These two GHCR packages are public:

- `ghcr.io/infrasika/agentic-browser-controller`
- `ghcr.io/infrasika/agentic-browser-runtime`

`deploy/release.env` selects the accepted multi-platform image-index digests. Base images, npm versions and `runtime/assets.lock.json` pin build inputs. Do not refresh browser/extension locks implicitly. Deployment by digest fixes image bytes; source rebuilds using Debian repositories are not guaranteed byte-identical.

For a Node maintenance update, use the same exact Node version and multi-platform base-image digest in both runtime Dockerfiles, and update `actions/setup-node` in the release and acceptance workflows. Both the controller and browser runtime execute Node services. Run the verifiers on that Node version too; changing only the controller leaves the browser processes and CI on older versions. Keep Chrome and extension locks unchanged unless their upgrade is explicitly in scope.

Published version tags, release manifests and archives are immutable. Keep current stable receipts and the baseline records read by upgrade acceptance in `deploy/releases/`. Older intermediate reports remain in Git history and published release artifacts. Temporary logs, reports, build helpers and screenshots belong in ignored `output/`; they are not public distribution files.

`latest` is the only moving image tag. Both controller and runtime point to the highest published stable `vX.Y.Z` release; versions with a suffix such as `-preview.5` never update it. The publication workflow serializes releases, verifies both immutable multi-platform indexes, copies those exact indexes to `latest`, then marks the GitHub release as Latest. Older stable releases cannot move this channel backward. Existing deployments keep their pinned digests until explicitly upgraded.

Registry updates across two repositories are not atomic. If channel promotion fails, keep using the immutable version references. Retry only `python3 scripts/release-manifest.py latest VERSION output/release` with the original `RELEASE.json`, its matching `GITHUB_SHA`, and authorized GHCR/GitHub credentials; serialize it with other publications. This operation is idempotent. Do not rebuild or overwrite the published version to repair an alias.

The standalone installer writes just `compose.yaml` and `.env`, with literal accepted image references. `npm run package:self-host` generates `/install.sh`, the backup helper, user-guide downloads and a source-free configuration archive. The controller image build runs this packager automatically. The allowlist in `scripts/release-manifest.py` must exclude private settings, source, browser data and local artifacts.

`SETUP.json` records file hashes and image pins; `SHA256SUMS` covers the reproducible setup archive. Documentation may advance without changing pins only when the pinned images support the documented operations. Do not describe a local website UI build as a newly published GHCR version. GitHub Release assets inherit the private repository's access controls; users obtain the public installer and guides from the website.

Image-bundled guides are build-time snapshots. Public download kits may contain newer documentation without changing published image bytes. The old `AGENT_CLIENT.md` and `STATUS.md` download URLs are generated compatibility aliases for the consolidated architecture and release guides; they are not separate maintained documents and are excluded from the configuration archive.

## Browser assets and runtime builds

`runtime/assets.lock.json` pins Chrome 155.0.8059.79 for both architectures, TransGate 0.5.5 and Schema Validator 0.1.3. The runtime installs the original signed extensions locally into clean profiles and contains no personal website state.

```sh
npm run runtime:build
```

The first asset fetch needs network access; later builds reuse `output/runtime/packages/` only when hashes match. A changed upstream package fails verification. For an intentional browser/extension update, run `python3 scripts/fetch-runtime-assets.py --refresh-lock`, review the lock changes and run appropriate native acceptance. Keep verified caches because upstream URLs may stop serving older packages.

Dedicated zkPass acceptance is excluded from the normal publication workflow. The optional `scripts/test-extensions.sh` uses offline, disposable containers and synthetic data to check bundled extension UI/storage, sandbox state and handoff. It mounts no real profile or Docker socket. These checks do not establish live TransGate proof success, external-node availability or cross-version profile compatibility. Run them only as part of a specifically scoped extension change.

Keep the Chrome sandbox enabled and preserve [distribution notices](../runtime/DISTRIBUTION-NOTICES.md), [Playwright's license](../runtime/PLAYWRIGHT-LICENSE) and applicable dependency licenses. Runtime and network boundaries are documented in [Architecture](ARCHITECTURE.md#5-authentication-and-isolation-invariants).

## Acceptance commands

Tests use disposable installations and synthetic identities. Select candidate images explicitly for source-image tests; published-installer tests use the accepted digests. Do not point acceptance fixtures at a real workspace or load its `.env`.

| Check | Command | Scope |
| --- | --- | --- |
| Type safety | `npm run check` | TypeScript source/tests |
| Unit/API and packaging | `npm test` | Ownership, limits, installer/archive hashes, secret exclusion |
| Native viewer | `npm run test:desktop` | Keyboard, handback, reconnect, persistence |
| Candidate controller | `npm run test:controller` | Member/profile isolation and container deployment |
| Public MCP | `npm run test:public-mcp` | Five-browser capacity, guest isolation, direct input, handoff and cleanup |
| Failure recovery | `npm run test:reliability` | Repeated capacity cycles, natural expiry, browser/controller interruption and revocation |
| Published installation | `npm run test:self-host` | Anonymous pulls, native platform, downloaded installer, account/token/profile lifecycle |
| Published upgrade | `npm run test:upgrade` | The version pair in the verifier, plus fresh-volume restore from an offline backup |
| Sustained workload | `npm run test:soak` | Two measured active hours, split between public/authenticated five-browser workloads |
| Desktop/site experience | `npm run test:experience` | 15 measured minutes of changing pixels/input, reconnect and public website tasks |
| Optional stdio client | `npm run test:remote-client` | Published client image without host/server/socket mounts |
| HTTPS proxy | `npm run test:https` | Certificate validation, secure cookies, HTTP MCP, WSS, proxy recovery and rate limits |

For candidate controller/runtime tests:

```sh
AB_CONTROLLER_IMAGE=agentic-browser:controller-preview \
AB_RUNTIME_IMAGE=agentic-browser:zkpass-prototype \
npm run test:public-mcp
```

Install host Playwright/native-browser dependencies before applicable tests. HTTPS verification additionally needs Nginx, OpenSSL and `libnss3-tools`; it uses an isolated local CA/trust store and loopback proxy, without disabling TLS validation or reloading the host's real proxy. See the corresponding scripts for bounded-run options such as `npm run test:experience -- --minutes=1`.

Separate `accept-self-host.yml`, `accept-upgrade.yml`, `accept-soak.yml`, `accept-experience.yml`, `accept-remote-client.yml` and `accept-https.yml` workflows run native Ubuntu amd64/arm64 checks. The external verifier needs a checkout and test dependencies; the resulting self-hosted installation does not. Existing-host, fresh Linux runner and physical Mac evidence must remain distinct. Rollback acceptance with unchanged Chrome assets does not establish browser-format migration compatibility.

## Publish a future version

After a future release is requested:

1. Review and commit the exact candidate. Choose a new unused `vX.Y.Z[-suffix]` version.
2. Dispatch **Publish verified browser images** (`publish-images.yml`) at that commit. Native Ubuntu amd64/arm64 runners build/test both images and record their digests; both must pass before indexes are published.
3. Use the workflow's scoped `GITHUB_TOKEN`; no server-side registry login or personal token is required. The workflow needs package publication permissions and native ARM runner availability.
4. Verify **only the two GHCR packages** are Public, then verify anonymous pulls of both platforms. Keep the source repository private.
5. Preserve the original `RELEASE.json`, `agentic-browser-deploy.tar.gz` and `SHA256SUMS`. Add separate verification receipts; never rewrite publication evidence to claim checks that ran later.
6. Update `deploy/release.env` after acceptance. Regenerate setup files, verify public downloads and run clean-install and upgrade workflows. Record the version, verifier revision, platforms, outcomes and cleanup in a new receipt; update this guide's release-verification table and README.

Published versions cannot be overwritten. A partially published run needs another unused version. Authentication/network failures do not establish that a version tag is available.

CI artifacts expire; preserve sanitized accepted reports in versioned receipts and private Release attachments before that happens. Do not retain raw credentials, cookies, page contents, private backup archives or desktop streams as shared evidence.

## Update the official website

Wait for active public sessions to reach zero before recreating the controller. Preserve its `.env`, runtime pin, mounts, origin and quotas; keep the previous image available for rollback. Verify health, `/api/public/capacity`, `/mcp`, homepage prompts, `/self-host`, guide downloads and archive checksums after deployment. Record the source revision/image identity and check that temporary test sessions release their slots.

For a real sign-in test, use the ordinary user handoff and wait for explicit handback. Never record account data as public test artifacts. Source/UI deployments do not silently update the accepted public image pins. Use [Self-hosting](SELF_HOST.md#backup-and-upgrade) for workspace backup and rollback procedures.

## Small maintenance release policy

- Review Chrome, base-image and dependency updates monthly and when a relevant security fix is announced. This is a maintainer procedure, not an enabled automatic updater or scheduled task.
- Record the candidate version, exact source commit and changed locks. Keep old images, manifests and receipts immutable. Do not silently refresh deployed images.
- For controller/UI fixes with unchanged runtime assets, run type/unit checks and native amd64/arm64 controller, public MCP and failure-recovery acceptance. Then verify anonymous pulls, fresh installation and backup-based upgrade/rollback for both architectures.
- Browser or profile-format changes require an offline backup and a synthetic saved-profile migration test against the exact old/new Chrome versions. Do not infer compatibility from controller-only upgrades.
- Follow the physical Mac checklist in [Self-hosting](SELF_HOST.md#apple-silicon-release-check). Keep Linux arm64 and physical Mac evidence distinct; record pending results honestly.
- Publish release notes with changed behavior, image references, passed checks and remaining limitations. Deploy the same GHCR controller/runtime used by the installer after active demo sessions reach zero.
- The image's embedded installer may name its immutable release tags because an image cannot embed its own future digest. It resolves pulled references and writes digest-only Compose. Generate the official download kit after publication with the accepted digests, and mount that kit read-only at `/app/web/self-host-downloads` when deploying the official site. Application code stays in the published controller image.

Dedicated zkPass checks remain skipped. Native runtime startup and its existing isolation checks are retained; no live proof success is claimed.

## Official-site setup files

The site serves the same published controller as self-hosted installations. Build its post-publication download kit in a persistent deployment directory, separate from disposable `output/` reports:

```sh
python3 scripts/package-self-host.py --output .deployment/public-setup
bash scripts/compose.sh -f deploy/compose.site.yaml up -d --force-recreate --wait
```

Select the accepted controller/runtime digests in the site's private `.env` first. Wait for zero active sessions before recreation. The optional override mounts only the public setup files, read-only. Keep `.deployment/public-setup` while the site uses this override, and include the override on subsequent site restarts. Ordinary personal installations do not need this file or directory.
