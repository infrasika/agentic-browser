# Documentation

Agentic Browser combines chat, a remote browser, local accounts and usage budgets. LibreChat calls a private Browser Service through native Agent tools. Deploy the complete application with Docker Compose; no separate MCP installation is required.

## Choose a guide

| Task | Guide |
| --- | --- |
| Understand components, identity, storage and isolation | [Architecture](ARCHITECTURE.md) |
| Change source, maintain the LibreChat patch and run tests | [Development](DEVELOPMENT.md) |
| Build Linux amd64/arm64 images on Mac or Ubuntu | [Build](BUILD.md) |
| Publish images, verify them and prepare deployment files | [Release](RELEASING.md) |
| Install on a Linux server, with registration closed or open | [Deployment](DEPLOYMENT.md) |
| Set parameters and credentials; understand `.env`, proxy files and persistent volumes | [Configuration](CONFIGURATION.md) |
| Manage accounts, mail, backups, restores and upgrades | [Operations](OPERATIONS.md) |

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
| `docs/` | Maintained guides | Yes |
| `output/` | Download caches, build logs, candidate packages and test evidence | No |
| `.deployment/` | Local Compose deployments and backups; not a build input | No |

The root README is the project entry point. Third-party license texts remain beside the relevant components. Release packaging copies `DEPLOYMENT.md`, `CONFIGURATION.md` and `OPERATIONS.md` from this directory; there is no separately maintained set of installation guides.

A fresh clone needs no files from a maintainer's deployment. Preserve the named volumes and completed backups of running installations. Before deleting local output, check whether a verified release or backup is still needed for recovery. Browser-debugging output in `.playwright-cli/` is not a runtime dependency.
