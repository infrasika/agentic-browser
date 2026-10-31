# Publish images and deployment files

For maintainers publishing a new version to GHCR and GitHub Releases. To install an existing version, follow [Deployment](DEPLOYMENT.md). Use GitHub Actions for the complete publication pipeline; the manual tools below support individual stages.

| Command | Result |
| --- | --- |
| `npm run release` | Dispatches the complete GitHub Actions workflow; completion must be checked in Actions |
| `npm run publish:agent -- ... --run` | Publishes images and writes `release.json` / `publication.json`; does not create a GitHub Release |
| `npm run package:compose -- ...` | Writes deployment files locally; does not build, upload, run acceptance or generate final checksums |

## Recommended: GitHub Actions

Run from a source checkout with Node.js 24+/npm and an authenticated [GitHub CLI](https://cli.github.com/). Local Docker and site credentials are not needed for this path. The authenticated account needs permission to dispatch Actions on the target repository. For a fork, enable Actions and confirm GitHub CLI targets your fork, for example with `gh repo set-default OWNER/REPOSITORY`.

1. Choose an unused prerelease version: `X.Y.Z-rc.N` for a release candidate or `X.Y.Z-preview.N` for a preview. Update `package.json` and the lockfile on the development branch, for example `npm version 0.1.0-rc.1 --no-git-tag-version`. This command creates no Git tag.
2. Commit, push and open a PR. Merge to `main` after source checks pass, so the remote branch contains the intended release changes.
3. Authenticate with `gh auth login` if needed. From the repository root, confirm the intended version and dispatch:

```bash
npm run release -- --dry-run
npm run release
```

The command reads the local `package.json` version and dispatches `Publish Agent prerelease` on remote `main`; it does not commit or push. An explicit version is accepted as `npm run release -- vX.Y.Z-rc.N` (or `vX.Y.Z-preview.N`) and must match the version committed to `main`. `--dry-run` only prints the command, without checking remote state or permissions. Find the dispatched run and wait for completion, replacing `RUN_ID` with its actual number:

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

See [Full Compose acceptance](DEVELOPMENT.md#full-compose-acceptance) for test coverage and report requirements. CI uses simulated providers; real model, HTTPS, Turnstile and mailbox checks belong to [deployment verification](DEPLOYMENT.md#7-choose-registration-policy-and-verify-features).

The repository must allow the workflow's `contents: write` and `packages: write` permissions. CI uses its automatic `GITHUB_TOKEN`; do not add model, Turnstile or SMTP credentials as Actions secrets. Fork maintainers publish into their own repository-owner namespace.

The three GHCR packages must be **Public** for anonymous pull acceptance. On first publication into a new namespace, newly created packages default to Private. Open each package's settings, grant the workflow repository access if necessary and change its visibility to Public before retrying anonymous verification. Public source code does not make packages public automatically. See [GitHub's registry authentication and visibility rules](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Manual publication from Mac or Ubuntu

First complete a committed, two-platform build of all three project images. Replace the example build directory with the directory printed by your build. The publication output directory must not exist:

```bash
AGENT_VERSION='v0.1.0-rc.1'
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

The packages are `agentic-browser-agent`, `agentic-browser-service` and `agentic-browser-runtime`; official infrastructure images are not repackaged. Publication writes the two manifest/evidence files listed above. Anonymous verification prints a receipt without updating `publication.json`. Make new packages Public before verification.

## Acceptance and delivery

Before delivery, run [Full Compose acceptance](DEVELOPMENT.md#full-compose-acceptance) against the published manifest on native Linux amd64 and arm64. Both reports must match the intended release and pass cleanup. Actions performs this automatically.

To inspect deployment files locally, set `AGENT_VERSION` to the manifest's version and run:

```bash
mkdir -p output
npm run package:compose -- \
  --release /absolute/path/to/release.json \
  --output "$PWD/output/delivery-$AGENT_VERSION"
```

The output directory must be new, with an existing parent. Packaging reads templates and guides from the current checkout and fixed image references from the manifest; review and commit that source first. Mutable tags are rejected.

The final Actions release has 15 attachments. The first eight come from `package:compose`; the remaining seven are collected or generated by CI:

| Assets | Source |
| --- | --- |
| `compose.yaml` | Compose template rendered with release image digests |
| `settings.json`, `secrets.env` | Public examples in `config/`; never operator-filled files |
| `nginx.host.conf` | Template in `deploy/agent/` |
| `DEPLOYMENT.md`, `CONFIGURATION.md`, `OPERATIONS.md`, `LICENSE` | Maintained guides in `docs/` and the root license |
| `release.json`, `publication.json` | Image publication stage |
| `public-pull-amd64.json`, `public-pull-arm64.json` | Anonymous pulls and native image-identity verification |
| `compose-acceptance-amd64.json`, `compose-acceptance-arm64.json` | Native acceptance runs |
| `SHA256SUMS` | Final collection; covers the other 14 attachments |

The current delivery uses individual files, without an installer or offline image bundle. Keep test workspaces, backups and local credentials out of release assets. Operator-facing file definitions belong in [Configuration](CONFIGURATION.md#deployment-files).

Documentation updates ship with future releases. Keep existing checksummed attachments unchanged; release notes can link to a reviewed documentation commit for corrections to a published version.

## Retry a failed workflow

A runner-capacity notice concerns GitHub scheduling. The generic message `Operation failed; inspect local configuration and prerequisites` is a sanitized fallback, not evidence of a missing model key. Inspect the failed step, the preceding stage messages and any preserved non-secret report. Do not add production model, Turnstile or SMTP credentials to solve a build or simulated acceptance failure.

For a transient runner/registry failure or a corrected package-visibility setting, retry the failed jobs on the same commit. If code or workflow files changed, merge the fix to `main` and dispatch a new run: [GitHub's re-run action uses the original commit](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

After a tooling-only repair, `--build-run-id` can reuse both architecture build artifacts from an earlier run:

```bash
npm run release -- vX.Y.Z-rc.N --build-run-id RUN_ID
```

Use the earlier run's exact prerelease version and repository namespace, with both successful `build-amd64` and `build-arm64` artifacts still available. The overall earlier run may have failed after building. The new workflow revalidates source and image identities before reuse. Application, dependency, Dockerfile, package-version or image-contained operations changes require rebuilding; do not edit reports or overwrite an existing version with different images.

Old failed runs remain in Actions history. Use the successful run and native reports linked from the published release to determine that release's verification result.
