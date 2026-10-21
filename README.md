# Agentic Browser

**A shared remote Chrome browser for your Agent and you.**

Your Agent opens a website and works on your task. When a step needs a person—sign-in, a verification code, or a manual confirmation—it sends you a browser link. You take control, complete that step, and hand the same browser back. The Agent then continues with the signed-in page.

The browser runs on the deployment host. You interact with its live display in a web page; you do not need to install a separate desktop viewer or give the Agent control of your everyday local Chrome.

**[Official demo](https://agentic-browser.zkpass.org/) · [Public demo guide](docs/PUBLIC_DEMO.md) · [Self-hosting guide](docs/SELF_HOST.md) · [Version status](docs/STATUS.md)**

## What it does

- **Browser tools for external Agents.** Connect Codex, Claude Code or another Streamable HTTP MCP client to create browsers, navigate, interact with pages and read results.
- **Human handoff in the same session.** Sign in through the remote display, then return control without starting a different browser.
- **Exclusive control.** Agent browser tools cannot observe the page, take screenshots or send actions while the person has control.
- **Private browser sessions.** Each session receives a separate runtime and profile. Personal Agent tokens control access to your sessions and saved logins.
- **Bounded browser lifetimes.** Session limits, expiry reminders, renewal, display reconnection and cleanup help manage a shared host.
- **Optional saved logins.** Self-hosted members can explicitly save a profile and grant an Agent credential access to it. Public demo sessions remain temporary.
- **Image-based deployment.** Two public images support native Linux amd64 and arm64, including Docker Desktop on Apple Silicon. The runtime includes Google Chrome, zkPass TransGate and zkPass Schema Validator.

Agentic Browser provides the browser tools and human interface. Bring your own Agent and its model/provider configuration; there is no built-in LLM or payment requirement.

## How a task works

1. **The Agent starts a browser** and opens the target website.
2. **The Agent sends you a handoff link.** Open it and click **Connect and take control** on the public demo.
3. **You complete the private input step.** Click inside remote Chrome and type directly. Keep passwords and verification codes in the remote browser, not the Agent conversation.
4. **You click Hand back to Agent.** The Agent can now read and operate the signed-in page.
5. **The Agent reports the result and closes the session.** Temporary browser data is removed during cleanup.

A session is one continuous browser environment. It is reused across tool calls until closed or expired; the service does not create a fresh browser for every click. A disconnected viewer can reconnect while its session remains active.

## Try the public demo

Open **https://agentic-browser.zkpass.org/** to see available browser slots and copy the setup prompt. No Agentic Browser registration, API key, Docker installation or source checkout is required. Your Agent client may have its own account requirements.

### Connect your Agent

Choose the command for your installed client:

**Codex CLI**

```sh
codex mcp add agentic-browser --url https://agentic-browser.zkpass.org/mcp
codex mcp get agentic-browser
```

**Claude Code**

```sh
claude mcp add --transport http --scope user agentic-browser https://agentic-browser.zkpass.org/mcp
claude mcp get agentic-browser
```

Reconnect tools or start a new Agent session after setup. In Claude Code, use `/mcp` to inspect the connection. Follow any client-side tool approval prompts. See the [client reference](https://code.claude.com/docs/en/mcp) for Claude-specific configuration options.

For clients with JSON MCP settings:

```json
{
  "mcpServers": {
    "agentic-browser": {
      "type": "http",
      "url": "https://agentic-browser.zkpass.org/mcp"
    }
  }
}
```

Use the `/mcp` endpoint for tools; `/view` and `/connect` are human-facing pages.

### Send a task

> Open GitHub in Agentic Browser and send me a link to sign in. Wait until I hand control back, then count all the private repositories I own and list their names. Check every page and close the browser when finished.

Open the **complete link provided by your Agent**, sign in to GitHub inside the remote browser, and click **Hand back to Agent**. If the Agent's turn ended while waiting, tell it you have handed control back and ask it to continue in the same session. Your laptop's existing GitHub login is not automatically available in the remote browser.

For a test without a website account:

> Open https://example.com in Agentic Browser and send me a link to take control. Wait until I hand control back, then read the page title, report it, and close the browser.

### Demo limits

| Limit | Official demo |
| --- | --- |
| Total concurrent browsers | 5 |
| Concurrent browsers per source IP | 2; users behind the same NAT may share this quota |
| Initial session lifetime | 5 minutes |
| Maximum total session lifetime | 10 minutes, including extensions |
| Handoff link | Single use, valid for 2 minutes |
| Saved login profiles | Unavailable |

The homepage and MCP capacity response show current usage. When full, wait and retry later. Waiting in chat does not renew a session; use **Extend session** before it expires, within the maximum lifetime.

If only the handoff link expired, ask the Agent for a fresh link to the existing session. If the session expired, create a new browser and sign in again. See the [complete public demo guide](docs/PUBLIC_DEMO.md) for troubleshooting and privacy details.

## Run your own workspace

Use a self-hosted installation for regular personal work. The public installer uses these images, fixed by digest:

- `ghcr.io/infrasika/agentic-browser-controller` — website, identities, MCP and browser lifecycle management.
- `ghcr.io/infrasika/agentic-browser-runtime` — Chrome and the remote desktop/browser environment; also used for per-session egress proxies.

The controller runs continuously and creates browser containers on demand. You do not need to start a shared runtime container yourself.

### Requirements

- Docker Engine **26+**, Docker Compose **2.24.4+**, and Bash.
- Ubuntu amd64/arm64, or Docker Desktop with a running Linux engine on an Apple Silicon Mac.
- A local Unix-socket Docker context on the deployment host. For remote Ubuntu, run installation commands in that server's SSH session.

Docker selects the image architecture automatically. Start with one browser and increase capacity after checking host resources under your workload. The Agent's machine does not need Docker when connecting to the workspace over HTTP MCP.

### Install and start

```sh
curl -fsSL https://agentic-browser.zkpass.org/install.sh -o install-agentic-browser.sh
# Inspect the downloaded script if desired, then run:
bash install-agentic-browser.sh agentic-browser
cd agentic-browser
```

The installer pulls both public images and creates only `compose.yaml` and `.env`. It refuses to overwrite existing installation files. No source checkout, image build, host Node.js or registry login is required.

Edit `.env` and set your own initial credentials:

```dotenv
AB_MODE=authenticated
AB_ADMIN_USERNAME=admin
AB_ADMIN_PASSWORD='replace-with-your-own-long-password'
AB_PORT=3333
AB_MAX_SESSIONS=1
```

Use a unique password of 12–256 characters and keep `.env` private. Then start the service:

```sh
docker compose up -d --wait --wait-timeout 90
docker compose ps
docker compose exec controller npm run doctor
```

Open **http://127.0.0.1:3333**, sign in, and create a **personal Agent credential** in the dashboard. Click **Copy MCP configuration**, add it to your Agent, and reconnect. The private MCP URL is `http://127.0.0.1:3333/mcp`; it requires that credential as a Bearer token. Your workspace password and a website login cookie are not Agent tokens.

The initial account is created only in an empty workspace. Changing bootstrap settings never resets an existing password. Use separate tokens for different Agents. Existing account isolation is retained for compatibility; team collaboration features are outside the product scope.

For remote access, use an SSH tunnel or configure an HTTPS domain. Your Mac's `localhost` cannot address a remote Ubuntu service without forwarding. Both the website and MCP use the same configured host port.

The [complete self-hosting guide](docs/SELF_HOST.md) covers Codex/Claude configuration, all supported settings, account recovery, saved profiles, domain/proxy setup, backup, upgrades and recovery. Server settings live in `.env`; apply changes with `docker compose up -d --force-recreate --wait` after active sessions finish. Preserve the named data volume for accounts and saved profiles.

## Choose an access mode

| | Official public demo | Self-hosted authenticated workspace |
| --- | --- | --- |
| Intended use | Try the browser/handoff flow | Regular personal work |
| Workspace login | Not required | Your private workspace account |
| Agent authority | A secret capability for each created session | Personal Bearer credential with explicit permissions |
| Website login state | Temporary; removed on close/expiry | Temporary by default; saved profiles are opt-in |
| Capacity and lifetime | Fixed demo limits above | Deployment settings within supported bounds |
| Infrastructure operator | Official demo operator | You or your organization's administrator |

You can also run your own anonymous demo with `AB_MODE=public`. Give it a separate installation directory, project name and volume from your private workspace. The [self-hosting guide](docs/SELF_HOST.md#run-your-own-public-demo) includes the configuration.

## Isolation and trust

Only the controller mounts the Docker socket. This is daemon-wide management permission used to create and clean up runtime resources. Browser containers do not receive the socket or the entire workspace data volume. They run as non-root with Chrome's sandbox enabled and use a controlled egress proxy that rejects internal, metadata and management destinations.

These controls separate visitors, members and Agent credentials. The deployment administrator still controls the host and stored data. After handback, the authorized Agent can read the signed-in page. Keep handoff links and personal tokens private; do not share a workspace account or credential when you need member isolation.

A controller restart ends active sessions; saved profiles can be opened in new sessions afterward. Display reconnection does not recover an expired browser. Website anti-bot checks, login restrictions and website-side session expiry still apply. The bundled extensions do not establish live zkPass proof success. See [Architecture](docs/ARCHITECTURE.md) for the implementation boundaries.

## Current version

The product scope is **personal self-hosting plus a public demo**. Team collaboration, invitations and role management are not planned. Existing identity boundaries remain in place.

The current stable release is **`v0.1.0`**, promoting the application behavior accepted in preview.5. Its controller includes personal onboarding, the workspace status panel, improved connection messages and viewer cleanup. The official website and installer use the same published images, fixed by the references in [deploy/release.env](deploy/release.env).

Both `ghcr.io/infrasika/agentic-browser-controller:latest` and `ghcr.io/infrasika/agentic-browser-runtime:latest` point to `v0.1.0`. Future stable releases advance these aliases; preview versions and older stable versions do not. Fixed `:v0.1.0` tags remain available. The installer continues to pin exact image digests; installed workspaces do not upgrade automatically.

The historical tag `freeze-2026-10-21` remains unchanged. See [Version status](docs/STATUS.md) for acceptance receipts and limitations. Image publication, deployment and post-publication acceptance are recorded separately; image-bundled documents are build-time snapshots, while the official downloadable guides track current acceptance.

Recorded checks cover native Ubuntu amd64/arm64 installation, public MCP isolation/capacity, human handoff, saved profiles, backup-based rollback, sustained workloads and HTTPS transport. Linux arm64 CI and physical Apple Silicon acceptance are separate. See [Version status and evidence](docs/STATUS.md) for exactly what passed and the remaining limitations.

## Documentation

| Document | Audience and contents |
| --- | --- |
| [Public demo guide](docs/PUBLIC_DEMO.md) | Visitors: setup, tasks, handoff, limits and troubleshooting |
| [Self-hosting guide](docs/SELF_HOST.md) | Operators and members: installation, settings, credentials, recovery, storage and recovery |
| [MCP integration reference](docs/AGENT_CLIENT.md) | Agent authors: tool authority, handoff contracts, waits and errors |
| [Architecture](docs/ARCHITECTURE.md) | Contributors: components, control lifecycle, isolation, networking and profiles |
| [Frozen baseline](docs/STATUS.md) | Version boundaries, accepted behavior and verification evidence |
| [Release maintenance](docs/RELEASING.md) | Maintainers: validation, immutable image publication and deployment |
| [Runtime maintenance](runtime/README.md) | Maintainers: Chrome/extension asset locks and sandbox checks |

## Development

Repository access is required. Use Node.js 24+, npm, Python 3, Bash and Docker. Source development uses local image tags; ordinary self-hosting uses the pinned public images above.

```sh
npm ci
npm run check
npm test
bash scripts/build-container-images.sh
cp .env.example .env
# Set AB_ADMIN_PASSWORD before the first authenticated startup.
bash scripts/compose.sh up -d --wait
```

If `.env` already exists, keep it and update supported settings instead of overwriting it. Do not commit credentials or browser state.

| Path | Purpose |
| --- | --- |
| `src/` | Controller, identities, MCP, browser engines, storage and network policy |
| `web/` | Public website, member dashboard and browser viewer |
| `runtime/` | Browser image, asset locks, sandbox profile and distribution notices |
| `scripts/` | Setup, builds, packaging, backup and acceptance runners |
| `test/` | Unit, API and disposable browser/deployment acceptance tests |
| `deploy/` | Accepted image pins, proxy template and versioned verification receipts |
| `docs/` | User guides and maintainer references |
| `output/` | Ignored local logs, screenshots and test reports |

For native browser tests, install the test dependencies with `npm run browser:install` and `npm run desktop:install`. Representative checks are:

```sh
npm run test:desktop
npm run test:public-mcp
npm run test:self-host
```

Integration tests require their documented host dependencies and may pull images or create disposable containers. Use the [release acceptance table](docs/RELEASING.md#acceptance-commands) to select the appropriate scope. Synthetic tests do not require real website credentials. The source/legacy Compose wrappers remain for compatibility and testing; further zkPass-specific testing is paused.

## Distribution and third-party notices

The source repository is private; the two GHCR image packages and official setup downloads are public. Public image availability does not grant access to the private source repository or GitHub Release attachments.

Chrome and the two zkPass extensions are locked in [runtime/assets.lock.json](runtime/assets.lock.json). Images contain no personal website login profile. Preserve [third-party distribution notices](runtime/DISTRIBUTION-NOTICES.md), [Playwright's license](runtime/PLAYWRIGHT-LICENSE), and the applicable dependency licenses when redistributing.
