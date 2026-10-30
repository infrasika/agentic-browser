# Agentic Browser

A chat Agent with a private remote browser beside the conversation. The Agent opens a website, hands control to you for sign-in or confirmation, then continues in the same browser when you click Done.

**[Documentation](docs/README.md) · [Self-hosting](docs/DEPLOYMENT.md) · [Build](docs/BUILD.md) · [Release](docs/RELEASING.md)**

The application combines LibreChat, native browser tools and isolated Chrome sessions. It includes local accounts, per-user credits, a shared daily budget, queueing, an administrator interface and optional email password recovery. Registration is closed by default.

The [GitHub demo](docs/AGENT_DEMO.md) asks you to sign in inside the remote browser, then counts and lists your own private repositories. Enter website credentials while you have control. After you return control, the Agent can read signed-in pages and send tool results to the configured model.

## Self-host

Use the matching release's `compose.yaml`, `settings.json` and `secrets.env`. Fill in the model settings and credentials, then run `docker compose up -d`. The server needs only Docker Engine and Compose. Initialization, generated keys and operations run inside containers; data persists in project-specific named volumes. MongoDB, Redis and browser control stay private.

Follow [Deployment](docs/DEPLOYMENT.md) for setup, HTTPS and closed or public registration, [Configuration](docs/CONFIGURATION.md) for fields and secrets, and [Operations](docs/OPERATIONS.md) for accounts, mail, backups, restores and upgrades. The new operations commands require release assets containing the `ops` service; see [current release status](docs/STATUS.md).

New clones include [settings](config/settings.example.json) and [credential](config/secrets.env.example) examples. Optional local settings belong in ignored `config/local/`; no server configuration or `.deployment/` directory is required to build. Published images use immutable digests. Repository access is required to download releases while the repository remains private.

## Build and contribute

Mac and Ubuntu use the same source checkout and Node/npm tools. Model keys and Cloudflare credentials are deployment inputs, never build inputs.

```bash
npm ci
npm run check
npm test
```

The [build guide](docs/BUILD.md) covers Linux amd64 / arm64 images. The [release guide](docs/RELEASING.md) covers GitHub Actions, GHCR authentication, native acceptance and delivery. See [architecture](docs/ARCHITECTURE.md) and [development](docs/DEVELOPMENT.md) for component boundaries, LibreChat customizations and tests.

## License

Agentic Browser is licensed under the [MIT License](LICENSE). Bundled components and dependencies retain their own licenses.
