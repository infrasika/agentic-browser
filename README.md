# Agentic Browser

A remote browser that an Agent and a person can take turns using. An Agent starts a task, hands over the browser for sign-in or confirmation, and continues in the same session after the person returns control.

**[Official demo](https://agentic-browser.zkpass.org/) · [Self-hosting guide](https://agentic-browser.zkpass.org/self-host)**

## Try the public demo

The public MCP endpoint is `https://agentic-browser.zkpass.org/mcp`. No Agentic Browser account or API key is required. Install it in a client that supports Streamable HTTP MCP:

```sh
# Codex CLI
codex mcp add agentic-browser --url https://agentic-browser.zkpass.org/mcp

# Claude Code
claude mcp add --transport http --scope user agentic-browser https://agentic-browser.zkpass.org/mcp
```

Restart or refresh your client's tools if necessary, then send:

> Open GitHub in Agentic Browser and send me a link to sign in. Wait until I hand control back, then count all the private repositories I own and list their names. Check every page and close the browser when finished.

Open the link your Agent provides, click **Connect and take control**, sign in in the remote browser, then click **Hand back to Agent**. Do not send passwords or verification codes in chat. Website login restrictions still apply.

Each public session has a separate temporary browser. Sessions start with 5 minutes and can be renewed up to a total of 10 minutes. The official demo has 5 concurrent browser slots and a limit of 2 per source IP. When full, the website and MCP tool report the current count and ask you to try later. The demo does not save login profiles.

## Deploy your own workspace

Use a self-hosted instance for regular work. Team members have separate accounts, Agent credentials, sessions, and optional saved profiles. Only the controller has Docker socket access; browser containers do not. The server administrator remains trusted.

Public images are available for **Linux amd64 and arm64**:

- `ghcr.io/infrasika/agentic-browser-controller`
- `ghcr.io/infrasika/agentic-browser-runtime`

The current preview is `v0.1.0-preview.4`, with automatic capacity recovery after browser failure, one environment file, initial account setup, and authenticated HTTP MCP. The [standalone installer](https://agentic-browser.zkpass.org/install.sh) pulls both public images and writes only `compose.yaml` and `.env`. No source checkout, build, registry login, or helper scripts are needed afterward. Both images are pinned by digest in the generated Compose file.

Requirements: Docker Engine 26+, Compose 2.24.4+, and Bash. Apple Silicon Macs use Docker Desktop's Linux arm64 engine.

```sh
curl -fsSL https://agentic-browser.zkpass.org/install.sh | bash
cd agentic-browser
# Set AB_ADMIN_USERNAME and AB_ADMIN_PASSWORD (at least 12 characters) in .env.
docker compose up -d --wait
```

Open `http://127.0.0.1:3333`, sign in with the account configured in .env, and create a personal Agent credential. See [Self-hosting](docs/SELF_HOST.md) for configuration, remote access, members, upgrades, and recovery; see [Agent clients](docs/AGENT_CLIENT.md) for the private MCP configuration.

The controller stays running and creates separate browser containers from the runtime image on demand. You do not need to start a shared browser container yourself.

## Documentation

| Guide | Contents |
| --- | --- |
| [Self-hosting](docs/SELF_HOST.md) | Ubuntu and Mac installation, team administration, storage, upgrades |
| [Agent clients](docs/AGENT_CLIENT.md) | Public MCP, private credentials, handoff, waiting, errors |
| [Public demo deployment](docs/UBUNTU_PUBLIC_DEMO.md) | Ubuntu, HTTPS, reverse proxy, quotas, operations |
| [Architecture](docs/ARCHITECTURE.md) | Sessions, isolation, networking, images, extensions |
| [Releasing](docs/RELEASING.md) | Native multi-platform builds, GHCR, immutable bundles |
| [Roadmap](docs/PLAN.md) | Product scope and next milestones |
| [Progress](docs/PROGRESS.md) | Verified behavior, release evidence, remaining validation |
| [Runtime development](runtime/README.md) | Browser assets, sandbox and extension tests |

## Development

Repository access is required. Use Node.js 24+, npm, Python 3, and Docker:

```sh
npm ci
npm run check
npm test
bash scripts/build-container-images.sh
cp .env.example .env
# Set AB_ADMIN_PASSWORD before starting.
bash scripts/compose.sh up -d --wait
```

For the full acceptance suite, install host test dependencies with `npm run browser:install` and `npm run desktop:install`, then run `npm run verify`. Tests use synthetic accounts and isolated data. `npm run test:reliability` runs the repeated five-browser capacity and failure-recovery checks separately; see [Releasing](docs/RELEASING.md) for candidate image selection and longer runs. Generated logs, reports, and screenshots belong in `output/`, not in the documentation.

Chrome and the two zkPass extensions are locked in `runtime/assets.lock.json`. Images contain no personal login profile. Consult [third-party notices](runtime/DISTRIBUTION-NOTICES.md) for attribution and dependency licenses. This preview does not guarantee sign-in to every website or completion of a live zkPass proof.
