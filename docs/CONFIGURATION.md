# Configuration reference

Image builds do not need a model key, domain or maintainer configuration. Operators fill in `settings.json` and `secrets.env` at deployment time. The same images can serve different installations. Start with [Deployment](DEPLOYMENT.md); see [Operations](OPERATIONS.md) before changing an existing installation.

## File locations

Keep deployment files in a private directory, for example:

```text
/srv/my-agent/
├── compose.yaml     # Release file with six fixed image digests
├── settings.json    # Operator settings
├── secrets.env      # Operator credentials
├── .env             # Optional Compose project, port and backup settings
├── nginx.host.conf  # Host proxy template for public access
├── release.json     # Release/image manifest; not user configuration
├── backups/         # Completed operations backups
└── releases/        # New compose.yaml files staged before upgrades
```

To keep input configuration elsewhere, create a directory containing both files and set `AGENT_CONFIG_DIR=/absolute/path/to/config/local` in the deployment `.env`. Initialization, backups and restores use that location. This setting moves only the two input files, not the MongoDB, Redis or other Docker volumes. Two installations need different project names, ports and configuration directories. Do not change an existing project's name casually: it selects a different set of data volumes.

The source repository contains only `config/settings.example.json` and `config/secrets.env.example`. For local deployment from a checkout, copy these to ignored `config/local/` and set `AGENT_CONFIG_DIR` accordingly. Neither that directory nor `.deployment/` is required for builds.

The initializer generates application identity keys, an internal browser token, gateway configuration and mail verification state in Docker volumes. Repeated startup preserves existing keys. Invalid identity files block startup and should be restored from a verified backup.

## settings.json

JSON does not allow comments or trailing commas. Fill the empty model fields before the first startup.

| Field | Meaning |
| --- | --- |
| `version` | Configuration format; keep `1` |
| `name` | Site name |
| `origin` | Full access origin, without an extra path, query or fragment; HTTPS for public access, loopback HTTP for private use |
| `adminEmail` | Email for the first administrator account |
| `registration` | `closed` or `public`; default `closed` |
| `turnstileSiteKey` | Public Turnstile key; must be paired with its secret; required for public registration |
| `model.name` | Model ID, chosen before creating the installation |
| `model.baseURL` | Compatible API base URL, usually ending in `/v1`, without `/chat/completions` |
| `model.promptRate`, `model.completionRate` | Input and output prices in USD per million tokens, as nonnegative numbers |
| `credits.initial` | One-time initial account credit balance, default `200000`; not a daily refill |
| `credits.daily`, `credits.timeZone` | Initial site-wide daily budget and accounting timezone, default `20000000` and `Asia/Shanghai`; an administrator-saved budget takes precedence |
| `browser.maximum` | Active browser capacity from 1 to 10, default 1; each account can have one unfinished lease |
| `trustedProxyIPs` | Optional list of up to eight trusted proxy IPs; for host Nginx, use its actual Docker bridge source address |
| `smtp` | Optional object with `host`, `port`, `encryption`, `from` and `username`; see [Operations](OPERATIONS.md) |

**1,000,000 credits represents USD 1.** For example, if input costs USD 0.50 per million tokens, set `promptRate` to `0.5`. This illustrates the units; it is not a Qwen price quote. Confirm the provider, model, region and currency, and convert rates to USD before entering them. Accounting depends on these configured rates.

Changing `model.name` on an existing Agent is not supported: startup rejects a model mismatch. You can rotate the API key or change the endpoint for the same model. Restore the original model name after an accidental change; deleting the database is not a model migration procedure.

## secrets.env

Only these user-supplied variables are accepted. Set file permissions to `0600` and keep the file out of Git and images.

| Variable | Meaning |
| --- | --- |
| `QWEN_API_KEY` | Required API key for the configured model and endpoint |
| `DEMO_ADMIN_PASSWORD` | Required first administrator password, 12–256 characters; changing it does not reset an existing account |
| `TURNSTILE_SECRET_KEY` | Optional Turnstile secret; fill both keys or leave both empty |
| `SMTP_PASSWORD` | Optional SMTP password; use the Email Sending token here for Cloudflare SMTP |

The initializer reads the file through a read-only mount using Node's `parseEnv`; Compose does not interpolate it. Quote values containing `#` or other dotenv-sensitive characters. Do not run `source secrets.env`. JWT and encryption keys and the Browser Service token are generated in persistent volumes, not supplied in this file.

## Compose .env and interpolation

`.env` is an optional operator-created parameter file beside `compose.yaml`. Compose reads it automatically when commands run from that directory; the application does not generate it. With the defaults below, nothing needs to be filled in. The deployment guide recommends an explicit project name so later commands keep selecting the same installation. The source repository does not need a root `.env` for building.

| Parameter | Default / purpose |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | `agentic-browser`; determines the project and volume names |
| `AGENT_PORT`, `AGENT_BIND` | `3333`, `127.0.0.1`; gateway host port and bind address |
| `AGENT_CONFIG_DIR` | `.`; directory containing both user configuration files |
| `AGENT_BACKUP_TIMEZONE`, `AGENT_BACKUP_HOUR` | `Asia/Shanghai`, `4`; daily backup timezone and hour |
| `AGENT_BACKUP_KEEP` | `7`; retain 1–365 completed backups |
| `AGENT_ALLOW_LOCAL_IMAGES` | `0`; set to `1` only for maintainer acceptance of local candidate images |

