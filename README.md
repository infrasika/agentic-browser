# Agentic Browser

A self-hosted chat Agent with an isolated remote browser alongside the conversation, built on LibreChat. The Agent opens websites, hands control to you for sign-in or confirmation, then continues when you click Done.

- Local accounts with separate chat histories; registration is closed by default.
- Per-user credits, a site-wide daily budget and administrator controls.
- Browser session isolation, queueing and automatic continuation after human control.
- Turnstile for public registration and optional email password recovery.

The included GitHub demo counts and lists your private repositories after you sign in through the remote browser. Enter website credentials during human control. After control returns, the Agent can read signed-in pages and send results to the configured model.

## Get started

Follow the **[deployment guide](docs/DEPLOYMENT.md)** to run an existing release on a Linux amd64 or arm64 server with Docker and Compose. Fill in your model settings and credentials on that server; no source build or separate MCP installation is required.

Private use supports access through an SSH tunnel. The public deployment guide uses Cloudflare and host Nginx.

## Documentation

| Guide | Purpose |
| --- | --- |
| [Deployment](docs/DEPLOYMENT.md) | Install a release and verify first startup |
| [Configuration](docs/CONFIGURATION.md) | Look up files, parameters, secrets and persistent storage |
| [Operations](docs/OPERATIONS.md) | Manage accounts, email, backups, restores and upgrades |
| [Architecture](docs/ARCHITECTURE.md) | Understand components, identity and isolation |
| [Development](docs/DEVELOPMENT.md) | Navigate the source, make changes and run tests |
| [Build](docs/BUILD.md) | Build Linux images from the same source on Mac or Ubuntu |
| [Release](docs/RELEASING.md) | Publish images and verified deployment assets |

## License

Agentic Browser is licensed under the [MIT License](LICENSE). Bundled components and dependencies retain their own licenses.
