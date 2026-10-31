# Deploy on your own server

Install a published release on your own server. Follow steps 1–4 for private access, add steps 5–6 for public HTTPS, then complete the checks and backups. For an existing installation, use [Operations](OPERATIONS.md); parameter definitions are in [Configuration](CONFIGURATION.md).

The commands below target **v0.1.0-rc.2**. Check the [release notes and verification reports](https://github.com/infrasika/agentic-browser/releases), and use matching assets from one release.

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

Choose a new private directory and download the matching release files. No GitHub token is needed:

```bash
umask 077
mkdir -m 700 "$HOME/my-agent"
cd "$HOME/my-agent"
(
  set -eu
  AGENT_VERSION='v0.1.0-rc.2'
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

Continue only after every checksum reports `OK`. Verify before editing configuration: local edits will intentionally change its checksums.

Use the downloaded `compose.yaml`; Docker selects the host architecture automatically. The bundled guides are publication snapshots. See [Deployment files](CONFIGURATION.md#deployment-files) for which files to edit; the next steps cover the required changes.

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

Keep the initial `registration: closed` and `browser.maximum: 1` values, and leave both Turnstile keys empty until step 7. Leave the two configuration files beside `compose.yaml` for this walkthrough; [Configuration](CONFIGURATION.md) covers other settings and locations.

## 4. Start and check the application

From the deployment directory, run `nano .env` and save the following beside `compose.yaml`:

```dotenv
COMPOSE_PROJECT_NAME=my-agent
AGENT_PORT=3333
AGENT_BIND=127.0.0.1
```

Keep this project name unchanged for future operations. Other [Compose parameters](CONFIGURATION.md#compose-env-and-interpolation) can use their defaults. MongoDB, Redis and application identity already use [persistent volumes](CONFIGURATION.md#persistent-data); no extra storage setup is required.

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

**Private or team use:** keep `registration: closed`. Log in as the administrator and [create ordinary accounts](OPERATIONS.md#create-accounts-and-reset-passwords) as needed.

**Public demo:** create a [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/) for your actual hostname. Put its site key in `turnstileSiteKey` and secret in `TURNSTILE_SECRET_KEY`, then set `registration: public`. Apply these changes using the [configuration update procedure](OPERATIONS.md#change-configuration-or-stop-the-site).

For password recovery by email, follow [Email setup](OPERATIONS.md#enable-email-password-recovery). Without email, use the account-reset command in Operations.

Verify in your own browser:

- Log in, run the GitHub example, take browser control and click Done; confirm the task resumes.
- Enter website passwords and verification codes in the controlled browser, not chat; check the final result.
- For public registration, use an ordinary account to check its initial credits, real model charges, chat history and lack of administrator access.
- Check that the balances and site budget in the administrator interface match your intended limits.
- If email is enabled, confirm actual receipt and complete a password-reset flow.

## 8. Enable backups

When tasks are idle:

```bash
docker compose run --rm ops backup
docker compose --profile backups up -d backup
docker compose logs --tail 20 backup
```

Follow [Operations](OPERATIONS.md#health-and-manual-backups) to review backup coverage, adjust the schedule, copy completed backups off-host and test a restore. **Do not run `docker compose down -v` on an installation you want to keep:** it deletes persistent data.
