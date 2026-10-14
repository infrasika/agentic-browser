# Public demo deployment on Ubuntu

The official deployment is **https://agentic-browser.zkpass.org/**, with remote MCP at **https://agentic-browser.zkpass.org/mcp**. It is an account-free, temporary demo. Use [team self-hosting](SELF_HOST.md) for regular private use.

## Deploy published images

Install Docker Engine 26+ and Compose 2.24.4+, then obtain and verify the deployment bundle as described in [Self-hosting](SELF_HOST.md). Create a separate environment file and project name so the public demo never uses a team's private volume:

```sh
cp .env.public.example .env.public
```

For a server behind Nginx, use:

```dotenv
AB_PROJECT_NAME=agentic-browser-demo
AB_PORT=8080
AB_BIND_ADDRESS=127.0.0.1
AB_PUBLIC_URL=https://YOUR_DEMO_DOMAIN
AB_MAX_SESSIONS=5
AB_MAX_SESSIONS_PER_IP=2
AB_TRUST_PROXY=true
```

Replace `YOUR_DEMO_DOMAIN`; the official deployment uses `agentic-browser.zkpass.org`. `AB_TRUST_PROXY=true` is only appropriate when the service is reachable through a trusted proxy that overwrites `X-Real-IP`.

```sh
AB_COMPOSE_VARIANT=public bash scripts/release-compose.sh pull
AB_COMPOSE_VARIANT=public bash scripts/release-compose.sh up -d --wait --wait-timeout 90
AB_COMPOSE_VARIANT=public bash scripts/release-compose.sh doctor
```

Only the controller mounts the Docker socket. A session creates its own browser and egress proxy; no VNC, CDP, or Docker TCP port needs to be exposed.

For source development, run `bash scripts/build-container-images.sh` and `bash scripts/public-demo.sh up -d --wait` instead. `public-demo.sh` selects `.env.public`; `compose.sh` normally selects `.env.compose`. They do not source the host-process `.env`.

## Domain, proxy, and origin

Point your domain's DNS record to the server. Configure Nginx using [deploy/nginx-public.conf](../deploy/nginx-public.conf), replacing the domain, certificate paths, and backend port (8080 in the example above). Validate Nginx configuration before reloading it.

The proxy must preserve the configured Host, support WebSocket upgrades, disable response buffering, and overwrite client-IP headers. The application serves the website, `/mcp`, and browser display connections through the same port. The template includes request limits and omits access logs that could collect sensitive URL data.

For Cloudflare, preserve the browser's external HTTPS origin in `AB_PUBLIC_URL`. Do not derive it from an HTTP connection between the proxy and origin. If using Cloudflare client-IP restoration, trust only Cloudflare's configured address ranges, not arbitrary incoming headers. Without restoration, users may share a source-IP quota.

The web scripts use `data-cfasync="false"` so Rocket Loader does not rewrite the module bootstrap. Handoff credentials use URL fragments; preserve the full link when displaying or copying it. Do not rewrite `/connect#...` to a bare `/connect`.

An origin error such as `host_rejected` usually means the public URL was changed in the wrong file, the controller was not recreated, or the proxy sends the wrong Host. Configure `AB_PUBLIC_URL` in `.env.public`; Compose passes it to the application's `PUBLIC_URL`. A lowercase `public_url` setting has no effect.

## Temporary IP-only check

For an initial reachability check without a domain, set `AB_BIND_ADDRESS=0.0.0.0`, `AB_PORT=8080`, `AB_PUBLIC_URL=http://SERVER_IP:8080`, and `AB_TRUST_PROXY=false`. Recreate the controller and allow only the intended test access in the host firewall. Open `http://SERVER_IP:8080`.

Use public pages and synthetic data over HTTP. The homepage enables the real GitHub sign-in task over HTTPS. Switch back to loopback binding when placing the service behind Nginx. A browser on a Mac cannot reach a remote server by opening the server's `localhost`; use its public address or a working SSH/editor port forward.

## Limits and isolation

| Limit | Behavior |
| --- | --- |
| Total sessions | `AB_MAX_SESSIONS`, range 1–32; official demo: 5 |
| Sessions per source IP | `AB_MAX_SESSIONS_PER_IP`, range 1–8; official demo: 2 |
| Session lifetime | Initial 5 minutes; maximum 10 minutes |
| Creation rate | 6 attempts per minute per source IP |
| MCP request rate | 120 per minute per source IP |
| In-flight requests | 8 per source IP, 64 globally |
| Request body | 64 KiB maximum |

Capacity counts include startup and pending cleanup. `GET /api/public/capacity` returns aggregate counts without session IDs or user data. The homepage refreshes every 10 seconds. A full MCP create result includes `status: 429`, the count and limit, and a suggested retry interval of 30 seconds; Agents should show it rather than repeatedly creating sessions.

Public sessions cannot use saved profiles or list other users' sessions. Each create result has a separate secret session key. Human handoff uses a single-use, short-lived link; screenshots and Agent actions stop during human control. Closing, expiry, or cleanup removes temporary browser state. The administrator still controls the host, and the user's Agent can read signed-in pages after handback.

Browser networking goes through a restricted proxy. Private, loopback, link-local, metadata, reserved, and configured management targets are denied; Docker isolation alone would not stop a webpage from requesting internal services. Add other management hostnames or public IPs to `AB_EGRESS_DENY_HOSTS` as needed. The configured public service hostname is denied automatically.

## Operations and verification

```sh
curl --fail https://YOUR_DEMO_DOMAIN/health
curl --fail https://YOUR_DEMO_DOMAIN/api/public/capacity
AB_COMPOSE_VARIANT=public bash scripts/release-compose.sh ps
AB_COMPOSE_VARIANT=public bash scripts/release-compose.sh logs --tail 100 controller
```

Before an update, wait for active sessions to finish. Pull the new pinned images and recreate the controller with the new bundle, retaining the project name and `.env.public`. Do not delete a shared Docker volume or run a global prune.

Verify the homepage, **Copy prompt**, `/self-host`, and both CLI clients. A complete smoke test is create → open returned link → human input → handback → Agent reads result → close. Use separate browser profiles when testing two users: tabs in one browser normally share a guest cookie. Confirm the aggregate session count returns to its initial value.

`npm run test:public-mcp` exercises five concurrent browsers, a rejected sixth, per-source limits, human handoff, request cancellation, and cleanup. Read [Progress](PROGRESS.md) for recorded results. A successful test on a synthetic website does not guarantee Google or X will accept a sign-in from a remote browser.
