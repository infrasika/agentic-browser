# Build images

Build local Linux amd64/arm64 images from the same source on Mac (Intel or Apple Silicon) or Ubuntu. This guide covers the build host, commands and output. Use [Release](RELEASING.md) for publication and [Deployment](DEPLOYMENT.md) to install an existing release.

## 1. Prepare the build host

| Dependency | Requirement |
| --- | --- |
| Node.js / npm | Node.js 24+ and its bundled npm |
| Git / tar | Committed-source export and archive handling |
| Docker / Buildx | Docker Engine 28+, API 1.48+ and Buildx; a running Docker Desktop on Mac |
| Dockerfile frontend | 1.19+; `syntax=docker/dockerfile:1` fetches the stable frontend with the required COPY features ([reference](https://docs.docker.com/reference/dockerfile/)) |
| Disk and network | At least 30 GiB free, with additional space for two architectures and retained images; access to GitHub, npm, registries, Chrome and extension downloads |

The default temporary builder is limited to two CPUs and 5 GiB RAM. Allow additional memory for Docker and other containers. Native build dependencies are installed inside Docker; the host does not need Python.

```bash
node --version
npm --version
git --version
tar --version
docker version
docker buildx version
```

`docker version` must show a reachable Server.

## 2. Clone and check source

Run subsequent commands from the repository root:

```bash
git clone --branch main https://github.com/infrasika/agentic-browser.git
cd agentic-browser
npm ci
git status --short
```

In an existing checkout, select the intended commit and run `npm ci`. Complete the [source checks](DEVELOPMENT.md#tests-and-npm-entry-points) and commit release changes before building: `--committed` exports Git's committed tree and excludes uncommitted files.

**No site credentials are needed to build.** A fresh clone is sufficient; model keys and other [deployment configuration](CONFIGURATION.md) are supplied on the deployment server.

## 3. Build the target platforms

For a release, complete the [version preparation](RELEASING.md#recommended-github-actions) first. The tag below is an example:

```bash
AGENT_VERSION='v0.1.0-rc.3'
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

The builder verifies the pinned LibreChat source and customization patch against `integrations/librechat/source.lock.json`, including the tree, license and browser contract. It downloads and verifies Chrome/extension assets from `runtime/assets.lock.json`, caching them in `output/runtime/packages/`, then builds and loads the three images for each platform. A verification failure stops the build.

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

For a complete release build, each platform's `report.json` must have `passed: true`, `sourceMode: committed` and `agent`, `browser`, `runtime` entries in `images`. It records the platform, source commit, LibreChat tree, asset digests and image IDs. Development or single-component reports do not satisfy these release requirements.

Image names are:

```text
agentic-browser-agent:VERSION-amd64
agentic-browser-service:VERSION-amd64
agentic-browser-runtime:VERSION-amd64
# The arm64 equivalents use VERSION-arm64.
```

Source and major assets are locked, but APT/npm downloads still require network access; builds are not claimed to be byte-for-byte reproducible.

Keep the reports and local images together. Continue with [manual publication](RELEASING.md#manual-publication-from-mac-or-ubuntu), setting `BUILD_DIR` to the printed directory and using the same Docker daemon. Runtime testing is documented in [Development](DEVELOPMENT.md#full-compose-acceptance).
