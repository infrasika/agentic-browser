# Version status

The product scope is **personal self-hosting plus a public demo**. Team collaboration, invitations and role management are not planned. Existing account, credential and session isolation remain supported.

## Current release

Stable `v0.1.0` is published and deployed. Application code and browser assets are unchanged from preview.5; the release adds stable/latest publication rules. Published-installation and upgrade acceptance are recorded separately below.

| Surface | Version |
| --- | --- |
| Public images | Stable `v0.1.0`; immutable references in [deploy/release.env](../deploy/release.env) |
| Release source | `d85b9196b498c12ead9ab6164e3a174eaa15833a`, tagged `v0.1.0` |
| Moving channel | Both `:latest` tags match `:v0.1.0`; only newer stable releases advance them |
| Platforms | Native Linux amd64 and arm64; Docker chooses the host architecture |
| Browser assets | Chrome 155.0.8059.79, zkPass TransGate 0.5.5, Schema Validator 0.1.3; unchanged from preview.4 |
| Official demo | https://agentic-browser.zkpass.org/ |
| Previous source baseline | `freeze-2026-10-21`; retained unchanged |

V0.1.0 retains preview.5's personal-use onboarding, authenticated workspace status panel, controller version/revision identification, clearer connection/session errors and viewer cleanup. Accounts, personal tokens, opt-in saved login profiles and the existing isolation boundaries remain intact.

The official site runs the published GHCR controller and runtime. Its installer uses those same image digests. Post-publication documentation and setup files are mounted read-only separately; there is no locally modified controller build. The installer embedded in an image resolves its immutable release tags to digests before writing `compose.yaml` because the image cannot contain its own future digest.

Image-bundled documents are build-time snapshots. The [official status download](https://agentic-browser.zkpass.org/self-host/download/STATUS.md) and this repository's current branch contain later acceptance records. Earlier release manifests, digests, tags and receipts are immutable.

## Verification

- TypeScript and all **63 unit/API/packaging tests** passed for v0.1.0, including release-channel guards for prereleases, version ordering, incomplete publication and retrying a partial alias update.
- Native amd64/arm64 publication passed isolation, handoff, public capacity and recovery acceptance. [Anonymous pulls and tag verification](../deploy/releases/v0.1.0-public-verification.json) confirmed that `v0.1.0` and `latest` resolve to the same indexes for both images. The GitHub release is stable and marked Latest; source remains private.
- [Fresh installation](../deploy/releases/v0.1.0-install-verification.json) passed on native amd64 and arm64, including credentials, workspace diagnostics, saved profiles and human handoff.
- [Preview.5 → v0.1.0 upgrade and offline rollback](../deploy/releases/v0.1.0-upgrade-verification.json) passed on both architectures, including restored account/profile state and credential revocation handling.
- The [official stable demo](../deploy/releases/v0.1.0-demo-verification.json) passed HTTPS MCP, a live browser display, takeover, handback, Agent reading and cleanup. The existing origin, settings and five-browser quota were preserved; official setup downloads use the stable image pins.

### Historical preview.5 acceptance

- TypeScript and all **62 unit/API/packaging tests** passed for the release source.
- Native amd64 and arm64 CI passed controller isolation, human handoff, public five-browser capacity and failure recovery. See [publication and anonymous-pull verification](../deploy/releases/v0.1.0-preview.5-public-verification.json).
- Both images and both architectures were pulled anonymously. Source access and GHCR login are not required for installation; the source repository remains private.
- The candidate dashboard was opened in a real browser. Version/platform, Docker/runtime and storage checks rendered correctly. A simulated HTML proxy failure showed an actionable message without raw proxy content; the panel recovered afterward.
- [Fresh published-image installation](../deploy/releases/v0.1.0-preview.5-install-verification.json) passed on independent native amd64/arm64 runners, including the real status panel, private diagnostic access, account/token setup, human handoff and saved-profile recovery.
- [Preview.4 → preview.5 upgrade and offline rollback](../deploy/releases/v0.1.0-preview.5-upgrade-verification.json) passed on both architectures. Restored accounts, tokens and synthetic website state were checked, including reapplying revocations after restoration.
- The [official HTTPS demo](../deploy/releases/v0.1.0-preview.5-demo-verification.json) passed MCP connection, public-page navigation, human takeover, handback, Agent reading and close. Its temporary browser was removed afterward.

Previous [sustained workload](../deploy/releases/v0.1.0-preview.4-soak-verification.json), [browser experience](../deploy/releases/v0.1.0-preview.4-experience-verification.json), [optional client](../deploy/releases/v0.1.0-preview.4-remote-client-verification.json) and [HTTPS](../deploy/releases/v0.1.0-preview.4-https-verification.json) receipts remain historical preview.4 evidence, not reruns against preview.5. The real GitHub sign-in/private-repository demo completed on 2026-10-18; private account data is excluded from shared evidence.

## Boundaries and maintenance

- Physical Apple Silicon acceptance of v0.1.0 is still pending. Native Linux arm64 CI and the earlier user-reported Mac success do not replace it. Follow the [Mac checklist](SELF_HOST.md#apple-silicon-release-check).
- A controller restart ends active sessions. Saved profiles can be opened in new sessions afterward; display reconnection cannot recover an expired browser.
- Website anti-bot checks, account verification and website-side login expiry still apply.
- Browser/profile-format migration is not established by a controller-only release with unchanged Chrome assets. Use an offline backup before a future browser update.
- Further zkPass-specific testing remains skipped by request. Bundled extensions do not establish live proof success.
- Settings stay in `.env`; personal tokens and profiles are managed in the dashboard. There is no planned team administration console.

Keep [Public demo usage](PUBLIC_DEMO.md) and [Self-hosting](SELF_HOST.md) as the primary user guides. Use the [maintenance and release policy](RELEASING.md#small-maintenance-release-policy) for periodic dependency review, exact-version acceptance, backup and rollback. Keep temporary logs, screenshots and test installations in ignored `output/`. Do not overwrite published image versions or silently update deployed browser assets.
