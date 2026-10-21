# Version status

The product scope is **personal self-hosting plus a public demo**. Team collaboration features are not planned. Account and session isolation remain supported.

As of **2026-10-21 (Asia/Shanghai)**, `v0.1.0-preview.5` is in preparation: personal onboarding, private workspace diagnostics, actionable connection errors and controller version identification. The currently accepted pins below stay unchanged until publication and acceptance complete. Browser and extension assets are unchanged.

## Version identity

| Surface | Baseline |
| --- | --- |
| Public distribution | `v0.1.0-preview.4`, with immutable image-index digests in [deploy/release.env](../deploy/release.env) |
| Supported image platforms | Linux amd64 and arm64; Docker selects the host architecture |
| Runtime assets | Chrome 155.0.8059.79, zkPass TransGate 0.5.5, Schema Validator 0.1.3 |
| Source baseline | Git tag `freeze-2026-10-21`; includes the accepted viewer cleanup and this documentation consolidation |
| Official website | https://agentic-browser.zkpass.org/ |

The official website may serve a locally built controller with newer documentation and UI than the public GHCR controller. In particular, the frozen source removes the viewer's auxiliary text-entry form. The preview.4 image digests are unchanged, so an installation using those digests may still show that form. Both support direct keyboard input and the documented handoff flow. A new multi-platform image release is required to distribute subsequent UI changes in GHCR.

The installer embeds the two accepted image digests. Preserve the installer, generated `compose.yaml`, and private `.env` to reproduce an installation. Historical release manifests and verification receipts remain immutable. Do not substitute `latest` tags or refresh dependency/browser locks during the freeze.

## Accepted behavior

- External Agents create and control browsers, hand them to people, wait for handback, and close them.
- Each session has an isolated browser. Human control blocks Agent observations and actions.
- Public MCP needs no account, has bounded leases/capacity, and does not save login profiles.
- Authenticated workspaces isolate members, Agent credentials, sessions and optional saved profiles.
- The installer requires only Docker, Compose and Bash; authenticated HTTP MCP clients need no local Docker adapter.
- Server settings are applied through `.env` and controller recreation. A team-wide administration/settings web console has not been implemented.
- The images contain the two fixed extensions. Further zkPass-specific testing remains skipped by request.

## Verification evidence

| Scope | Recorded evidence |
| --- | --- |
| Anonymous pulls, immutable images, installation | [Public verification](../deploy/releases/v0.1.0-preview.4-public-verification.json) |
| Fresh native Ubuntu amd64/arm64 installation | [Installation](../deploy/releases/v0.1.0-preview.4-install-verification.json) |
| Preview.3 → preview.4 and backup-based rollback | [Upgrade](../deploy/releases/v0.1.0-preview.4-upgrade-verification.json) |
| Two hours of five-browser synthetic activity per architecture | [Sustained workload](../deploy/releases/v0.1.0-preview.4-soak-verification.json) |
| Native display/input, reconnect and public website tasks | [Browser experience](../deploy/releases/v0.1.0-preview.4-experience-verification.json) |
| Optional Docker/stdio client | [Remote client](../deploy/releases/v0.1.0-preview.4-remote-client-verification.json) |
| TLS, HTTP MCP, WSS, proxy recovery and request limits | [HTTPS](../deploy/releases/v0.1.0-preview.4-https-verification.json) |

On 2026-10-18, the official HTTPS demo completed a real GitHub sign-in, human handback, private repository listing and session cleanup. Private repository names and credentials are not part of shared release evidence. The viewer cleanup separately passed native keyboard/reconnect and public MCP handoff/capacity checks.

The documentation freeze passed TypeScript checking, all 60 unit/API/packaging tests, relative Markdown-link validation, English-only maintained-document checks, and deterministic setup-archive generation. The two main user guides are included in the public download allowlist; private configuration and browser data remain excluded.

The user previously reported a successful Mac deployment. Preview.4 has native Linux arm64 CI evidence, not a separate recorded physical Apple Silicon acceptance run. Browser/profile-format migration, universal website login compatibility and live zkPass proof success are not established. Preview.3 and preview.4 use the same browser assets.

## Maintainer policy during the freeze

Keep [public demo usage](PUBLIC_DEMO.md) and [self-hosting](SELF_HOST.md) as the two primary user guides. Keep protocol, architecture and release details in their reference documents. Historical development chronology is available in Git history; temporary reports and screenshots belong in ignored `output/`.

Retain the source-run/legacy Compose wrappers, synthetic browser fixture, backup helper and acceptance workflows: they still support tests, existing installations or recovery. The old source-preview packager is retired because public distribution uses configuration and images.

Do not add team features or resume zkPass-specific testing automatically. For a necessary fix, record its scope, test it, and use a new release version if publishing changed image bytes. See [Releasing](RELEASING.md).
