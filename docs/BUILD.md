# Build images

Use the same source checkout on a Mac (Intel or Apple Silicon) or Ubuntu build host to produce Linux amd64/arm64 images. Continue with [Release](RELEASING.md) to publish them. To install an existing release, use [Deployment](DEPLOYMENT.md) instead.

## 1. Prepare the build host

| Dependency | Requirement |
| --- | --- |
| Node.js / npm | Node.js 24+ and its bundled npm |
| Git / tar | Committed-source export and archive handling |
| Docker / Buildx | Docker Engine 28+, API 1.48+ and Buildx; a running Docker Desktop on Mac |
| Dockerfile frontend | 1.19+; `syntax=docker/dockerfile:1` fetches the stable frontend with the required COPY features ([reference](https://docs.docker.com/reference/dockerfile/)) |
| Disk and network | At least 30 GiB free, with additional space for two architectures and retained images; access to GitHub, npm, registries, Chrome and extension downloads |

The default temporary builder is limited to two CPUs and 5 GiB RAM. Give Docker Desktop's VM enough additional memory for the daemon and other containers. Python is not a host requirement for these image builds; native npm build dependencies such as Python, make and g++ are installed in the Docker build stage.

```bash
node --version
npm --version
git --version
tar --version
docker version
docker buildx version
```

`docker version` must show a reachable Server. Build and publication must use the same Docker daemon because the publication tool checks the local images against their build reports.

## 2. Clone and check source

Run subsequent commands from the repository root:

```bash
git clone --branch main https://github.com/infrasika/agentic-browser.git
cd agentic-browser
npm ci
npm run check
npm test
git status --short
```

In an existing checkout, select the intended commit and run `npm ci`. Do not copy `node_modules` between operating systems. Review and commit release changes before building: `--committed` exports Git's committed tree and excludes uncommitted files.

**No site credentials are needed to build.** A fresh clone should not contain `config/local/`, `.deployment/` or a root `.env`. Do not copy these from an existing server. The public configuration examples describe deployment inputs; the container initializer generates application identity keys. See [Configuration](CONFIGURATION.md).

## 3. Build the target platforms

Choose an unused release version and follow the version-update step in [Release](RELEASING.md) before preparing a release. The version below is an example, not a claim that it has been published:

```bash
AGENT_VERSION='v0.1.0-preview.12'
npm run build:agent -- --committed \
  --platforms linux/amd64,linux/arm64 \
  --tag "$AGENT_VERSION"
```

The `--` after an npm script forwards the remaining arguments. `build:agent` already includes `--run`.

| Option | Purpose |
| --- | --- |
| `--committed` | Build committed source; required for publication |
| `--platforms linux/amd64,linux/arm64` | Build both platforms, or specify just one |
| `--tag VERSION` | Local image version, kept consistent through publication |
| `--builder NAME` | Reuse an existing Buildx builder or native multi-node setup |
| `--component agent\|browser\|runtime` | Rebuild one component during development; a release requires all three |

Development builds may omit `--committed` to use working-tree versions of tracked files. Untracked files are excluded: stage new source files before building them. Such reports cannot be used for verified publication.

The builder:

1. Fetches the public LibreChat commit locked in `integrations/librechat/source.lock.json`, applies the customization patch and checks its digest, complete Git tree, license and browser contract.
2. Downloads and verifies Chrome and extension assets locked in `runtime/assets.lock.json`, caching them in `output/runtime/packages/`.
3. Builds and loads Agent, Browser Service and Chrome runtime images separately for each platform.
4. Saves per-platform build reports and component logs. Verification failure stops the build rather than substituting an unpinned download.

Docker Desktop provides cross-architecture emulation. Linux builders can use QEMU or native nodes. Check an existing builder with `docker buildx inspect NAME --bootstrap`; see [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/). Emulated builds can be substantially slower. The tool removes its temporary builder when finished; a builder supplied with `--builder` remains under your control.

## 4. Inspect the output

The command prints its actual build directory:

```text
output/build/build-XXXXXX/
├── reports.json
├── amd64/
│   ├── report.json
│   └── agent.log / browser.log / runtime.log
└── arm64/
    ├── report.json
    └── agent.log / browser.log / runtime.log
```

Each complete report must have `passed: true`, `sourceMode: committed` and `agent`, `browser`, `runtime` entries in `images`. It records the platform, source commit, LibreChat tree, asset digests and image IDs. Keep both the reports and their corresponding local images; copying reports to an empty Docker host is insufficient for publication.

Image names are:

```text
agentic-browser-agent:VERSION-amd64
agentic-browser-service:VERSION-amd64
agentic-browser-runtime:VERSION-amd64
# The arm64 equivalents use VERSION-arm64.
```

Publication pins and verifies official MongoDB, Redis and Nginx images rather than rebuilding them. Source and major assets are locked, but APT/npm downloads still require network access; builds are not claimed to be byte-for-byte reproducible.

## 5. Publish and verify

Set `BUILD_DIR` to the actual output directory in [Release](RELEASING.md). Do not edit reports, reuse a version for unrelated contents or delete images still needed for publication.

A successful build is not runtime acceptance. Deployment targets are Linux; Mac is a build and publication host. Verify each target on its native Linux architecture. macOS source checks skip two Linux-only `flock` tests and do not prove a Mac Docker build. See the release's acceptance reports for verified coverage and [Development](DEVELOPMENT.md) for test entry points.
