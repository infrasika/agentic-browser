# Agentic Browser

A chat Agent with a private remote browser beside the conversation. The Agent opens a website, hands control to you for sign-in or confirmation, then continues in the same browser when you click Done.

**[Documentation](docs/README.md) · [Self-hosting](docs/DEPLOYMENT.md) · [Build](docs/BUILD.md) · [Release](docs/RELEASING.md)**

The application combines LibreChat, native browser tools and isolated Chrome sessions. It includes local accounts, per-user credits, a shared daily budget, queueing, an administrator interface and optional email password recovery. Registration is closed by default for self-hosted installations.

The [GitHub demo](docs/AGENT_DEMO.md) asks you to sign in inside the remote browser, then counts and lists your own private repositories. Website credentials belong in the browser while you have control. After you return control, the Agent can read signed-in pages and send tool results to the configured model.

## Self-host

Starting with preview.10, the [Compose deployment](docs/COMPOSE.md) needs only Docker and Compose on the host: download `compose.yaml`, `settings.json` and `secrets.env` from the matching release, fill in your settings and run `docker compose up -d`. Initialization and generated keys live inside containers and named volumes. Use the matching preview.10 or later assets; preview.9 images do not include this entrypoint.

Deploy a versioned installation bundle on Linux with Node.js 24+, Docker and flock. The [deployment guide](docs/DEPLOYMENT.md) covers Cloudflare, HTTPS, model settings, secrets, first login and acceptance. MongoDB, Redis and browser control remain private; persistent data lives in the installation directory, and configuration can use a separate private directory.

New clones include public examples in [config/settings.example.json](config/settings.example.json) and [config/secrets.env.example](config/secrets.env.example). Review them to see which settings and keys you need. For source deployments, `agentctl init --config-directory "$PWD/config/local"` generates private configuration and unique application keys under the repository’s `config/`; edit those generated files using the [configuration guide](docs/CONFIGURATION.md). Building images requires no model or Cloudflare keys. The installation tools regenerate `.deployment/` state; a new clone never needs a copy of another server’s deployment directory.

**Preview releases:** the [release workflow](.github/workflows/release-agent.yml) publishes versioned Agent images and Linux amd64 / arm64 installation bundles after native acceptance passes. Use the assets and evidence on the specific [GitHub Release](https://github.com/infrasika/agentic-browser/releases); repository access is required for downloads. See [current status](docs/STATUS.md) for remaining validation boundaries.

## Build and contribute

Mac and Ubuntu use the same source checkout and Node/npm tools. Model keys, Cloudflare credentials and `.deployment/` are not build inputs.

```bash
npm ci
npm run check
npm test
```

Follow the [build guide](docs/BUILD.md) to select a source revision and generate both Linux architectures. The [release guide](docs/RELEASING.md) covers candidate acceptance, Docker/GHCR authentication, immutable image publication and installation bundles. The [deployment guide](docs/DEPLOYMENT.md) walks through installing either bundle type on Linux, filling in generated configuration, enabling HTTPS, keeping registration closed or opening it, and activating backups. See [architecture](docs/ARCHITECTURE.md) and [development](docs/DEVELOPMENT.md) for source boundaries, LibreChat changes and tests.

All maintained guides are in [docs/](docs/README.md). Preserve the component and dependency licenses when distributing images or bundles.
