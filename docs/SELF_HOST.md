# Self-hosting

Deploy a private workspace on Ubuntu or Docker Desktop on a Mac. The [official demo](https://agentic-browser.zkpass.org/) is a separate, temporary public service; it does not create an account on your deployment.

## Requirements and delivery

The current pinned English release is `v0.1.0-preview.2`.

- Docker Engine 26+ and Docker Compose 2.24.4+, with a local Unix socket Docker context.
- Bash. The container distribution does not require Node.js or Chrome on the host.
- Linux amd64 or arm64. Apple Silicon Macs run the Linux arm64 images through Docker Desktop. Windows and rootless Docker are not currently validated.
- Enough memory for your configured concurrency. Each browser has a 2 GiB memory and 2 CPU limit, plus its proxy and the controller. Start with one session and measure actual usage before raising the limit.

Obtain `agentic-browser-deploy.tar.gz`, `RELEASE.json`, and `SHA256SUMS` from the deployment administrator or a GitHub account with access to the private repository's Releases. The two GHCR image packages are public and need no registry credentials; GitHub Release attachments are not public.

`deploy/release.env` pins the controller and runtime to immutable multi-platform digests. Docker selects the native architecture. Do not replace these digests with `latest` when reproducing a release. Linux amd64 and arm64 are tested natively in CI; a native arm64 release on Docker Desktop still needs its own Mac acceptance run.

## Install

```sh
# Linux; on macOS use: shasum -a 256 -c SHA256SUMS
sha256sum -c SHA256SUMS
tar -xzf agentic-browser-deploy.tar.gz
cd agentic-browser
cp .env.compose.example .env.compose
```

Review `.env.compose` before starting:

```dotenv
AB_PROJECT_NAME=agentic-browser
AB_PORT=3333
AB_PUBLIC_URL=http://127.0.0.1:3333
AB_MAX_SESSIONS=1
```

Then pull both images, start the controller, check its environment, and create a member:

```sh
bash scripts/release-compose.sh pull
bash scripts/release-compose.sh up -d --wait --wait-timeout 90
bash scripts/release-compose.sh exec controller node --import tsx src/doctor.ts
bash scripts/release-compose.sh exec controller node --import tsx src/members-cli.ts create alice
```

The password is entered in a hidden terminal prompt and must have at least 12 characters. Open `http://127.0.0.1:3333` and sign in. Create a personal Agent credential in the dashboard, then configure your client using [Agent clients](AGENT_CLIENT.md). Credentials are shown once; store them in the client's private configuration.

Only the controller receives the Docker socket, including the short startup group-ID probe. This lets it create and remove session containers, networks, and private-volume mounts. Docker access is powerful enough to manage the Docker host: run only a trusted controller image. Browser and egress-proxy containers never receive the socket. The wrapper detects the Linux socket group automatically, including on Docker Desktop.

## Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `AB_PUBLIC_URL` | `.env.compose` or `.env.public` | User-facing origin, including scheme and nonstandard port |
| `AB_PORT` | Compose environment file | Host port mapped to internal port 3333 |
| `AB_PROJECT_NAME` | Compose environment file | Deployment name and private data-volume namespace |
| `AB_MAX_SESSIONS` | Compose environment file | Total concurrent browsers; default 1 for team Compose |
| `AB_RUNTIME_PLATFORM` | Compose environment file | Default `auto`; explicit `linux/amd64` or `linux/arm64` for controlled testing |
| `AB_RELEASE_FILE` | Command environment | Alternate absolute path to a release pin file |
| `PUBLIC_URL` | `.env` for a host process | Host-process equivalent of `AB_PUBLIC_URL` |

Compose maps `AB_PUBLIC_URL` to the controller's `PUBLIC_URL`. Editing the root `.env` does not change a deployment launched with `.env.compose` or `.env.public`. Variable names are case-sensitive; `public_url` is not recognized. Recreate the controller after configuration changes.

The team Compose configuration permits one active session per member, starts sessions with a 30-minute lease, and caps lifetime at 4 hours. Agent credentials initially allow temporary sessions only. A member must explicitly authorize individual saved profiles for a credential to reuse them.

## Members and saved profiles

There is no open registration. An administrator creates separate members:

```sh
bash scripts/release-compose.sh exec controller node --import tsx src/members-cli.ts create bob
bash scripts/release-compose.sh exec controller node --import tsx src/members-cli.ts list
```

Run the CLI without arguments to see password, disable/enable, and profile-claim commands. Password changes and disabling a member revoke their active login and Agent credentials; enabling them does not restore old credentials. Revoking one Agent credential leaves other members' credentials intact.

Members can create and delete their own saved profiles in the dashboard. A saved profile preserves website login state between new sessions; it does not keep an old running session alive. A profile can only be used by one active session at a time. Legacy unowned profiles remain unavailable until an administrator explicitly assigns them with `claim-profile <member> <profile-id>`.

Data lives in the project-specific Docker volume, mounted as `/data` inside the controller. Changing the project name creates a different deployment and does not migrate existing members or profiles. The deployment administrator can access this data; isolation protects members from other members and their Agents, not from the host administrator.

## Remote access and Mac port forwarding

The default service binds to host loopback. For a remote Ubuntu host, forward the service port:

```sh
ssh -N -L 3333:127.0.0.1:3333 ubuntu@SERVER_IP
```

Open `http://127.0.0.1:3333` on your Mac while the tunnel is running. Cursor's Ports panel can create the same forwarding. If it chooses another local port, use that exact port in the handoff URL. The display and WebSocket use the same service port; do not expose VNC or Chrome debugging ports.

`AGENT_BROWSER_URL` is the API origin reachable by the MCP process. `AGENT_BROWSER_VIEW_URL` is the origin reachable by the person's browser; it only rewrites handoff links and does not create a tunnel. See [Agent clients](AGENT_CLIENT.md).

For remote team access without a tunnel, put the controller behind a trusted HTTPS reverse proxy and set `AB_PUBLIC_URL` to that origin. Preserve Host and WebSocket upgrades. The [Nginx template](../deploy/nginx-public.conf) provides the relevant proxy directives; adjust its domain, certificate paths, and backend port. The public-demo guide explains proxy/IP handling, but keep the default **team** authentication mode for private deployments.

## Upgrade, recovery, and removal

1. Keep the previous deployment bundle and image digests. Finish active sessions, then stop the controller with `bash scripts/release-compose.sh stop`.
2. Have the administrator back up the private volume while browsers and SQLite writers are stopped. Never include this backup in a release bundle.
3. Install the new bundle, retaining your environment file and project name. Pull its pinned images and start it with the install commands above.
4. Run `doctor`, sign in with a synthetic member, and check create → handoff → handback → close before resuming regular work.

Do not use `down --volumes` for an ordinary upgrade. Restart recovery cleans this instance's abandoned runtime resources; it does not resume old tasks or replay browser actions. Saved profiles remain available for new sessions after cleanup. A connection interruption can reconnect while the session is still alive; expiry requires a new session.

Reverting the image digest does not prove an upgraded Chrome profile can be downgraded. Restore the pre-upgrade private backup or use a fresh profile when compatibility is unknown. Cross-version Chrome/extension upgrade and rollback still require acceptance testing.

Use `bash scripts/release-compose.sh down` to remove the controller while retaining the data volume. Permanent data removal is an administrator operation after deciding what backups to retain. Do not run global Docker pruning to clean one Agentic Browser deployment.

## Source builds and acceptance

For authorized source users, Node.js 24+, npm, Python 3, Docker, and Linux test dependencies are required:

```sh
npm ci
npm run check
npm test
bash scripts/build-container-images.sh
cp .env.compose.example .env.compose
bash scripts/compose.sh up -d --wait
```

For the full test suite, install its host browser and desktop dependencies first:

```sh
npm run browser:install
npm run desktop:install
npm run verify
```

Results are written to `output/acceptance/<UTC timestamp>/`. `doctor` is an environment check, not a successful website-login test. A clean-directory install is not the same as validation on a new host.

`npm run package:preview` creates an allowlisted source archive with file hashes. It excludes private environment files, `.data`, `.git`, dependencies, logs, browser profiles, and downloaded binary assets. This archive is for authorized source recipients; it is separate from the public-image deployment bundle.

Pinned deployment means running the same tested image bytes. Source rebuilds are not guaranteed byte-identical because Debian package repositories still change. See [Releasing](RELEASING.md) for asset locks and publication checks.
