# Agentic Browser

A remote browser that an Agent and a person take turns using. The Agent starts a task, hands over for sign-in or confirmation, and continues in the same browser after handback.

**[Official demo](https://agentic-browser.zkpass.org/) · [Self-hosting website](https://agentic-browser.zkpass.org/self-host)**

## Start here

| Your goal | Complete guide |
| --- | --- |
| Try the public service with Codex, Claude Code or another Agent | [Use the public demo](docs/PUBLIC_DEMO.md) |
| Run a personal or team workspace on Ubuntu or an Apple Silicon Mac | [Self-host Agentic Browser](docs/SELF_HOST.md) |

Public demo: no Agentic Browser account or API key; 5 concurrent temporary browsers, 2 per source IP, 5-minute initial sessions and 10-minute maximum lifetime. Install the remote MCP server in your Agent and follow the sign-in link it provides. Website login restrictions still apply.

Self-hosting: two public Docker images, one `.env`, member login and personal Agent tokens. No source checkout, host Node.js, build, or registry login is required:

```sh
curl -fsSL https://agentic-browser.zkpass.org/install.sh | bash
cd agentic-browser
# Set your own AB_ADMIN_USERNAME and AB_ADMIN_PASSWORD in .env.
docker compose up -d --wait
```

Open `http://127.0.0.1:3333`, sign in, and create your personal Agent credential. For remote Ubuntu, open a tunnel or configure an HTTPS domain as described in the guide. The controller creates isolated browsers on demand; only it mounts the Docker socket. The host administrator remains trusted.

## Frozen version

Feature development is paused at the [frozen baseline](docs/STATUS.md). Published images remain **v0.1.0-preview.4**, pinned by multi-platform digest in [deploy/release.env](deploy/release.env). The source/official website include later accepted UI and documentation changes; those changes do not replace historical GHCR images. Docker selects Linux amd64 or arm64 automatically.

## Reference documentation

- [MCP integration](docs/AGENT_CLIENT.md): tool authority, handoff links, waiting and errors.
- [Architecture](docs/ARCHITECTURE.md): lifecycle, isolation, storage, networking and extensions.
- [Frozen baseline](docs/STATUS.md): scope, evidence and known limits.
- [Releasing](docs/RELEASING.md): maintainer builds, acceptance and image publication.
- [Runtime maintenance](runtime/README.md): locked Chrome/extension assets and sandbox checks.

## Contributor setup

Repository access is required for development. Use Node.js 24+, npm, Python 3 and Docker. Normal users should follow the image-based self-hosting guide above.

```sh
npm ci
npm run check
npm test
bash scripts/build-container-images.sh
cp .env.example .env
# Set AB_ADMIN_PASSWORD before starting.
bash scripts/compose.sh up -d --wait
```

Install browser test dependencies with `npm run browser:install` and `npm run desktop:install` before running native integration tests. See the acceptance table in [Releasing](docs/RELEASING.md) for the right command and scope. Temporary output belongs in ignored `output/`.

The source/legacy Compose wrappers and synthetic demo fixture remain for compatibility and testing. New installations use the standalone installer and ordinary `docker compose` commands. The old source-preview packager has been retired.

Chrome and the two zkPass extensions are locked in [runtime/assets.lock.json](runtime/assets.lock.json). Preserve [third-party notices](runtime/DISTRIBUTION-NOTICES.md) and dependency licenses when redistributing. Images contain no personal website login profile.
