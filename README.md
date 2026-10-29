# Agentic Browser

A chat Agent with a private remote browser beside the conversation. The Agent opens a website, hands control to you for sign-in or confirmation, then continues in the same browser when you click Done.

**[Documentation](docs/README.md) · [Self-hosting](docs/DEPLOYMENT.md) · [Build](docs/BUILD.md) · [Release](docs/RELEASING.md)**

The application combines LibreChat, native browser tools and isolated Chrome sessions. It includes local accounts, per-user credits, a shared daily budget, queueing, an administrator interface and optional email password recovery. Registration is closed by default for self-hosted installations.

The [GitHub demo](docs/AGENT_DEMO.md) asks you to sign in inside the remote browser, then counts and lists your own private repositories. Website credentials belong in the browser while you have control. After you return control, the Agent can read signed-in pages and send tool results to the configured model.

## Self-host

Deploy a versioned installation bundle on Linux with Node.js 24+, Docker and flock. The [deployment guide](docs/DEPLOYMENT.md) covers Cloudflare, HTTPS, model settings, secrets, first login and acceptance. MongoDB, Redis and browser control remain private; persistent data lives in the installation directory, and configuration can use a separate private directory.

New clones include public examples in [config/settings.example.json](config/settings.example.json) and [config/secrets.env.example](config/secrets.env.example). Review them to see which settings and keys you need. For source deployments, `agentctl init --config-directory "$PWD/config/local"` generates private configuration and unique application keys under the repository’s `config/`; edit those generated files using the [configuration guide](docs/CONFIGURATION.md). Building images requires no model or Cloudflare keys. The installation tools regenerate `.deployment/` state; a new clone never needs a copy of another server’s deployment directory.

**Status: installation candidate; Agent images and bundles have not been publicly published.** Linux amd64 has passed local installation and recovery acceptance. Native ARM64, Mac execution and independent-host acceptance remain pending. See [current status](docs/STATUS.md) for the exact scope.

## Build and contribute

Mac and Ubuntu use the same source checkout and Node/npm tools. Model keys, Cloudflare credentials and `.deployment/` are not build inputs.

```bash
npm ci
npm run check
npm test
npm run build:agent -- --committed \
  --platforms linux/amd64,linux/arm64 --tag v0.2.0-rc.8
```

Use a new version when preparing a release. The [build guide](docs/BUILD.md) explains prerequisites and parameters; the [release guide](docs/RELEASING.md) covers GHCR and installation bundles. See [architecture](docs/ARCHITECTURE.md) and [development](docs/DEVELOPMENT.md) for source boundaries, LibreChat changes and tests.

All maintained guides are in [docs/](docs/README.md). Preserve the [distribution notices](docs/DISTRIBUTION-NOTICES.md) and dependency licenses when distributing images or bundles.
