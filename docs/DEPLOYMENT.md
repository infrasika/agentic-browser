# Deploy on your own server

This guide installs chat, the browser panel, local accounts, personal credits and a site-wide budget. The server needs Docker Engine and Compose; it does not need source code, Node.js, npm or a separate MCP service. Private use can keep registration closed and connect through an SSH tunnel. Public deployment uses Cloudflare and host Nginx.

The commands below target the verified **v0.1.0-preview.11** Compose release. For newer versions, check the [release notes and verification reports](https://github.com/infrasika/agentic-browser/releases) and use matching assets from one release. Historical preview installers are not interchangeable with these commands.

## 1. Prepare a Linux server

| Requirement | Details |
| --- | --- |
| System | Linux amd64 or arm64; local system Docker daemon at `/var/run/docker.sock` |
| CPU | Meet MongoDB's platform requirements; amd64 needs AVX, arm64 needs ARMv8.2-A or later |
| Starting resources | Plan for 4 vCPU, 8 GiB RAM and at least 30 GiB free disk for a one-browser installation; allow extra space for backups |
| Containers | Docker Engine 26+ and a current Compose plugin; install supported versions on a new host |
| Model | Available model ID, compatible API base URL, API key and input/output rates |
| Public access | Domain managed by Cloudflare and a server IP; Turnstile for public registration; email optional |

Ubuntu 24.04 with a supported distribution kernel is the CI-tested baseline. Follow [Docker's Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/) and check [MongoDB's CPU and kernel requirements](https://www.mongodb.com/docs/manual/administration/production-notes/#platform-support), including any kernel incompatibility notices, before choosing a host. The deployment user must be a trusted administrator able to access Docker. Browser Service uses the socket to create isolated Chrome containers; rootless and remote daemons are not supported by this deployment.

```bash
docker version
docker compose version
docker info --format '{{.OSType}} / {{.Architecture}}'
```

The server needs outbound access to image registries, the model API and target websites. Install `curl` and an editor for the following steps. Public installations also need host Nginx, for example `sudo apt install nginx` on Ubuntu.

## 2. Download and verify release files

Choose a new private directory. The following downloads all 15 attachments from the pinned release without a GitHub token:

```bash
umask 077
mkdir -m 700 "$HOME/my-agent"
cd "$HOME/my-agent"
(
  set -eu
  AGENT_VERSION='v0.1.0-preview.11'
  RELEASE_URL="https://github.com/infrasika/agentic-browser/releases/download/$AGENT_VERSION"
  for asset in compose.yaml settings.json secrets.env nginx.host.conf \
    DEPLOYMENT.md CONFIGURATION.md OPERATIONS.md LICENSE \
    release.json publication.json \
    public-pull-amd64.json public-pull-arm64.json \
    compose-acceptance-amd64.json compose-acceptance-arm64.json SHA256SUMS
  do
    curl --fail --location --silent --show-error \
      --output "$asset" "$RELEASE_URL/$asset"
  done
  sha256sum -c SHA256SUMS
)
```

Continue only after every checksum reports `OK`. Verify before editing configuration: local edits will intentionally change its checksums. Keep downloaded templates and a verified backup before future upgrades.

The minimum runtime files are `compose.yaml`, `settings.json` and `secrets.env`. The latter two are templates, not working credentials. Do not use `deploy/compose/compose.template.yaml` directly: release tooling must replace its image placeholders. Docker selects the appropriate Linux architecture from the same published image references.

The versioned, universal deployment archive is planned but is not an asset of this release. Use the individual files above for now; there is no supported `curl | sh` installer.

### Which files do I edit?

| File | Operator action |
| --- | --- |
| `settings.json` | **Required:** set the site, administrator email and model settings in step 3 |
| `secrets.env` | **Required:** fill the model key and initial administrator password; add Turnstile/mail credentials when enabled |
| `.env` | Optional Compose parameters; create the small file in step 4 to keep the project name explicit. Change ports, input directory or backup schedule only when needed |
| `nginx.host.conf` | Public access only: install and adapt this host Nginx template in step 6. Private SSH access does not use it |
| `compose.yaml` | Keep the release version; ordinary customization uses the files above. Upgrade through `ops upgrade` |
| `release.json` | Do not edit. Release manifest recording the version, supported architectures and six image references; Compose starts from `compose.yaml`, not this manifest |
| `publication.json`, acceptance/pull reports, `SHA256SUMS` | Do not edit. Publication, test and checksum evidence; no credentials or user settings belong here |

## 3. Fill in settings and credentials

```bash
chmod 600 settings.json secrets.env
nano settings.json
nano secrets.env
```

| Location | Required value |
| --- | --- |
| `settings.json`: `adminEmail` | Your administrator email |
| `model.name`, `model.baseURL` | Model ID and API base URL, usually ending in `/v1`, without `/chat/completions` |
| `model.promptRate`, `model.completionRate` | Numeric input/output prices in USD per million tokens |
| `origin` | Keep `http://127.0.0.1:3333` for private use; set your own HTTPS origin for public access |
| `secrets.env`: `QWEN_API_KEY` | Key matching the model, region and endpoint |
| `DEMO_ADMIN_PASSWORD` | Initial administrator password of at least 12 characters; save it in your password manager |

Start with `registration: closed` and `browser.maximum: 1`. Leave both Turnstile keys empty until enabling it. Capacity can be 1–10; each account can hold one unfinished session. See [Configuration](CONFIGURATION.md) for all fields, rates and separate configuration directories.

The initial password creates the administrator only once. Application identity keys are generated inside persistent volumes. Image builds require none of these deployment credentials.

## 4. Start and check the application

From the deployment directory, run `nano .env` and save the following beside `compose.yaml`:

```dotenv
COMPOSE_PROJECT_NAME=my-agent
AGENT_PORT=3333
AGENT_BIND=127.0.0.1
```

Compose automatically reads this file to substitute parameters in the YAML. It is not the application's secrets file and is not generated at startup. These port and bind values already match the defaults; the explicit project name keeps this installation's containers and volumes identifiable. Keep that name unchanged for future operations. With all defaults, `.env` can be omitted; [Configuration](CONFIGURATION.md#compose-env-and-interpolation) lists the available parameters.

MongoDB and Redis persistence is already configured: Compose creates named volumes on the Docker host and mounts them at `/data/db` and `/data` respectively. You do not need to create database directories, add host mounts or enter separate database credentials. Generated identity keys, uploads and browser scheduler data also use persistent volumes. See [Persistent data](CONFIGURATION.md#persistent-data) for the complete mapping and how to locate it on disk.

```bash
docker compose up -d
docker compose ps -a
docker compose logs --tail 50 init
docker compose run --rm ops status
```

The first startup pulls six images and initializes configuration and accounts. `init` and `runtime-image` should finish with `Exited (0)`; the main services keep running. Wait for `ops status` to report `healthy: true`. `ops` runs on demand; scheduled backup is enabled later. Database and browser control ports are not published.

For private use, run this on your own computer:

```bash
ssh -L 3333:127.0.0.1:3333 USER@SERVER
```

Keep the SSH connection open, visit `http://127.0.0.1:3333`, and log in with the administrator email and password. You can skip to step 7. Cloudflare is not required for this private access path.

## 5. Prepare public DNS and HTTPS

The public path is Cloudflare HTTPS → host Nginx HTTPS → `127.0.0.1:3333` → Compose gateway.

1. Create a proxied A record pointing to the server. Add AAAA only if the server has working IPv6.
2. Prepare a certificate and matching private key covering your hostname. Reuse an appropriate existing certificate or create a Cloudflare Origin CA certificate. Cloudflare's visitor-facing edge certificate does not install a certificate on your server.
3. Allow inbound HTTPS on port 443 and keep Cloudflare WebSockets enabled. Do not cache chat, API or browser-streaming routes.

Configure and test origin HTTPS before enabling Full (strict) for this application. The origin certificate must be valid and match the hostname, issued by a trusted CA or Cloudflare Origin CA. See [Full (strict) requirements](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/).

## 6. Configure host Nginx and client IP forwarding

Find the frontend network gateway; use the project name from `.env`:

```bash
docker network inspect my-agent_front \
  --format '{{range .IPAM.Config}}{{.Gateway}}{{"\n"}}{{end}}'
```

Add the actual address to the top level of `settings.json`, for example `"trustedProxyIPs": ["172.20.0.1"]`. It is the host proxy's source address as seen by the Compose gateway, not a Cloudflare range or a visitor IP. During initial setup with no active tasks, save settings and regenerate runtime configuration:

```bash
docker compose stop
docker compose up -d --force-recreate
docker compose run --rm ops status
```

Keeping the network preserves its address. Check it again if the network is removed and recreated.

`nginx.host.conf` configures Nginx on the host, which terminates HTTPS and forwards requests to the Compose gateway. Compose does not automatically load this file; its internal gateway configuration is generated separately.

Install the supplied Nginx template. Replace the certificate source paths below with your actual files; if a usable certificate is already installed, reference its existing paths in the template instead of overwriting it:

```bash
sudo install -d -m 700 /etc/nginx/agentic-browser
sudo install -m 600 /path/to/origin.pem /etc/nginx/agentic-browser/origin.pem
sudo install -m 600 /path/to/origin.key /etc/nginx/agentic-browser/origin.key
sudo install -m 644 nginx.host.conf /etc/nginx/conf.d/agentic-browser.conf
sudoedit /etc/nginx/conf.d/agentic-browser.conf
```

In the installed `/etc/nginx/conf.d/agentic-browser.conf`, replace every `agent.example.com` with your hostname, set the certificate/key paths and match the upstream port to `AGENT_PORT` in `.env`. Nginx does not read `.env`; a port change requires updating both. Recheck the [Cloudflare IP ranges](https://www.cloudflare.com/ips/). Preserve the template's identity-header removal, WebSocket support, streaming and cache settings.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Reload only after validation succeeds, then enable Full (strict) for this application. Replace the hostname in this check:

```bash
curl --fail --silent --show-error -o /dev/null -w '%{http_code}\n' \
  https://agent.example.com/api/config
```

Expect HTTP 200. The login URL must match `origin`. Keep the Compose gateway on loopback and do not expose database or browser control ports.

## 7. Choose registration policy and verify features

**Private or team use:** keep `registration: closed`. Existing accounts can log in; create ordinary users with `ops user-create` as described in [Operations](OPERATIONS.md). Administrators and ordinary users share a login page, with permissions assigned by role.

**Public demo:** create a [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/) for your actual hostname. Put its site key in `turnstileSiteKey` and secret in `TURNSTILE_SECRET_KEY`, then set `registration: public`. Follow the operations guide to stop writers and regenerate configuration. Both frontend and server verification are included; no custom Worker is required.

Email is optional. Follow the Cloudflare SMTP setup in the operations guide to enable password recovery. Without email, a server administrator can reset accounts through `ops user-reset`.

Verify in your own browser:

- Log in, run the GitHub example, take browser control and click Done; confirm the task resumes.
- Enter website passwords and verification codes in the controlled browser, not chat; check the final result.
- For public registration, use an ordinary account to check its initial credits, real model charges, chat history and lack of administrator access.
- Check the site budget in the administrator interface. The default represents USD 20 per day using the configured rates.
- If email is enabled, confirm actual receipt and complete a password-reset flow.

## 8. Enable backups

When tasks are idle:

```bash
docker compose run --rm ops backup
docker compose --profile backups up -d backup
docker compose logs --tail 20 backup
```

By default, backup runs when idle after 04:00 Asia/Shanghai and keeps the latest seven completed backups. Backups live under the deployment directory's `backups/`; application data lives in dedicated named volumes. Copy completed backups off the server and test a restore using [Operations](OPERATIONS.md). Copying only the deployment directory does not copy the live MongoDB or Redis volumes. Keep `.env` and the installed host Nginx configuration/certificates separately; `ops backup` does not include them.

**Do not run `docker compose down -v` or `--volumes` on an installation you want to keep.** It removes data and identity keys. Container recreation preserves volumes. Diagnose startup failures through init logs and `ops status`; do not delete volumes to work around invalid configuration.
