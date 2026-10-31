# Status and verification

Updated October 31, 2026 (Asia/Shanghai). The project uses the [MIT License](../LICENSE); bundled dependencies retain their own licenses. This page records current capabilities and verification limits. Implementation history belongs in Git.

## Delivered

- Chat and remote browser in one interface, local accounts and separate histories.
- One unfinished browser task per account, queue admission and automatic continuation after human control.
- Personal credits, a shared daily budget and administrator controls.
- Turnstile for public registration and optional TLS SMTP password recovery.
- Docker Compose deployment with persistent identity keys and project-specific named volumes.
- Container-based account management, consistent backups, verification, restore, guarded upgrades and full rollback.
- Daily backup scheduling, retention and same-day deduplication.

Fresh clones do not depend on maintainer configuration or `.deployment/`. Deployment hosts need Docker and Compose; maintenance commands run inside containers. The GitHub private-repository example and actual email receipt have also been checked manually on the test installation.

## Verified release

[v0.1.0-preview.11](https://github.com/infrasika/agentic-browser/releases/tag/v0.1.0-preview.11) is the current verified preview. Its [release workflow](https://github.com/infrasika/agentic-browser/actions/runs/41151558451) completed successfully. Three project images support Linux amd64 and arm64; all six deployment images are pinned by digest and can be pulled anonymously. Preview publication does not move a `latest` image tag.

| Area | Evidence |
| --- | --- |
| Source checks | TypeScript checks and the 66-test suite ran on Linux amd64, Linux arm64 and macOS; two Linux-only locking tests are skipped on macOS |
| Native builds | Agent, Browser Service and Chrome runtime built on both Linux architectures |
| Image provenance | Image source commit `e0d0790`; release tooling commit `4ca69c8`; image-input consistency was checked before build reuse |
| Image identity | Anonymous pulls of all six images; index, platform manifest and configuration digests bind project images to native build records |
| Full deployment | Each fresh native Linux runner passed 30 acceptance checks; no test containers, networks or volumes remained |
| Application | Real Chrome, handoff/resume, account isolation, queueing, credit idempotency, daily budget enforcement, logout cleanup and login rate limiting |
| Email | Simulated TLS SMTP password recovery, single-use reset and revocation of previous logins |
| Operations | Persistent identity/data, account commands, active-task backup rejection, verified restore, corrupt-backup rejection, interrupted-backup recovery, failed-upgrade rollback and daily retention |
| Delivery | All 15 assets were checked against GitHub digests and `SHA256SUMS`; configuration files contain placeholders |
| Existing installation | Upgrade preserved stored data, identity keys and input configuration; health checks and scheduled backup verification passed |

The workflow uses simulated model and mail services. It does not call a paid model or send external mail. macOS source checks do not establish that Docker image builds work on a physical Mac. Current CI uses macOS 15 arm64 after the macOS 14 runner retirement announcement; [the runner update passed all three source jobs](https://github.com/infrasika/agentic-browser/actions/runs/41158854382).

The release includes `compose-acceptance-amd64.json`, `compose-acceptance-arm64.json`, both public-pull receipts, `publication.json` and `release.json`. These are the portable verification records; maintainer-local logs are not deployment prerequisites.

Current guides describe the Compose layout introduced in preview.11. Older preview packages and their bundled documentation are historical snapshots; do not mix their installers with current operations commands. Documentation updates in `main` are included in future releases without rewriting existing checksummed release assets.

## Remaining acceptance and product work

| Work | Completion criterion |
| --- | --- |
| Physical Mac Docker build | Build images using the documented workflow on Mac Docker; source tests already pass |
| Off-host recovery | Copy a completed backup to a separately controlled host and verify a full restore |
| Host reboot recovery | Verify recovery after an actual host restart in a maintenance window |
| Public deployment acceptance | Verify the chosen origin HTTPS setup, Turnstile, real model provider and delivered password-recovery email end to end |

Changing an existing Agent's model is not currently supported. A local backup is not an off-host backup, and process-interruption tests do not prove recovery from a host power loss. The ten-session configuration ceiling is a limit, not a capacity guarantee; size and test each deployment for its workload.
