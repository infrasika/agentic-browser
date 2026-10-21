# Release maintenance

Maintain a personal self-hosted browser and public demo. Team feature development is out of scope. See [Version status](STATUS.md) for the accepted release and work in progress.

## Fixed inputs and public artifacts

Keep the source repository private. These two GHCR packages are public:

- `ghcr.io/infrasika/agentic-browser-controller`
- `ghcr.io/infrasika/agentic-browser-runtime`

`deploy/release.env` selects the accepted multi-platform image-index digests. Base images, npm versions and `runtime/assets.lock.json` pin build inputs. Do not refresh browser/extension locks implicitly. Deployment by digest fixes image bytes; source rebuilds using Debian repositories are not guaranteed byte-identical.

Historical version tags, release manifests, archives and verification receipts are immutable. Keep earlier receipts in `deploy/releases/`, including the preview.3 evidence used by rollback acceptance. Temporary logs, reports, build helpers and screenshots belong in ignored `output/`; they are not public distribution files.

The standalone installer writes just `compose.yaml` and `.env`, with literal accepted image references. `npm run package:self-host` generates `/install.sh`, the backup helper, user-guide downloads and a source-free configuration archive. The controller image build runs this packager automatically. The allowlist in `scripts/release-manifest.py` must exclude private settings, source, browser data and local artifacts.

`SETUP.json` records file hashes and image pins; `SHA256SUMS` covers the reproducible setup archive. Documentation may advance without changing pins only when the pinned images support the documented operations. Do not describe a local website UI build as a newly published GHCR version. GitHub Release assets inherit the private repository's access controls; users obtain the public installer and guides from the website.

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
| Published upgrade | `npm run test:upgrade` | Preview.3 → preview.4 and fresh-volume restore from an offline backup |
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

Separate `accept-self-host.yml`, `accept-upgrade.yml`, `accept-soak.yml`, `accept-experience.yml`, `accept-remote-client.yml` and `accept-https.yml` workflows run native Ubuntu amd64/arm64 checks. The external verifier needs a checkout and test dependencies; the resulting self-hosted installation does not. Existing-host, fresh Linux runner and physical Mac evidence must remain distinct. Preview.3/4 use identical Chrome assets, so their rollback evidence is not browser-format migration evidence.

Further zkPass-specific testing remains skipped by request. The optional historical extension checks are retained for future explicitly authorized runtime work; they are not a task to resume during this freeze. Existing workflows that include those checks must be reviewed before a future publication rather than launched automatically.

## Publish a future version

After a future release is requested:

1. Review and commit the exact candidate. Choose a new unused `vX.Y.Z[-suffix]` version.
2. Dispatch **Publish verified browser images** (`publish-images.yml`) at that commit. Native Ubuntu amd64/arm64 runners build/test both images and record their digests; both must pass before indexes are published.
3. Use the workflow's scoped `GITHUB_TOKEN`; no server-side registry login or personal token is required. The workflow needs package publication permissions and native ARM runner availability.
4. Verify **only the two GHCR packages** are Public, then verify anonymous pulls of both platforms. Keep the source repository private.
5. Preserve the original `RELEASE.json`, `agentic-browser-deploy.tar.gz` and `SHA256SUMS`. Add separate verification receipts; never rewrite publication evidence to claim checks that ran later.
6. Update `deploy/release.env` after acceptance. Regenerate setup files, verify public downloads and run the clean-install workflow. Record the version, verifier revision, platforms, outcomes and cleanup in a new receipt and the status page.

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
