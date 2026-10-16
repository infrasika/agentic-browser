# Self-hosting

Run the two public GHCR images on your own Docker host. No source checkout, host Node.js, or registry login is required. The [official demo](https://agentic-browser.zkpass.org/) is separate from your private installation.

Requires Docker Engine 26+, Compose 2.24.4+, and Bash. Images support Linux amd64/arm64 and Docker Desktop on Apple Silicon. Only the controller mounts the Docker socket; it creates isolated browser containers on demand.

## 1. Install

```sh
curl -fsSL https://agentic-browser.zkpass.org/install.sh | bash
cd agentic-browser
```

The installer pulls both pinned images and creates only `compose.yaml` and `.env`. It detects Docker socket permissions and refuses to overwrite an existing installation. To inspect it first, download with `curl -fsSL https://agentic-browser.zkpass.org/install.sh -o install.sh`, then run `bash install.sh my-browser`.

## 2. Configure and start

Edit `.env` and choose your initial administrator credentials:

```dotenv
AB_MODE=authenticated
AB_ADMIN_USERNAME=admin
AB_ADMIN_PASSWORD='your-own-long-password'
AB_PORT=3333
AB_MAX_SESSIONS=1
```

Use your own password of 12–256 characters, not the example. Single-quote passwords containing `$` or `#` so Compose treats them literally. Keep `.env` private; the installer sets its permissions to `0600`.

```sh
docker compose up -d --wait
```

Open `http://127.0.0.1:3333`, sign in, and create a **personal Agent credential** in the dashboard. If you set `AB_PORT=4444`, open `http://127.0.0.1:4444` instead.

The initial account is created only when the workspace has no accounts. Restarts and environment changes never reset an existing password, enable a disabled account, or add another bootstrap account. After setup, you may remove **both** `AB_ADMIN_USERNAME` and `AB_ADMIN_PASSWORD` from `.env` and recreate the controller. Only password hashes are stored in the database; the initial plaintext password remains in your private environment file and container configuration until removed.

“Administrator” means the deployment's initial account. It has the same private browser-data scope as other members; it cannot browse their sessions or profiles through the dashboard. Host-level administration still uses Docker and the member CLI.

## 3. Connect your Agent

Use your service's `/mcp` URL and the personal token from the dashboard. No Docker command is needed on the Agent's machine.

For clients with JSON MCP settings:

```json
{
  "mcpServers": {
    "agentic-browser-local": {
      "type": "http",
      "url": "http://127.0.0.1:3333/mcp",
      "headers": { "Authorization": "Bearer YOUR_PERSONAL_AGENT_CREDENTIAL" }
    }
  }
}
```

The dashboard can copy this configuration after creating a credential. For Codex and other client details, see [Agent clients](AGENT_CLIENT.md#private-deployment-personal-credentials). Use the host port you configured; `4444` applies to both the website and MCP. A remote Agent needs your reachable HTTPS address instead of its own `127.0.0.1`.

Try:

> Use agentic-browser-local to open GitHub and send me a sign-in link. Wait until I hand control back, then count all the private repositories I own and list their names. Check every page and close the browser when finished.

Open the link while signed in to your workspace account, complete the website login, and click **Hand back to Agent**.

## One file, two access modes

| `.env` setting | Website and MCP access | Browser data |
| --- | --- | --- |
| `AB_MODE=authenticated` (default) | Member login; personal Bearer token required for `/mcp` | Isolated by member and Agent credential; saved profiles are opt-in |
| `AB_MODE=public` | No registration or Agent token required | Temporary sessions with individual secret keys; no saved profiles |

Public mode ignores the bootstrap credentials and applies a 5-minute initial lease with a 10-minute maximum lifetime. Use a separate installation directory and `AB_PROJECT_NAME` for a public demo so it has its own volume. See [Public deployment](UBUNTU_PUBLIC_DEMO.md) for proxy and quota settings. New deployments do not need `.env.compose`, `.env.public`, or a second Compose file.

## Settings and updates

| Setting | Default | Purpose |
| --- | --- | --- |
| `AB_PORT` | `3333` | Host port for the website and MCP |
| `AB_PUBLIC_URL` | `http://127.0.0.1:<AB_PORT>` | External origin; set your HTTPS origin for remote access |
| `AB_BIND_ADDRESS` | `127.0.0.1` | Host interface; keep loopback behind a local proxy |
| `AB_PROJECT_NAME` | `agentic-browser` | Container and data-volume namespace; keep stable |
| `AB_MAX_SESSIONS` | `1` | Total simultaneous browsers, 1–32 |
| `AB_MAX_SESSIONS_PER_MEMBER` | `1` | Authenticated member limit, 1–32 |
| `AB_SESSION_TTL_SECONDS` | `1800` | Authenticated initial lease, 60–14400 seconds |
| `AB_SESSION_MAX_LIFETIME_SECONDS` | `14400` | Authenticated maximum lifetime, 60–86400 seconds |
| `AB_MAX_SESSIONS_PER_IP` | `2` | Public mode source-IP limit, 1–8 |
| `AB_TRUST_PROXY` | `false` | Trust `X-Real-IP` only behind a proxy that overwrites it |

Keep the initial lease no longer than the maximum lifetime. Optional `AB_EGRESS_DENY_HOSTS` adds comma-separated blocked hostnames. `AB_RUNTIME_PLATFORM=auto` selects the native architecture. The installer records Docker socket/group values in `.env`; image digests are fixed in `compose.yaml`.

Server settings live in `.env`. Personal Agent tokens and saved profiles are managed in the dashboard. There is no server-settings page. Compose passes only mapped settings to the container. After editing `.env`, finish active sessions and run:

```sh
docker compose up -d --force-recreate --wait
```

A plain restart does not reload environment settings. Recreation ends active sessions but preserves accounts and saved profiles in the same volume. Bootstrap settings never serve as a password-reset mechanism.

## Members, remote access, and upgrades

Add teammates with `docker compose exec controller npm run members -- create alice`. Reset a password with `docker compose exec controller npm run members -- password alice`; this revokes that member's existing tokens. Each person should have their own account and Agent token. Run `docker compose exec controller npm run doctor` for environment checks.

For a local tunnel, keep `ssh -N -L 3333:127.0.0.1:3333 ubuntu@SERVER_IP` running; both the website and HTTP MCP are then available at the forwarded address. For remote teams, configure DNS and an HTTPS reverse proxy using [the Nginx template](../deploy/nginx-public.conf), and set `AB_PUBLIC_URL` accordingly. Setting the URL alone does not expose ports or configure TLS.

Before upgrading, finish active sessions and follow the backup procedure below. Do not use `down --volumes` for routine changes. Saved profiles persist; temporary browser data is removed on close. The host administrator can access stored data.

Older installations may retain their existing helper scripts and `.env.compose` or `.env.public`. To migrate, install the new release in a separate directory, copy supported settings into its `.env`, explicitly set the mode, and preserve the project name and volume. When retaining existing accounts, remove both bootstrap account lines from the new file. Existing accounts keep their passwords; no bootstrap account is added. Historical images do not gain new features merely by editing `.env`—upgrade the controller image and Compose configuration together.

Native Linux image CI, physical Mac acceptance, and fresh-host acceptance are distinct checks. See [Progress](PROGRESS.md) for verified versions and remaining work.

## Backup and upgrade

Run these commands from your installation directory, before editing its image pins or configuration:

```sh
curl -fsSL https://agentic-browser.zkpass.org/self-host/download/workspace-backup.sh -o ../workspace-backup.sh
docker compose stop --timeout 60 controller
bash ../workspace-backup.sh backup "$(docker compose ps -a -q controller)" ../agentic-browser-backup
```

Choose a new backup directory each time. The helper refuses a running controller, a volume still mounted by running browsers, image pins that differ from the stopped controller, or an existing backup directory. A completed backup contains the full data archive, its checksum, both image references, and copies of `compose.yaml` and `.env`. Keep it private: it contains account/token records and saved website login data. Copy completed backups off the server for disaster recovery.

To upgrade, install the current kit into a new directory and retain your settings and project name:

```sh
curl -fsSL https://agentic-browser.zkpass.org/install.sh | bash -s -- ../agentic-browser-next
cp .env ../agentic-browser-next/.env
cd ../agentic-browser-next
docker compose up -d --wait
```

The new installer supplies the accepted image pins. Check member sign-in, saved profiles, and Agent handoff before reopening access. Keep the old controller stopped; run only one controller for a workspace. A stopped-workspace backup is required before a browser-version change: do not assume that an older Chrome can open a profile already modified by a newer Chrome.

## Roll back from a backup

Stop the upgraded installation, then restore into a new volume. The original volume is retained for investigation. Run from the upgraded installation directory:

```sh
docker compose stop --timeout 60 controller
bash ../workspace-backup.sh restore ../agentic-browser-backup agentic-browser-recovery-data
mkdir ../agentic-browser-recovery
cp ../agentic-browser-backup/compose.yaml ../agentic-browser-backup/.env ../agentic-browser-recovery/
cd ../agentic-browser-recovery
```

The helper checks the archive checksum, pulls the backed-up image pins as needed, and refuses to overwrite any existing volume. If extraction fails, its new volume is left for inspection; use another new name for a subsequent attempt.

In the restored `.env`, set these values for a local recovery check:

```dotenv
AB_PROJECT_NAME=agentic-browser-recovery
AB_PORT=3334
AB_BIND_ADDRESS=127.0.0.1
AB_PUBLIC_URL=http://127.0.0.1:3334
```

In `compose.yaml`, replace the final top-level `volumes` declaration with:

```yaml
volumes:
  data:
    external: true
    name: agentic-browser-recovery-data
```

Start with `docker compose up -d --wait`, then check the workspace at `http://127.0.0.1:3334`. Keep the original controller stopped while the restored copy is in use. The backed-up Compose file and `.env` select the old release together with its pre-upgrade data. On a different Docker host, first use the installer to detect that host's socket/group and update `AB_DOCKER_SOCKET` and `AB_DOCKER_GID` in the restored settings.

Restoration also rolls account changes and token revocations back to the backup time. Before restoring external access, reapply later account disablements/revocations. Resetting a member's password with `docker compose exec controller npm run members -- password alice` invalidates that member's restored credentials; they then sign in and issue new Agent tokens. Only restore a trusted backup.

The automated upgrade check currently covers preview.3 → preview.4 and rollback from the backup. Those releases use identical Chrome and extension versions. This does not establish compatibility across future Chrome/extension version changes; see [Progress](PROGRESS.md).
