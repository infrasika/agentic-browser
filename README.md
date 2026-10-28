# Agentic Browser

A chat Agent with a private remote browser beside the conversation. The Agent opens a website, hands control to you for sign-in or confirmation, then continues in the same browser when you click Done.

**[Public demo](https://agentic-browser.zkpass.org/) · [Demo guide](docs/AGENT_DEMO.md) · [Complete Agent installation](deploy/agent/INSTALL.md) · [Development progress](docs/plans/PROGRESS.md)**

## Try the demo

Register a local account and open a chat. The GitHub example asks you to sign in inside the remote browser, then counts and lists the private repositories owned by your account. Complete sign-in while you have control and return control to the Agent; the task resumes automatically. Keep passwords and verification codes in the remote browser.

Each user has a separate account, chat history, credits and browser session. The public service has a shared daily budget and a queue when browser capacity is full. Administrators can manage access and budget through the application. A remote browser does not inherit your laptop's website login.

The public site includes the Agent and model. You do not need an external MCP client. Browser control is available only to the authenticated Agent backend.

## Deploy the complete Agent

The self-hosting target is a versioned bundle and prebuilt images, with only Python and Docker on the host. It includes:

- LibreChat: chat, local accounts, native Agent tools, credits and a site budget.
- Browser Service: per-user sessions, queueing, live display, control handoff and Chrome lifecycle.
- Private MongoDB and Redis, plus one HTTP gateway. Only the gateway publishes a loopback port.

The [self-hosting guide](deploy/agent/INSTALL.md) walks through server prerequisites, package verification, every required setting and secret, HTTPS, first login, email and acceptance. The official public deployment path uses Cloudflare DNS/proxy, Full (strict) TLS and Turnstile. Configure your own Qwen model and rates once in private files; no deployment secrets are needed to build an image.

Registration stays closed until you enable it. Local users, credits and browser isolation use the same application in both modes; there is no second deployment stack. SMTP password recovery is optional, with Cloudflare Email Sending documented as one provider. Closed registration and local SSH testing remain available without Cloudflare or OAuth.

**Current status: Linux amd64 installation candidate.** Same-host installation, real-browser and recovery checks have been established with no host Node on PATH; source changes must pass those checks again before a new candidate is accepted. Independent new-server acceptance and public Agent image publication are pending. Candidate bundles can include all six fixed images for transfer to a test server.

Data lives in the installation’s `data/` directories, mounted into the database and application containers. The current test domain runs this complete Compose layout; its operator runbook is [here](docs/DEPLOYMENT.md).

See [installation](deploy/agent/INSTALL.md), [operations](deploy/agent/OPERATIONS.md), and [release preparation](deploy/agent/RELEASING.md). Start with one browser and validate capacity on your own host. Linux amd64 is the supported target.

Maintainers can build Linux amd64 and arm64 images from this one repository on Mac or Ubuntu. The [build and GHCR guide](deploy/agent/RELEASING.md) covers pinned LibreChat source, locked browser assets, Docker/Keychain credentials and multi-platform GHCR tags. Native ARM64 deployment and Mac execution require separate acceptance. [Configuration](deploy/agent/CONFIGURATION.md) explains the installation's `config/` directory, Compose secrets and generated `.env`.

## Project boundaries

The source has two application boundaries in one reproducible checkout:

| Project | Responsibility |
| --- | --- |
| `agentic-browser` (this repository) | Browser Service, Chrome runtime, private HTTP API and `deploy/agent/` packaging/operations |
| `integrations/librechat/` | Pinned upstream source and tracked customizations for the chat interface, accounts, native tools and accounting |

The Agent calls Browser Service over a private authenticated interface. Browser features are native Agent tools; MCP is not part of this deployment. Browser Service alone receives the Docker socket to create isolated runtimes. Each Chrome runtime receives only its session’s egress socket directory; model keys and database volumes stay outside it.

The deployment administrator controls the host and stored data. The configured cloud model receives prompts and tool results. During human control, Agent browser actions and observation are suspended; after you return control the Agent can read the signed-in page.

[Architecture](docs/ARCHITECTURE.md) and [development plan](docs/plans/DEVELOPMENT.md) describe the implementation and acceptance boundaries. Build and test commands are in [deploy/agent/README.md](deploy/agent/README.md). End users do not need the source checkouts or host Node.js.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `integrations/librechat/` | Upstream source lock, reviewed customization patch and license; no separate checkout required |
| `src/` | Browser Service and browser runtime application code |
| `runtime/` | Chrome image Dockerfile, extension installer, locked versions and sandbox policy; these are build inputs |
| `deploy/agent/` | Complete Agent Compose template, application startup configuration and installation/operations tools |
| `scripts/build/` | Fetch browser assets, build images, package releases and publish to GHCR |
| `scripts/sync-browser-contract.mjs` | Keep the private browser protocol synchronized with the LibreChat checkout |
| `test/` | Unit and integration tests; `test/acceptance/` holds end-to-end runners and fixtures |
| `docs/` | Architecture, server runbook, development plan and progress |
| `output/` | Untracked build work, downloaded packages, acceptance results and release artifacts |
| `.deployment/` | Untracked local installations, private settings, persistent data and recovery archives |

`deploy/` contains reusable source templates; `.deployment/` contains this server's installations. The active site is `.deployment/agent-site/`, with configuration in `config/` and persistent data in `data/`. Historical recovery material is grouped under `.deployment/archive/`. Do not delete an installation as if it were a build cache.

Build logs and reports go to `output/build/`; temporary acceptance installations go to `output/tests/`. `.playwright-cli/`, when created by browser debugging tools, contains local snapshots and console logs and is not an application dependency.

## Distribution notices

Chrome and the zkPass extensions are locked in [runtime/assets.lock.json](runtime/assets.lock.json). Preserve the [third-party distribution notices](runtime/DISTRIBUTION-NOTICES.md), [Playwright license](runtime/PLAYWRIGHT-LICENSE), LibreChat MIT license and dependency licenses when distributing images. The installation bundle includes the applicable top-level notices. No website login profile or deployment secrets belong in a release.
