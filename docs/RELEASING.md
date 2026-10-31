# Publish images and deployment files

A release publishes the three project images from [Build](BUILD.md) to GHCR and delivers matching Compose and configuration templates. Deployment servers need only Docker and Compose. Publishing requires registry authorization, not site credentials. The project uses [MIT](../LICENSE), and images preserve applicable third-party licenses. Check the [release notes and verification reports](https://github.com/infrasika/agentic-browser/releases) for the version you intend to publish or deploy.

## Recommended: GitHub Actions

1. Update `package.json` and the lockfile on the development branch, for example `npm version 0.1.0-preview.12 --no-git-tag-version`. Choose an actual unused version.
2. Commit, push and open a PR. Merge to `main` after source checks pass, so the remote branch contains the intended release changes.
3. Install GitHub CLI, authenticate with `gh auth login`, and run from the repository root:

```bash
npm run release -- --dry-run
npm run release
```

The command reads the version from `package.json` and dispatches `Publish Agent preview` on remote `main`. Your local checkout may be on `feature`, but all release changes must already be merged remotely. The command does not commit, push, change versions or build locally. To specify the version explicitly, use `npm run release -- vX.Y.Z-preview.N`. The workflow accepts only `main` and the preview version format.

The pipeline performs:

1. Source and type checks on Ubuntu amd64, Ubuntu arm64 and macOS.
2. Native Linux builds on both architectures, validation against source reports and upload of architecture candidates.
3. Assembly of immutable multi-platform indexes and a six-image `release.json`, including pinned official Nginx, MongoDB and Redis images.
4. Anonymous image pulls and full Compose acceptance on two fresh native Linux runners.
5. Version, source, image, architecture and cleanup verification; creation of deployment files, checksums and a GitHub prerelease. It does not update `latest`.

Acceptance uses real Chrome with simulated model and TLS mail services. It covers account isolation, queueing, handoff/resume, credits, budgets, logout cleanup, password recovery, persistence, backups, restore, failed-upgrade rollback and daily backup scheduling. Deployment subprocesses have only Docker on PATH; the test driver itself uses the maintainer's Node environment. Real providers, public HTTPS, Turnstile and mailbox delivery still need deployment-specific acceptance.

The repository must allow the workflow's `contents: write` and `packages: write` permissions. The three GHCR packages must be Public for anonymous pull acceptance. Package visibility is separate from source repository visibility. Fork maintainers need publishing permissions in their own namespace; they do not receive the upstream project's credentials.

The optional workflow input `build_run_id` reuses a previous successful build stage after a packaging or acceptance-tool repair. All image inputs are compared with the current source. Application, dependency, Dockerfile or image-contained operations changes require rebuilding. Never edit reports to bypass verification.

## Manual publication from Mac or Ubuntu

First complete a committed, two-platform build of all three project images. Replace the example build directory with the directory printed by your build. The publication output directory must not exist:

```bash
AGENT_VERSION='v0.1.0-preview.12'
BUILD_DIR="$PWD/output/build/build-XXXXXX"
PUBLISH_DIR="$PWD/output/releases/$AGENT_VERSION"
```

The reports and matching images must be present in the current Docker daemon. Authenticate Docker to `ghcr.io`, preferably through Docker Desktop or your existing system credential store. Use appropriate GitHub Packages credentials interactively or with `--password-stdin`; do not put tokens in source, site configuration or shell history.

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

The project packages are `agentic-browser-agent`, `agentic-browser-service` and `agentic-browser-runtime`. Official infrastructure images are not repackaged. `release.json` records immutable image references; `publication.json` records publication evidence. Upload success does not establish native installation acceptance.

## Native acceptance and delivery

On a native Linux test host for each target architecture, obtain the intended source and release manifest:

```bash
npm ci
npm run accept:compose -- \
  --release /absolute/path/to/release.json \
  --work "$PWD/output/tests/release-$AGENT_VERSION" --port 3350
```

Set `AGENT_VERSION` on that host first. The work directory must be new, and ports 3350/3351 must be free. The test host needs Docker, Compose, OpenSSL and approximately 6 GiB of available RAM. Tests use a separate project, without paid model calls or external mail. On both platforms, check the report's version, architecture, image references, `passed: true`, `cleanup.passed: true` and `cleanup.remaining: 0`. QEMU builds do not replace native runtime acceptance.

Generate a platform-independent delivery directory:

```bash
npm run package:compose -- \
  --release "$PUBLISH_DIR/release.json" \
  --output "$PWD/output/delivery-$AGENT_VERSION"
```

It contains `compose.yaml`, `settings.json`, `secrets.env`, `nginx.host.conf`, the deployment/configuration/operations guides and `LICENSE`. The tool reads templates and guides from the current checkout; review and commit that source first. CI uses its checked-out GitHub commit. Image references come from the release manifest; mutable tags and overwriting an existing output directory are rejected.

The final Release also includes `release.json`, `publication.json`, both anonymous-pull receipts, both native acceptance reports and `SHA256SUMS` covering all other attachments. Prefer Actions for the final collection and publication. The configuration assets contain placeholders; never attach filled-in operator configuration, test workspaces, backups or local data.

These files deploy with Docker alone. There is no host Node installer or offline image bundle. Operators start with [Deployment](DEPLOYMENT.md) and upgrade using the container-based commands in [Operations](OPERATIONS.md).

The planned delivery improvement is a single versioned deployment archive for both Linux architectures, containing Compose, configuration examples and guides. It is not implemented or published yet. Before replacing the current individual-file download procedure, native CI must extract that exact archive and verify installation from it. Existing checksummed release assets remain unchanged; documentation updates ship with future releases.

## Troubleshooting a workflow failure

A runner-capacity notice concerns GitHub scheduling. The generic message `Operation failed; inspect local configuration and prerequisites` is a sanitized fallback, not evidence of a missing model key. Inspect the failed step, the preceding stage messages and any preserved non-secret report. Do not add production model, Turnstile or SMTP credentials to solve a build or simulated acceptance failure.

Old failed runs remain in Actions history after a repair. Use the run linked from the published release to determine its verification result. A repaired workflow needs a new run on the corrected commit; retrying an old commit does not apply the fix.