For example, `AGENT_PORT=3351` replaces `${AGENT_PORT:-3333}` in the Compose YAML with `3351`; if unset, the default is `3333`. This is interpolation. Variables in `.env` do not automatically become application environment variables: Compose must explicitly reference them. Release image digests are fixed in the YAML, and model credentials do not participate in interpolation.

Put API keys and passwords in `secrets.env`, not `.env`. Keep `AGENT_BIND=127.0.0.1` for the documented SSH and host Nginx paths. If you change `AGENT_PORT`, also update the host proxy upstream or SSH forwarding and, for direct private access, the port in `settings.json`'s `origin`.

Exported shell variables take precedence over `.env`. Avoid a conflicting `COMPOSE_PROJECT_NAME`, `AGENT_PORT` or `AGENT_CONFIG_DIR` in the shell. You can validate the resolved configuration without starting containers:

```bash
docker compose config --quiet
```

See [Docker's interpolation reference](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/) for the underlying behavior.

## Host proxy and release manifest

`nginx.host.conf` is a template for **host Nginx**, separate from the gateway container. For public access, install it and edit the hostname, certificate/key paths and upstream port as described in [Deployment](DEPLOYMENT.md#6-configure-host-nginx-and-client-ip-forwarding). Changes take effect only after validating and reloading the installed Nginx configuration. Leave this file unused for private access through SSH. The template contains no certificate or private key.

`release.json` is generated by publication tooling. It records the application version, supported Linux platforms and immutable references for the six deployment images. Packaging uses those references to produce `compose.yaml`; Compose itself does not read the manifest at startup. Keep it unchanged as a record of the release. Changing it does not change a running deployment, select a model or provide credentials. Use the documented upgrade procedure to install another release.

## Persistent data

The supplied Compose file already persists data in **Docker named volumes** on the server's disk. Compose creates them automatically; operators do not need to make MongoDB/Redis directories or modify the YAML. These volumes exist independently of containers and image layers. See [Docker's volume documentation](https://docs.docker.com/engine/storage/volumes/).

| Compose volume | Main mount / contents | Included in `ops backup`? |
| --- | --- | --- |
| `mongo-data` | MongoDB `/data/db`: accounts, chats, credits and budget records | Yes |
| `redis-data` | Redis `/data`: persisted Redis state used by the application | Yes |
| `browser-data` | Browser Service `/data`: scheduler database and runtime records | Yes |
| `config` | Agent `/config` and `/run/secrets`: generated configuration, identity keys and mail verification state | Yes |
| `browser-config` | Browser Service `/service-config`: generated browser settings and internal credentials | Yes |
| `gateway-config` | Gateway `/etc/nginx/agent`: generated routing and proxy settings | Yes |
| `uploads` | Agent `/app/uploads`: uploaded files | Yes |
| `images` | Agent `/app/client/public/images`: stored image files | Yes |
| `logs` | Agent `/app/logs`: application log files | Yes |
| `operations` | Operations `/state`, gateway `/maintenance`: operation locks, maintenance state and schedule receipts | No; managed by operations on the target installation |

Redis starts with `--appendonly yes --appendfsync everysec`: its append-only log is stored on `redis-data`. This provides persistence with a possible loss of about one second of recent writes after an abrupt failure; it is not a zero-loss guarantee. See [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/). MongoDB and Redis have no published host ports and communicate over the internal database network.

With `COMPOSE_PROJECT_NAME=my-agent`, most volume names have the `my-agent_` prefix, for example `my-agent_mongo-data`. The browser volume has the explicitly configured name `my-agent-browser`. Replace `my-agent` with your actual project name in these read-only checks:

```bash
docker volume ls --filter label=com.docker.compose.project=my-agent
docker volume inspect my-agent_mongo-data --format '{{.Mountpoint}}'
docker volume inspect my-agent_redis-data --format '{{.Mountpoint}}'
docker info --format '{{.DockerRootDir}}'
```

The reported mountpoints are Docker-managed locations; do not edit their files or copy a running database as a backup. Use `ops backup` and `ops restore` so data and identity keys stay together. Browser scheduler persistence does not make active Chrome sessions or website login cookies a permanent user profile.

For a dedicated data disk, provision durable storage for Docker before installing and allow room for image layers, volumes and backups. `AGENT_CONFIG_DIR` is not a database storage setting. Replacing named volumes with arbitrary bind mounts is outside the supported deployment: the built-in backup/restore commands expect the declared named volumes and do not archive custom host mounts. Moving an existing Docker data directory is separate host administration affecting all its containers.

## How containers receive configuration

| Data | Path into the application |
| --- | --- |
| Operator input | `init` mounts `/input/settings.json` and `/input/secrets.env` read-only, validates them and generates runtime configuration |
| Application settings and identity | Dedicated `config` volume, mounted read-only by Agent; startup injects application process variables |
| Browser settings | Separate `browser-config` volume, containing addresses, capacity and service credentials, without model or login keys |
| Gateway settings | Separate `gateway-config` volume, rendered from origin and proxy trust settings |
| Operations state | `operations` volume, containing the operation lock, maintenance state and scheduler receipts |

The trusted server administrator controls the deployment directory, Docker socket and backups. Backups include identity keys and user data; preserve them together during recovery.

Configure Cloudflare DNS, proxying and SSL mode in Cloudflare. Host Nginx owns the origin certificate. The application does not need a Cloudflare Global API Key, DNS-editing token or account ID. Git/GHCR authentication uses the Docker or system credential store and is separate from site configuration.
