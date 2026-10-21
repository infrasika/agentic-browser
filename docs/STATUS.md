# Version status

The product scope is **personal self-hosting plus a public demo**. Team collaboration, invitations and role management are not planned. Existing account, credential and session isolation remain supported.

## Current release

| Surface | Version |
| --- | --- |
| Public images | `v0.1.0-preview.5`; immutable references in [deploy/release.env](../deploy/release.env) |
| Release source | `5055b1f32be502e19a2446d57029aa61d1b206f3`, tagged `v0.1.0-preview.5` |
| Platforms | Native Linux amd64 and arm64; Docker chooses the host architecture |
| Browser assets | Chrome 155.0.8059.79, zkPass TransGate 0.5.5, Schema Validator 0.1.3; unchanged from preview.4 |
| Official demo | https://agentic-browser.zkpass.org/ |
| Previous source baseline | `freeze-2026-10-21`; retained unchanged |

Preview.5 contains personal-use onboarding, an authenticated workspace status panel, controller version/revision identification, clearer connection/session errors and the viewer cleanup that removes the auxiliary text-entry form. Accounts, personal tokens, opt-in saved login profiles and the existing isolation boundaries remain intact.

The official site runs the published GHCR controller and runtime. Its installer uses those same image digests. Post-publication documentation and setup files are mounted read-only separately; there is no locally modified controller build. The installer embedded in an image resolves its immutable release tags to digests before writing `compose.yaml` because the image cannot contain its own future digest.

Image-bundled documents are build-time snapshots. The [official status download](https://agentic-browser.zkpass.org/self-host/download/STATUS.md) and this repository's current branch contain later acceptance records. Earlier release manifests, digests, tags and receipts are immutable.

## Verification

- TypeScript and all **62 unit/API/packaging tests** passed for the release source.
- Native amd64 and arm64 CI passed controller isolation, human handoff, public five-browser capacity and failure recovery. See [publication and anonymous-pull verification](../deploy/releases/v0.1.0-preview.5-public-verification.json).
- Both images and both architectures were pulled anonymously. Source access and GHCR login are not required for installation; the source repository remains private.
- The candidate dashboard was opened in a real browser. Version/platform, Docker/runtime and storage checks rendered correctly. A simulated HTML proxy failure showed an actionable message without raw proxy content; the panel recovered afterward.
- [Fresh published-image installation](../deploy/releases/v0.1.0-preview.5-install-verification.json) passed on independent native amd64/arm64 runners, including the real status panel, private diagnostic access, account/token setup, human handoff and saved-profile recovery.
- [Preview.4 → preview.5 upgrade and offline rollback](../deploy/releases/v0.1.0-preview.5-upgrade-verification.json) passed on both architectures. Restored accounts, tokens and synthetic website state were checked, including reapplying revocations after restoration.
- The [official HTTPS demo](../deploy/releases/v0.1.0-preview.5-demo-verification.json) passed MCP connection, public-page navigation, human takeover, handback, Agent reading and close. Its temporary browser was removed afterward.

Previous [sustained workload](../deploy/releases/v0.1.0-preview.4-soak-verification.json), [browser experience](../deploy/releases/v0.1.0-preview.4-experience-verification.json), [optional client](../deploy/releases/v0.1.0-preview.4-remote-client-verification.json) and [HTTPS](../deploy/releases/v0.1.0-preview.4-https-verification.json) receipts remain historical preview.4 evidence, not reruns against preview.5. The real GitHub sign-in/private-repository demo completed on 2026-10-18; private account data is excluded from shared evidence.

## Boundaries and maintenance

- Physical Apple Silicon acceptance of preview.5 is still pending. Native Linux arm64 CI and the earlier user-reported Mac success do not replace it. Follow the [Mac checklist](SELF_HOST.md#apple-silicon-release-check).
- A controller restart ends active sessions. Saved profiles can be opened in new sessions afterward; display reconnection cannot recover an expired browser.
- Website anti-bot checks, account verification and website-side login expiry still apply.
- Browser/profile-format migration is not established by a controller-only release with unchanged Chrome assets. Use an offline backup before a future browser update.
- Further zkPass-specific testing remains skipped by request. Bundled extensions do not establish live proof success.
- Settings stay in `.env`; personal tokens and profiles are managed in the dashboard. There is no planned team administration console.

Keep [Public demo usage](PUBLIC_DEMO.md) and [Self-hosting](SELF_HOST.md) as the primary user guides. Use the [maintenance and release policy](RELEASING.md#small-maintenance-release-policy) for periodic dependency review, exact-version acceptance, backup and rollback. Keep temporary logs, screenshots and test installations in ignored `output/`. Do not overwrite published image versions or silently update deployed browser assets.
