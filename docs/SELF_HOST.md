# Self-hosting

Run a private workspace with two public images: the controller manages the service; the runtime creates a separate browser for each session, with Chrome and both zkPass extensions included. No source checkout, image build, or registry login is required.

You need Docker Engine 26+, Compose 2.24.4+, and Bash. Use Linux amd64/arm64 or Docker Desktop on Apple Silicon. Start with one browser; each runtime has a 2 GiB memory and 2 CPU limit, plus controller/proxy overhead. Only the trusted controller receives Docker socket access to manage session containers.

## 1. Download

In a new directory:

```sh
curl -fSLO https://agentic-browser.zkpass.org/self-host/download/agentic-browser-self-host.tar.gz
curl -fSLO https://agentic-browser.zkpass.org/self-host/download/SHA256SUMS
sha256sum -c SHA256SUMS
tar -xzf agentic-browser-self-host.tar.gz
cd agentic-browser
cp .env.compose.example .env.compose
```

On macOS, replace the checksum command with `shasum -a 256 -c SHA256SUMS`. Stop if verification fails. The download includes all configuration and helper scripts used below; keep it for reproducible installation.

## 2. Configure

Edit **`.env.compose` in the extracted directory**. The defaults work locally. For example, to allow five browsers in total:

```dotenv
AB_PROJECT_NAME=agentic-browser
AB_PORT=3333
AB_MAX_SESSIONS=5
AB_MAX_SESSIONS_PER_MEMBER=1
AB_SESSION_TTL_SECONDS=1800
AB_SESSION_MAX_LIFETIME_SECONDS=14400
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `AB_PORT` | `3333` | Host port, bound to loopback; controller stays on internal port 3333 |
| `AB_PUBLIC_URL` | `http://127.0.0.1:<AB_PORT>` | Address users open; set your HTTPS origin for remote teams |
| `AB_PROJECT_NAME` | `agentic-browser` | Container and private data-volume namespace; keep it stable |
| `AB_MAX_SESSIONS` | `1` | Total concurrent browsers, from 1 to 32 |
| `AB_MAX_SESSIONS_PER_MEMBER` | `1` | Per-member limit, from 1 to 32; the total limit still applies |
| `AB_SESSION_TTL_SECONDS` | `1800` | Initial lease, from 60 to 14400 seconds |
| `AB_SESSION_MAX_LIFETIME_SECONDS` | `14400` | Maximum lifetime including renewals, from 60 to 86400 seconds |

Keep the initial lease no longer than the maximum lifetime. Optional `AB_EGRESS_DENY_HOSTS` adds comma-separated hostnames to block; `AB_RUNTIME_PLATFORM=auto` selects the native architecture. See `.env.compose.example` for these options. Image digests are fixed separately in `deploy/release.env`.

### Where settings are managed

| What | Where | When it takes effect |
| --- | --- | --- |
| Address, ports, limits, session lifetimes | `.env.compose` | When the controller is created or recreated |
| Member accounts and passwords | `member` helper command | Immediately |
| Personal Agent credentials and saved profiles | Signed-in dashboard | Immediately |
| Agent connection URL and credential | Your Agent's MCP configuration | After reconnecting the client |

There is no server-settings page. The helper reads `.env.compose` and Compose passes the supported values into the container. For example, `AB_PUBLIC_URL` becomes `PUBLIC_URL`, and `AB_SESSION_TTL_SECONDS` becomes `SESSION_TTL_SECONDS`.

The source-run `.env` file is not loaded by this image deployment. Adding arbitrary keys to `.env.compose` does not pass them through: only settings mapped in `compose.yaml` apply. Team authentication, Docker browser mode, internal paths, and internal port are already configured. Personal Agent credentials belong in the client's MCP configuration, not this server file. Public demos use the separate `.env.public` workflow in [Public demo deployment](UBUNTU_PUBLIC_DEMO.md).

## 3. Start and sign in

```sh
bash scripts/release-compose.sh pull
bash scripts/release-compose.sh up -d --wait --wait-timeout 90
bash scripts/release-compose.sh doctor
bash scripts/release-compose.sh member create alice
```

Enter a password of at least 12 characters in the hidden prompt. Open `http://127.0.0.1:3333` (or your configured address), sign in, and create a personal Agent credential in the dashboard. Create separate member accounts for teammates; registration is not public.

## 4. Connect your Agent

Follow the [private-client setup](AGENT_CLIENT.md#private-deployment-personal-credentials), also shown on the [self-hosting page](https://agentic-browser.zkpass.org/self-host):

- Same machine: the `mcp` helper runs the client inside the controller.
- Another machine: install Docker and extract the setup bundle there, then use `pull-client` and `mcp-remote`. No server Docker permissions are needed.

Both use the published image and each member's own credential. The [official demo](https://agentic-browser.zkpass.org/) and its account-free MCP endpoint are separate from your private workspace.

## Change settings later

Edit `.env.compose`, finish active sessions, then apply the change:

```sh
bash scripts/release-compose.sh up -d --force-recreate --wait --wait-timeout 90
bash scripts/release-compose.sh doctor
```

No image rebuild is required. A plain `restart` does not reload the environment. Recreation ends active sessions but retains member accounts and saved profiles in the same data volume.

A shell variable can override the file for one invocation, for example `AB_MAX_SESSIONS=5 bash scripts/release-compose.sh up -d --wait`. That invocation creates the controller with the override; a later invocation without it uses the file again. Prefer editing the file for lasting configuration.

## Remote access and maintenance

For a local tunnel to Ubuntu, keep `ssh -N -L 3333:127.0.0.1:3333 ubuntu@SERVER_IP` running and open `http://127.0.0.1:3333`. This forwards the website; a remote MCP client also needs a service address it can reach.

For team access, configure an HTTPS reverse proxy using [the Nginx template](../deploy/nginx-public.conf), set `AB_PUBLIC_URL` to that origin, and recreate the controller. Changing the URL alone does not configure DNS, TLS, or port exposure. Keep team authentication enabled.

Use `member create bob` to add a member and `member list` to list members, prefixed by `bash scripts/release-compose.sh`. Members manage their own credentials and saved profiles. Temporary browser data is cleared on close; saved profiles persist. The host administrator can access stored data.

Before an upgrade, finish sessions, stop the service, and back up its data volume. Keep the old bundle and pins, retain `.env.compose` and the project name, then pull and start the new release. Use `down` to remove the service while retaining data; do not use `down --volumes` for routine changes. Chrome profile downgrades may require restoring a backup.

See [Progress](PROGRESS.md) for tested platforms and remaining acceptance work, and [Releasing](RELEASING.md) for image publication. Contributor setup is in [README](../README.md#development).
