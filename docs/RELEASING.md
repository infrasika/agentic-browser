# Publish images and deployment files

A release publishes the three project images from [Build](BUILD.md) to GHCR and delivers matching Compose and configuration templates. Deployment servers need only Docker and Compose. Publishing requires registry authorization, not site credentials. The project uses [MIT](../LICENSE), and images preserve applicable third-party licenses. Check the [release notes and verification reports](https://github.com/infrasika/agentic-browser/releases) for the version you intend to publish or deploy.

| Command | Result |
| --- | --- |
| `npm run release` | Dispatches the complete GitHub Actions workflow; completion must be checked in Actions |
| `npm run publish:agent -- ... --run` | Publishes images and writes `release.json` / `publication.json`; does not create a GitHub Release |
| `npm run package:compose -- ...` | Writes deployment files locally; does not build, upload, run acceptance or generate final checksums |

## Recommended: GitHub Actions

Run from a source checkout with Node.js 24+/npm and an authenticated [GitHub CLI](https://cli.github.com/). Local Docker and site credentials are not needed for this path. The authenticated account needs permission to dispatch Actions on the target repository. For a fork, enable Actions and confirm GitHub CLI targets your fork, for example with `gh repo set-default OWNER/REPOSITORY`.

1. Choose an unused preview version. Update `package.json` and the lockfile on the development branch, for example `npm version 0.1.0-preview.12 --no-git-tag-version`. This command creates no Git tag.
2. Commit, push and open a PR. Merge to `main` after source checks pass, so the remote branch contains the intended release changes.
3. Authenticate with `gh auth login` if needed. From the repository root, confirm the intended version and dispatch:

```bash
npm run release -- --dry-run
npm run release
```

The command reads the version from `package.json` and dispatches `Publish Agent preview` on remote `main`. Your local checkout may be on `feature`, but all release changes must already be merged remotely. The command does not commit, push, change versions or build locally. To specify the version explicitly, use `npm run release -- vX.Y.Z-preview.N`. The workflow accepts only `main` and the preview version format.

`--dry-run` prints the dispatch command; it does not check remote source, tag availability or permissions. A successful dispatch starts work asynchronously and does not mean publication succeeded. Find the run and watch it, replacing `RUN_ID` with its actual number:

```bash
gh run list --workflow release-agent.yml --branch main --limit 5
gh run watch RUN_ID --exit-status
```

The pipeline performs:

1. Source and type checks on Ubuntu amd64, Ubuntu arm64 and macOS.
2. Native Linux builds on both architectures, validation against source reports and upload of architecture candidates.
3. Assembly of immutable multi-platform indexes and a six-image `release.json`, including pinned official Nginx, MongoDB and Redis images.
4. Anonymous image pulls and full Compose acceptance on two fresh native Linux runners.
5. Version, source, image, architecture and cleanup verification; creation of deployment files and checksums, then a new Git tag and GitHub prerelease. It does not update image tags named `latest` or mark the prerelease as GitHub's latest release.

Acceptance uses real Chrome with simulated model and TLS mail services. It covers account isolation, queueing, handoff/resume, credits, budgets, logout cleanup, password recovery, persistence, backups, restore, failed-upgrade rollback and daily backup scheduling. Deployment subprocesses have only Docker on PATH; the test driver itself uses the maintainer's Node environment. Real providers, public HTTPS, Turnstile and mailbox delivery still need deployment-specific acceptance.

The repository must allow the workflow's `contents: write` and `packages: write` permissions. CI uses its automatic `GITHUB_TOKEN`; do not add model, Turnstile or SMTP credentials as Actions secrets. Fork maintainers publish into their own repository-owner namespace.

The three GHCR packages must be **Public** for anonymous pull acceptance. On first publication into a new namespace, newly created packages default to Private. Open each package's settings, grant the workflow repository access if necessary and change its visibility to Public before retrying anonymous verification. Public source code does not make packages public automatically. See [GitHub's registry authentication and visibility rules](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Manual publication from Mac or Ubuntu

First complete a committed, two-platform build of all three project images. Replace the example build directory with the directory printed by your build. The publication output directory must not exist:

```bash
AGENT_VERSION='v0.1.0-preview.12'
BUILD_DIR="$PWD/output/build/build-XXXXXX"
PUBLISH_DIR="$PWD/output/releases/$AGENT_VERSION"
```

The reports and matching images must be present in the same Docker daemon used for the build. Both platforms must come from the same committed source, and publication validates image inputs against the current checkout's HEAD. Follow [Build](BUILD.md) for prerequisites; use a local Unix Docker socket, including the Docker Desktop context on Mac, for anonymous verification.

Authenticate Docker to `ghcr.io` through your existing credential store, or run:

```bash
docker login ghcr.io --username YOUR_GITHUB_USERNAME
```

At the password prompt, use a GitHub personal access token (classic) with `write:packages`, not your GitHub account password. Existing Docker credential helpers, including a configured Mac keychain helper, are supported. `gh auth login` and Git credentials alone do not log Docker into GHCR. Never put registry tokens in source or site configuration.

Preview the plan without uploading:

```bash
npm run publish:agent -- \
  --build-report "$BUILD_DIR/amd64/report.json" \
  --build-report "$BUILD_DIR/arm64/report.json" \
  --version "$AGENT_VERSION" --namespace YOUR_GITHUB_OWNER
```

Publish and verify anonymous pulls:

```bash
npm run publish:agent -- \
  --build-report "$BUILD_DIR/amd64/report.json" \
  --build-report "$BUILD_DIR/arm64/report.json" \
  --version "$AGENT_VERSION" --namespace YOUR_GITHUB_OWNER \
  --run --output "$PUBLISH_DIR"
npm run publish:agent -- --verify-public "$PUBLISH_DIR/release.json"
```

The project packages are `agentic-browser-agent`, `agentic-browser-service` and `agentic-browser-runtime`. Official infrastructure images are not repackaged. The first command writes `release.json` with immutable image references and `publication.json` with publication evidence. The second command prints an anonymous-pull receipt; it does not update `publication.json` or establish native installation acceptance. As with CI, make new packages Public before verification. This manual path does not create a GitHub Release.

## Native acceptance and delivery

On a native Linux test host for each target architecture, obtain the intended source and release manifest. Set `AGENT_VERSION` to that manifest's version and run from the repository root:

```bash
npm ci
mkdir -p output/tests
npm run accept:compose -- \
  --release /absolute/path/to/release.json \
  --work "$PWD/output/tests/release-$AGENT_VERSION" --port 3350
```

The work directory must be new and its parent must exist; ports 3350/3351 must be free. The test host needs Node.js 24+, Docker, Compose, OpenSSL, approximately 6 GiB of available RAM and the [deployment CPU/kernel prerequisites](DEPLOYMENT.md#1-prepare-a-linux-server). Tests use a separate project, without paid model calls or external mail. On both platforms, check `report.json` in the work directory for the correct version, architecture and image references, plus `passed: true`, `cleanup.passed: true` and `cleanup.remaining: 0`. QEMU builds do not replace native runtime acceptance.

Using the same release manifest and `AGENT_VERSION`, generate a platform-independent delivery directory:

```bash
mkdir -p output
npm run package:compose -- \
  --release /absolute/path/to/release.json \
  --output "$PWD/output/delivery-$AGENT_VERSION"
```

It contains eight files: `compose.yaml`, `settings.json`, `secrets.env`, `nginx.host.conf`, the three operator guides and `LICENSE`. The tool reads templates and guides from the current checkout; review and commit that source first. CI uses its checked-out GitHub commit. Image references come from the release manifest; mutable tags and overwriting an existing output directory are rejected. The parent directory must already exist.

The complete Actions release has 15 attachments:

| Assets | Purpose |
| --- | --- |
| `compose.yaml` | Services, fixed image references, networks and volumes |
| `settings.json`, `secrets.env` | Operator configuration templates with placeholders |
| `nginx.host.conf` | Host proxy template for public HTTPS access |
| `DEPLOYMENT.md`, `CONFIGURATION.md`, `OPERATIONS.md`, `LICENSE` | Installation, configuration, operations and project license |
| `release.json`, `publication.json` | Version/image manifest and publication evidence |
| `public-pull-amd64.json`, `public-pull-arm64.json` | Anonymous image-pull and native image-identity receipts |
| `compose-acceptance-amd64.json`, `compose-acceptance-arm64.json` | Native installation and cleanup evidence |
| `SHA256SUMS` | Checksums of the other 14 attachments |

Use Actions for complete release collection and publication. The manual commands above are individual maintainer tools, not an equivalent end-to-end release pipeline. Never attach filled-in operator configuration, test workspaces, backups or local data. The current delivery uses individual files; there is no universal deployment archive, host Node installer or offline image bundle. Operators start with [Deployment](DEPLOYMENT.md) and upgrade through [Operations](OPERATIONS.md).

Documentation updates ship with future releases. Keep existing checksummed attachments unchanged; release notes can link to a reviewed documentation commit for corrections to a published version.

## Retry a failed workflow

A runner-capacity notice concerns GitHub scheduling. The generic message `Operation failed; inspect local configuration and prerequisites` is a sanitized fallback, not evidence of a missing model key. Inspect the failed step, the preceding stage messages and any preserved non-secret report. Do not add production model, Turnstile or SMTP credentials to solve a build or simulated acceptance failure.

For a transient runner/registry failure or a corrected package-visibility setting, retry the failed jobs on the same commit. If code or workflow files changed, merge the fix to `main` and dispatch a new run: [GitHub's re-run action uses the original commit](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

After a tooling-only repair, `--build-run-id` can reuse both architecture build artifacts from an earlier run:

```bash
npm run release -- vX.Y.Z-preview.N --build-run-id RUN_ID
```

Use the earlier run's exact preview version and repository namespace, with both successful `build-amd64` and `build-arm64` artifacts still available. The overall earlier run may have failed after building. The new workflow revalidates source and image identities before reuse. Application, dependency, Dockerfile, package-version or image-contained operations changes require rebuilding; do not edit reports or overwrite an existing version with different images.

Old failed runs remain in Actions history. Use the successful run and native reports linked from the published release to determine that release's verification result.
