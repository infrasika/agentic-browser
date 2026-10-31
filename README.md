# Agentic Browser

A chat Agent with a private remote browser beside the conversation. The Agent opens a website, hands control to you for sign-in or confirmation, then continues in the same browser when you click Done.

**[Self-hosting](docs/DEPLOYMENT.md) · [Documentation](#documentation) · [Build](docs/BUILD.md) · [Release](docs/RELEASING.md)**

The application combines LibreChat, native browser tools and isolated Chrome sessions; no separate MCP installation is required. It includes local accounts, per-user credits, a shared daily budget, queueing, an administrator interface and optional email password recovery. Registration is closed by default.

The GitHub demo asks you to sign in inside the remote browser, then counts and lists your own private repositories. Enter website credentials while you have control. After you return control, the Agent can read signed-in pages and send tool results to the configured model.

## Self-host

Use the matching release's `compose.yaml`, `settings.json` and `secrets.env`. Fill in the model settings and credentials, then run `docker compose up -d`. The server needs only Docker Engine and Compose. Initialization, generated keys and operations run inside containers; data persists in project-specific named volumes. MongoDB, Redis and browser control stay private.

Start with [Deployment](docs/DEPLOYMENT.md) for a complete installation and its verified release version. Use matching files from that release; older preview packages can have a different installation layout.

Download deployment files from [GitHub Releases](https://github.com/infrasika/agentic-browser/releases). New clones include [settings](config/settings.example.json) and [credential](config/secrets.env.example) examples. Optional local settings belong in ignored `config/local/`; no server configuration or `.deployment/` directory is required to build. Published images use immutable digests and support anonymous pulls.

## Build and contribute

Mac and Ubuntu use the same source checkout and Node.js 24+/npm tools. Model keys and Cloudflare credentials are deployment inputs, never build inputs. Deployment targets are Linux amd64 and arm64; each [release](https://github.com/infrasika/agentic-browser/releases) includes its verification reports.

```bash
npm ci
npm run check
npm test
```

## Documentation

| Task | Guide |
| --- | --- |
| Install on a Linux server, with registration closed or open | [Deployment](docs/DEPLOYMENT.md) |
| Set parameters and credentials; understand `.env`, proxy files and persistent volumes | [Configuration](docs/CONFIGURATION.md) |
| Manage accounts, email, backups, restores and upgrades | [Operations](docs/OPERATIONS.md) |
| Understand components, identity, storage and isolation | [Architecture](docs/ARCHITECTURE.md) |
| Change source, maintain the LibreChat patch and run tests | [Development](docs/DEVELOPMENT.md) |
| Build Linux amd64/arm64 images on Mac or Ubuntu | [Build](docs/BUILD.md) |
| Publish images, verify them and deliver deployment files | [Release](docs/RELEASING.md) |

Building reads source and public dependencies. Publishing uses registry credentials. Deployment supplies model, site and optional mail credentials. The same images support different domains and operator configurations.

## Repository layout

| Path | Contents | Tracked in Git? |
| --- | --- | --- |
| `src/` | Browser Service, scheduling, streaming and isolated runtime | Yes |
| `integrations/librechat/` | Upstream source lock, customization patch and upstream license | Yes |
| `runtime/` | Chrome Dockerfile, extension installer, asset lock, sandbox rules and licenses | Yes |
| `deploy/agent/` | Dockerfiles, host Nginx template, application setup and shared tools | Yes |
| `deploy/compose/` | Compose template, container operations and Docker CLI licenses | Yes |
| `config/settings.example.json`, `config/secrets.env.example` | Public configuration examples with no real credentials | Yes |
| `config/local/` | Optional local `settings.json` and `secrets.env` | No |
| `scripts/build/` | Source preparation, asset downloads, image builds and publication | Yes |
| `scripts/sync-browser-contract.mjs` | Browser API contract synchronization | Yes |
| `test/` | Unit tests, tooling tests and full acceptance drivers | Yes |
| `docs/` | Maintained English guides | Yes |
| `output/` | Download caches, build logs, candidate packages and test evidence | No |
| `.deployment/` | Local Compose deployments and backups; not a build input | No |

Release packaging copies `DEPLOYMENT.md`, `CONFIGURATION.md` and `OPERATIONS.md` from `docs/`; there is no separately maintained set of installation guides. Third-party license texts remain beside the relevant components.

Preserve the named volumes and completed backups of running installations. Before deleting local output, check whether a release or backup is needed for recovery. Browser-debugging output in `.playwright-cli/` is not a runtime dependency.

## License

Agentic Browser is licensed under the [MIT License](LICENSE). Bundled components and dependencies retain their own licenses.
