# Self-host Agentic Browser

Run your personal workspace on your own Docker host using the two public images. You do **not** need source access, a build, Node.js on the host, or a GHCR login. The [official demo](https://agentic-browser.zkpass.org/) is a separate service; its sessions and accounts do not move into your installation.

The accepted images are recorded in the installer and [deploy/release.env](../deploy/release.env). The installer embeds immutable multi-platform digests rather than floating tags. See [Release verification](RELEASING.md#release-verification) for the version and verification evidence.

Both image repositories also provide `:latest`, which follows the newest stable release, and fixed version tags such as `:v0.1.1`. Preview releases do not change `latest`. The installer uses exact digests so a later `docker compose pull` cannot silently upgrade your workspace. Use the [upgrade procedure](#backup-and-upgrade) to move both images together.

## Choose where to run it

| Host | What to install | Where Chrome runs |
| --- | --- | --- |
| Ubuntu amd64 or arm64 | Docker Engine 26+, Docker Compose 2.24.4+, Bash | In an isolated Linux runtime container for each session |
| Apple Silicon Mac | Docker Desktop with a running Linux engine meeting the same version requirements; Bash | In Docker Desktop's Linux arm64 VM, not your everyday Mac Chrome |

Run the installer **on the Docker host**. It supports a local Unix-socket Docker context, not a Docker-over-SSH/TCP context. To deploy on remote Ubuntu, SSH into Ubuntu and run the commands there. Docker automatically selects amd64 or arm64; no platform setting is needed.

Start with one concurrent browser. Increase the limit after observing your host's CPU, memory and disk during real tasks. `AB_MAX_SESSIONS` is a quota, not a guarantee that the host can sustain that many browsers. Docker Desktop's allocated resources matter independently of the Mac's total RAM. There is no automatic multi-host scheduling.

Check prerequisites:

```sh
docker version
docker compose version
docker info
```

Only the trusted controller mounts the Docker socket. This lets it create, inspect and remove per-session containers, networks and volumes. Docker socket access is daemon-wide management authority; browser containers do not receive it. The installer detects the socket path/group, including Docker Desktop's Linux-side permissions. Do not expose the Docker daemon, VNC or CDP ports to users.

## 1. Download the installer

Run in a directory where you want the workspace folder created:

```sh
curl -fsSL https://agentic-browser.zkpass.org/install.sh -o install-agentic-browser.sh
bash install-agentic-browser.sh agentic-browser
cd agentic-browser
```

You can inspect the downloaded script before running it. The shorter equivalent is:

```sh
curl -fsSL https://agentic-browser.zkpass.org/install.sh | bash
cd agentic-browser
```

The installer pulls `ghcr.io/infrasika/agentic-browser-controller` and `ghcr.io/infrasika/agentic-browser-runtime` by digest. It writes exactly two installation files: `compose.yaml` and `.env`. It does not start the service or overwrite an existing installation. Keep the installer if you want to recreate the same setup later; downloading from the website in the future may provide a newer accepted setup.

The controller runs continuously. It starts browser and egress-proxy containers from the runtime image as needed; you do not manually start a shared runtime container.

## 2. Configure and start

Edit the generated `.env`:

```dotenv
AB_MODE=authenticated
AB_ADMIN_USERNAME=admin
AB_ADMIN_PASSWORD='replace-with-your-own-long-password'
AB_PORT=3333
AB_MAX_SESSIONS=1
```

Choose your own password of 12–256 characters. Single-quote values containing `$` or `#` so Compose treats them literally; do not leave the example password in place. Keep `.env` private. The installer creates it with restrictive permissions.

```sh
docker compose up -d --wait --wait-timeout 90
docker compose ps
docker compose exec controller npm run doctor
```

Open **http://127.0.0.1:3333** on the same machine and sign in with the configured username/password. If you chose `AB_PORT=4444`, use `http://127.0.0.1:4444` for the website and `http://127.0.0.1:4444/mcp` for the Agent.

On a remote Ubuntu host, your laptop's `127.0.0.1` is not the server. Use the [SSH tunnel](#remote-access) or configure an HTTPS domain before trying to open it from your laptop.

### What the initial account means

`AB_ADMIN_USERNAME` and `AB_ADMIN_PASSWORD` create the first account only when the authenticated workspace has no accounts. Changing them never resets a password, re-enables an existing account, or adds another account to an initialized workspace. Public mode ignores them.

This initial account has the same private resource scope as other members. It is not a web administrator that can inspect everyone's browser data. Host-level administration uses Docker and the member CLI; there is no global administration/settings page in this version.

After confirming you can sign in, you may remove **both** bootstrap settings from `.env` and recreate the controller. Account password hashes remain in the data volume. Until removed and recreated, the bootstrap plaintext password remains in the private environment file and container configuration.

## 3. Create your Agent credential

In the dashboard's **Connect your Agent** section:

1. Give the credential a recognizable name, such as `my-codex`.
2. Leave saved-profile access empty for a temporary-browser test.
3. Click **Create credential**, then **Copy MCP configuration**.
4. Save the credential privately and configure your Agent. If you lose access to the secret, issue a replacement and revoke the old credential.

There are three separate sign-ins: your workspace account opens the dashboard; the personal Agent token authorizes MCP; the target website account signs into GitHub or another site inside Chrome. They are not interchangeable. Do not use your workspace password as an MCP token.

Create separate personal tokens for different Agents so each can be revoked independently. Existing account isolation is retained; team collaboration features are outside the product scope.

## 4. Connect Codex, Claude Code or another Agent

The URL is your workspace origin plus `/mcp`. Every authenticated MCP request requires a personal Bearer token. Website cookies do not authenticate the Agent, and no OAuth sign-in is provided by this workspace.

### Codex CLI

Set `AGENT_BROWSER_TOKEN` privately in the environment used to launch Codex. To enter it without putting the token itself into shell history, run the following in **Bash**:

```bash
read -r -s -p 'Agent credential: ' AGENT_BROWSER_TOKEN
printf '\n'
export AGENT_BROWSER_TOKEN
codex mcp add agentic-browser-local --url http://127.0.0.1:3333/mcp --bearer-token-env-var AGENT_BROWSER_TOKEN
codex
```

For a new terminal or desktop-launched Agent, make the variable available in that process's environment too. `--bearer-token-env-var` stores the variable name, not a copy of the token. Check the configuration with `codex mcp get agentic-browser-local`.

### Claude Code

With `AGENT_BROWSER_TOKEN` set as above, run:

```sh
claude mcp add --transport http --scope user agentic-browser-local http://127.0.0.1:3333/mcp --header "Authorization: Bearer $AGENT_BROWSER_TOKEN"
claude
```

Check the connection using `/mcp`. This command expands and stores the token in Claude's private client configuration; do not share that file. For environment-variable references in JSON configuration and other options, consult the [Claude Code MCP reference](https://code.claude.com/docs/en/mcp).

### Clients using JSON

Use **Copy MCP configuration** in the dashboard, or replace the placeholder below:

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

Reconnect or restart the Agent after adding the server. Do not commit a token-bearing configuration. Use a reachable HTTPS origin if the Agent runs elsewhere: `127.0.0.1` always refers to the machine or container running that Agent. The Agent machine needs no Docker or project source when using HTTP MCP.

## 5. Run your first task

Send this to your Agent:

> Use agentic-browser-local to open GitHub and send me a sign-in link. Wait until I hand control back, then count all the private repositories I own and list their names. Check every page and close the browser when finished.

Open the returned link in a browser where you are signed in to the **same workspace account**. Take control, click inside the remote website, and type directly. Complete the website login, then click **Hand back to Agent**. The Agent should list all personally owned private repositories and close the session. A working task proves the token, browser runtime, display transport and handoff all work together.

For a test without an external account, substitute `https://example.com` and ask the Agent to read its title after handback. Site-specific anti-bot restrictions are separate from workspace connectivity.

You may also create a manual session from the dashboard. Before expecting an Agent to operate it, use the dashboard's credential-binding flow (**Connect Agent and take control**) and then hand it back. Installing MCP alone does not automatically attach an Agent to every browser you created manually.

### Temporary sessions and saved profiles

Temporary sessions start with a fresh profile; closing or expiry removes their browser data. For reuse, explicitly create/select a saved profile in your workspace and grant that profile to the intended Agent credential. Saved profiles preserve website login data across sessions and controller recreation, subject to the website's own expiry/revocation.

A saved profile can be used by one session at a time. It belongs to its member; another member cannot list or use it through the application. A profile is not a running session: a controller restart ends sessions, and you open a new session using the saved profile. The server administrator remains trusted with the underlying volume.

## Configuration reference

Use one `.env` and one `compose.yaml`. Do not create `.env.compose` or `.env.public` for a new installation. Docker Compose reads `.env` and passes the supported mappings to the controller; there is no web page for server settings. Tokens and saved profiles are managed in the dashboard.

| Setting | Default | Meaning |
| --- | --- | --- |
| `AB_MODE` | `authenticated` | Member login/token access; `public` enables anonymous temporary demos |
| `AB_PROJECT_NAME` | `agentic-browser` | Container/volume namespace; keep stable to keep using the same data |
| `AB_PORT` | `3333` | Host port shared by the website, MCP and browser display |
| `AB_BIND_ADDRESS` | `127.0.0.1` | Host listen interface; use loopback behind a local proxy |
| `AB_PUBLIC_URL` | `http://127.0.0.1:<AB_PORT>` | Address users and Agents actually open; scheme, hostname and optional port |
| `AB_ADMIN_USERNAME`, `AB_ADMIN_PASSWORD` | `admin`, empty | First-account bootstrap only; choose a password before initial authenticated startup |
| `AB_MAX_SESSIONS` | `1` | Total browsers, 1–32; includes starting sessions and pending cleanup |
| `AB_MAX_SESSIONS_PER_MEMBER` | `1` | Authenticated member quota, 1–32 |
| `AB_SESSION_TTL_SECONDS` | `1800` | Authenticated initial lease, 60–14400 seconds |
| `AB_SESSION_MAX_LIFETIME_SECONDS` | `14400` | Authenticated total lifetime, 60–86400 seconds |
| `AB_MAX_SESSIONS_PER_IP` | `2` | Public mode per-source quota, 1–8 |
| `AB_TRUST_PROXY` | `false` | Trust `X-Real-IP` only behind a proxy that overwrites it |
| `AB_EGRESS_DENY_HOSTS` | Empty | Additional blocked destinations, comma-separated hostnames or supported address entries |
| `AB_DOCKER_SOCKET`, `AB_DOCKER_GID` | Detected by installer | Controller socket mount and group access; redetect on a different Docker host |

Keep the initial lease no greater than the maximum lifetime. Public mode uses its fixed 5-minute initial lease / 10-minute total lifetime, not the authenticated lifetime settings. Example: a small team can set total capacity to `5` and per-member capacity to `1`.

The installer writes literal image digests into `compose.yaml`. `AB_CONTROLLER_IMAGE` and `AB_RUNTIME_IMAGE` are source/legacy wrapper inputs; changing them in `.env` does not replace literal pins in an installer-generated Compose file. Upgrade the image/configuration pair using the procedure below. No architecture override is needed for normal deployment.

`AB_PUBLIC_URL` is the Compose setting. It maps to the controller's `PUBLIC_URL`; a lowercase `public_url` has no effect. The setting does not configure DNS, TLS, firewall rules or port forwarding. Remove stale exported `AB_*` shell variables if they unexpectedly override `.env` values.

After changing settings, finish active sessions and run:

```sh
docker compose up -d --force-recreate --wait
```

A plain `docker compose restart` does not reload environment settings. Recreation ends active browser sessions but retains accounts and saved profiles in the same data volume.

## Remote access

### Private SSH tunnel

Keep the service bound to loopback. If it uses server port 3333, run this on your laptop:

```sh
ssh -N -L 3333:127.0.0.1:3333 ubuntu@SERVER_IP
```

Keep that terminal open. Use `http://127.0.0.1:3333` and `/mcp` on your laptop. If local port 3333 is occupied, forward local port 4444 instead and use it in both addresses. The controller must be configured with a loopback public URL for its loopback port-forwarding allowance; an installation configured with a public domain expects that domain.

### Your HTTPS domain

1. Point your domain's DNS record to the server and arrange a valid certificate.
2. Set `.env` to `AB_PORT=8080`, `AB_BIND_ADDRESS=127.0.0.1`, and `AB_PUBLIC_URL=https://browser.example.com`.
3. Configure Nginx to proxy that domain to `127.0.0.1:8080`. The supplied [Nginx template](../deploy/nginx-public.conf) includes WebSocket upgrades, long request timeouts, disabled buffering and limits. Replace its domain, certificate paths and upstream port. The template is also inside the [configuration bundle](https://agentic-browser.zkpass.org/self-host/download/agentic-browser-self-host.tar.gz).
4. Validate with `sudo nginx -t`, then reload Nginx. Recreate the controller after editing `.env`.
5. Use `https://browser.example.com` for the dashboard and `https://browser.example.com/mcp` for Agents.

Keep Host/Origin and WebSocket upgrade headers intact. The proxy must overwrite client-IP headers. Enable `AB_TRUST_PROXY=true` only when direct untrusted access to the controller is prevented. Do not throttle the initial `/vendor/novnc/` module downloads; the template exempts them while limiting API requests.

Behind Cloudflare, `AB_PUBLIC_URL` remains the external HTTPS origin even when an internal hop uses HTTP. Client-IP restoration must trust only your proxy/CDN ranges, or users may share one proxy IP quota. Do not strip the `#` fragment from handoff links or rewrite module scripts. Setting an external origin alone does not make `localhost` reachable from a different machine.

For a temporary IP-only reachability check, use `AB_BIND_ADDRESS=0.0.0.0`, `AB_PUBLIC_URL=http://SERVER_IP:8080`, and `AB_TRUST_PROXY=false`, with intended firewall access. Use test data over HTTP; use HTTPS for real website sign-in. Restore loopback binding when adding a local proxy.

## Run your own public demo

Use a separate installation directory, project name and data volume from your private workspace:

```dotenv
AB_MODE=public
AB_PROJECT_NAME=agentic-browser-demo
AB_PORT=8080
AB_BIND_ADDRESS=127.0.0.1
AB_PUBLIC_URL=https://demo.example.com
AB_MAX_SESSIONS=5
AB_MAX_SESSIONS_PER_IP=2
AB_TRUST_PROXY=true
```

This example assumes the trusted HTTPS proxy described above. Public mode needs no bootstrap account or personal Agent token, exposes no saved profiles, and issues separate session credentials to each visitor. Point client MCP configurations at your domain's `/mcp` endpoint. See [Public demo usage](PUBLIC_DEMO.md) for the visitor flow.

The homepage and `GET /api/public/capacity` show counts without exposing session IDs. When full, MCP returns a tool error containing the count, limit and a suggested retry interval. Other fixed public limits include 6 create attempts/minute/IP, 120 MCP requests/minute/IP, 8 in-flight requests/IP and 64 globally. Waiting does not extend a session. Browser egress blocks private, loopback, link-local, metadata and management destinations; per-session Docker containers alone would not prevent requests to internal services.

## Account recovery and routine operations

To reset your workspace password, run this in the installation directory (replace `admin` with your username):

```sh
docker compose exec controller npm run members -- password admin
```

The command prompts for a new password without displaying it. Resetting the password revokes your existing Agent credentials and web sign-in. Sign in again and issue replacement tokens. Changing `AB_ADMIN_PASSWORD` does not reset an existing account.

For installations with existing additional accounts, the `members` CLI still supports `list`, `create`, `disable` and `enable`; resource isolation is unchanged. This is compatibility support, not a planned team product.

```sh
docker compose ps
docker compose logs --tail 100 controller
docker compose exec controller npm run doctor
curl --fail http://127.0.0.1:3333/health
```

For a domain-configured workspace, use its HTTPS `/health` address; a direct loopback request may be rejected because its Host does not match. Avoid sharing full environment dumps or logs containing credentials.

Use `docker compose stop --timeout 60 controller` to stop the workspace and `docker compose up -d --wait` to start it again. Routine stops and `down` retain the named volume. **Do not use `down --volumes` or delete the data volume unless you intend to erase accounts and saved profiles.** Do not use a global Docker prune as workspace cleanup.

## Workspace status

After signing in, open **Workspace status** on the dashboard and click **Check status**. It shows the controller version/revision, browser capacity, your session count, Agent endpoint, Docker connectivity, native runtime-image availability and free space on the workspace filesystem. Checks are read-only, time-bounded and cached for up to 15 seconds; they do not open browsers or read website login data.

The endpoint being configured does not mean your Agent token has been tested. Check the connection from your Agent too. An available runtime image does not guarantee that every website will accept sign-in. Public visitors can read the controller version and aggregate capacity; host diagnostics require a private workspace sign-in and are not available to Agent tokens.

If the service cannot start, its dashboard is unavailable as well. Use `docker compose ps`, `docker compose logs --tail 100 controller` and `docker compose exec controller npm run doctor` when the controller is running. For a stopped controller, run `docker compose run --rm --no-deps controller npm run doctor`.

## Troubleshooting

| Problem | Checks / recovery |
| --- | --- |
| Installer cannot reach Docker | Start Docker Desktop or the Docker daemon and select a local Unix-socket context. |
| Installer refuses existing files | Use the existing installation, or choose a new folder for a new installation/upgrade. |
| Controller cannot access the socket | Redetect the socket/group on this host. Do not grant the browser container socket access. |
| Connection refused / `localhost` unavailable | Check `docker compose ps`, the host port, and whether the service is remote and needs a tunnel. |
| `host_rejected` / wrong handoff domain | Correct `AB_PUBLIC_URL`, preserve Host at the proxy, and recreate the controller. |
| MCP 401 | Use a current personal Agent token, not the member password or website cookie; check the Agent process environment. |
| Browser exists but Agent cannot use it | Match the member/credential binding and hand back control. Other credentials' sessions remain private. |
| Viewer stuck on Connecting | Check session state, duplicate tabs, WSS upgrade support and static-module rate limiting. |
| Expired session | Open a new session. Reuse an explicitly saved profile if available; temporary data is not recoverable. |
| Saved profile busy | Close its existing session and wait for cleanup before opening another. |
| Changed `.env` but nothing changed | Use `up -d --force-recreate --wait`; check stale shell overrides. Bootstrap variables never reset passwords. |
| Website denies login | The website may reject a remote/data-center browser. Test a public page to separate runtime connectivity from website restrictions. |

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

Current automated upgrade evidence covers preview.5 → stable v0.1.0 and rollback from an offline backup on native amd64 and arm64. Those releases use identical Chrome and extension versions. This does not establish compatibility across future Chrome/extension version changes; see [Release verification](RELEASING.md#release-verification).

## Apple Silicon release check

Linux arm64 CI does not replace a physical Mac test. For each release you adopt, record the date, macOS and Docker Desktop versions, Mac model/allocated resources, the controller version shown in the UI and both image digests from `compose.yaml`. Do not include `.env`, tokens, cookies or private page contents in the report.

1. Run the official installer in a new folder and start with one browser. Confirm `npm run doctor` passes and Workspace status reports `linux/arm64`.
2. Create a personal token, connect your Agent and complete an example.com handoff, direct keyboard input, handback and close.
3. Save a synthetic login profile, close its browser, recreate the controller and verify the profile can be reused. A display reconnect should preserve a live session; a controller restart should end it.
4. Perform the stopped-workspace backup and fresh-volume restore described above. Confirm account access and the synthetic saved profile, then remove only the disposable test installation.
5. Record pass/fail for each step, cleanup and any errors. Mark unrun steps as pending. The prior user-reported Mac success is not evidence for a later image version.
