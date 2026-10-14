# Progress

## Current capabilities

- External Agents can create and operate a browser, pause for a person, wait for handback, and close the session.
- Team deployments have member accounts, personal Agent credentials, optional saved profiles, ownership checks, revocation, reconnect, expiry reminders, and restart cleanup.
- Each browser uses a separate Docker runtime and controlled egress proxy. Only the controller receives Docker socket access.
- The public demo supports real public websites through remote HTTP MCP, temporary guest sessions, one-time handoff links, and capacity feedback.
- The official demo is **https://agentic-browser.zkpass.org/**; its MCP endpoint is **https://agentic-browser.zkpass.org/mcp**. The configured total limit is 5 browsers, with 2 per source IP.
- Both Codex CLI and Claude Code public handoff flows were verified by the user.

## Published baseline: v0.1.0-preview.1

The [first multi-platform preview](https://github.com/infrasika/agentic-browser/releases/tag/v0.1.0-preview.1) was built from `737c2f1793c66733faf9f39fc6053022e2e9ca4e`. [Native amd64 and arm64 Actions validation](https://github.com/infrasika/agentic-browser/actions/runs/38508756846) passed. These GitHub links require source-repository access.

Both architectures passed type/unit/API checks, extension and Chrome sandbox checks, team/controller integration, and public MCP capacity/handoff tests. Both controller/runtime images were pulled anonymously for both platforms. A clean-directory installation of the deployment bundle passed on the existing Ubuntu amd64 host. The receipt is [v0.1.0-preview.1-public-verification.json](../deploy/releases/v0.1.0-preview.1-public-verification.json).

The source repository is private. Both GHCR packages are public, and anonymous pulls were rechecked after restoring repository privacy. At this release, an administrator supplied the deployment bundle because GitHub Release attachments remained private. The public setup download described below removes that prerequisite for new installations.

## English documentation and product update — 2026-10-14

Consolidated twelve overlapping guides into seven focused documents, retaining setup, architecture, release, and validation details. Removed six superseded design/deployment documents and merged their relevant content. The README, runtime guide, and canonical third-party notices are in English; original license text is retained.

All first-party website pages, accessibility labels, copy prompts, MCP handoff/capacity messages, API errors, and CLI output are now English. The website includes a public `/self-host` guide covering Ubuntu, Mac, member setup, pinned images, remote access, and upgrades. Packaging includes the consolidated guides and Nginx template.

Local validation passed: TypeScript; 51 unit/API tests; 2 extension/sandbox tests; team controller isolation, handoff and restart recovery; public five-browser capacity and handoff; Chromium; 2 desktop/persistence tests; and the offline demo. The offline test now accepts `AB_RUNTIME_IMAGE` so release candidates are tested instead of an older default image.

Playwright checks covered the homepage, Copy prompt, missing-link recovery, member sign-in/dashboard, and self-hosting guide. Desktop and 390-pixel mobile checks found no horizontal overflow or Chinese text. Relative documentation links, release-bundle allowlist, Python/JavaScript syntax, and source packaging passed. Screenshots are under `output/playwright/`. A scan of maintained first-party files found no Chinese text.

Published **v0.1.0-preview.2** from `5954bb3411d9282bfa4068ea0af98cac877b43e4`. [Native amd64/arm64 release validation](https://github.com/infrasika/agentic-browser/actions/runs/38513168816) passed. Both controller/runtime images passed anonymous pulls on both platforms, and a fresh-directory deployment of the actual release bundle passed on the existing Ubuntu host. The published bundle contains only English text and all relative documentation links resolve.

`deploy/release.env` now pins this English release. The official demo was updated while it had no active sessions; its five-browser limit was retained. Live HTTPS checks passed for the homepage, copy prompt, GitHub task, self-hosting guide, and MCP create → English page snapshot → handoff message → close. The smoke-test session was removed and capacity returned to 0 / 5.

The [v0.1.0-preview.2 verification receipt](../deploy/releases/v0.1.0-preview.2-public-verification.json) is also attached to the private GitHub Release as `PUBLIC-VERIFICATION.json`. The source repository remains private and both GHCR packages remain public. Earlier immutable image digests, bundles, and checksums are retained. Source and deployment packaging include archived public verification receipts so progress-guide links remain valid.

## Simpler homepage prompts — 2026-10-14

Replaced the GitHub example with a plain-language task: open GitHub, send a sign-in link, wait for handback, count and list all owned private repositories, then close the browser. Added **Copy task**, shortened the setup prompt, and moved manual Codex/Claude/JSON configuration into a collapsed section. Tool identifiers and response-field names stay in the MCP contract instead of the user-facing prompts. README and client-guide examples match the homepage.

JavaScript syntax and Playwright checks passed for task/setup copying, the Claude command, clipboard-denial fallback, and a 390-pixel mobile layout. The real HTTPS homepage and its Copy task button were verified after deployment.

The official demo uses the locally built controller `agentic-browser:homepage-c1abc10d262f` for this frontend update. Its published runtime, five-browser capacity, and release `v0.1.0-preview.2` image pins are unchanged. A future image release will include this homepage update; running the pinned release deployment command restores the published controller version.

## Public self-hosting download and demo steps — 2026-10-14

The self-hosting page now offers a direct setup download and checksum. Users can pull the two accepted public images, configure `.env.compose`, start the controller, and create a member without a source checkout or GitHub access. The controller creates separate browsers from the runtime image on demand. The public archive shares the release deployment allowlist; it contains configuration, helpers, documentation, notices, image pins, and a file-hash manifest. Private environment files, source files, and browser state are excluded. Historical release assets and the `v0.1.0-preview.2` image pins are unchanged.

The homepage now presents the GitHub task in the actual order: connect the Agent, send the task, open the Agent's link, sign in, and hand control back. The Agent then counts and lists the owned private repositories and closes the browser.

Validation passed: TypeScript; all 52 unit/API tests; reproducible archive generation, fixed image pins, symlink rejection, and unauthenticated download routes; anonymous pulls of both pinned images; and a clean-directory Ubuntu amd64 install from the downloaded setup files. The installation passed scoped mounts, synthetic member isolation, native handoff/handback, saved profiles, restart/crash recovery, and cleanup. The test harness stayed outside the deployment directory; the installed service required only the downloaded configuration and public images. This was on the existing host, not an independent new server.

Playwright verified task copying, the four-step order, the setup download button, and both pages at a 390-pixel width. Documentation links and English-only maintained content checks passed. Evidence is under `output/self-host-check/` and `output/playwright/`.

Deployed source commit `265949af9c03` to the official demo as `agentic-browser:self-host-265949af9c03` after confirming no active sessions. Live HTTPS downloads matched the committed archive byte-for-byte; its checksum and every manifest file hash passed. The live homepage, Copy task button, and self-hosting page were verified in Playwright. Health remained OK and capacity stayed at 5 browsers. This replaces the previous homepage-only controller patch; published controller/runtime pins remain `v0.1.0-preview.2` until the next image release.

## Source-free setup commands and remote clients — 2026-10-14

Replaced source-looking account, environment-check, and MCP commands in the public self-hosting guide with commands shipped in the setup download: `doctor`, `member`, and `mcp`. The guide explicitly identifies the downloaded configuration/helper folders. README and deployment guides use the same commands.

Remote members can now use `pull-client` and `mcp-remote` to run the MCP client from the existing pinned public controller image. This requires their local Docker installation and personal credential, without source access, host Node.js, or server Docker permissions. The temporary client receives no host mounts, Docker socket, or private data volume. Custom-domain instructions use the configured public origin so host validation remains intact.

TypeScript and all 53 unit/API tests passed, including extracted-bundle command dispatch, immutable image selection, credential handling, and remote-client mount restrictions. A separate clean-directory installation from the generated setup archive passed on the existing Ubuntu amd64 host using the published images. It verified the hidden interactive member password prompt, the doctor helper, both MCP client modes (11 tools, authenticated create, snapshot, handoff protection, close), rejection of an invalid credential, and removal of the disposable installation. The external test harness was not part of the deployment directory. Evidence is under `output/self-host-client-check/`. Published image digests are unchanged.

Deployed `7f307dfb9477` as `agentic-browser:source-free-7f307dfb9477` after confirming zero active public sessions. The official HTTPS guide and anonymous archive download matched the tested files; checksum and all manifest hashes passed. Playwright verified both client configurations, the remote-client disclosure, and desktop/390-pixel layouts without horizontal overflow. Service health passed and capacity remained 0 / 5. This controller-only update replaces the earlier self-hosting page patch; the public release image pins remain unchanged.

## Concise self-hosting and startup configuration — 2026-10-14

Reorganized the self-hosting page and guide around download, configure, start, and connect. The page keeps optional settings, client JSON, and maintenance details collapsed; the guide retains the full configuration reference. Contributor setup stays in README. Updated stale roadmap/release wording about source access.

The configuration table distinguishes server settings in `.env.compose`, member administration through the helper, personal credentials/profiles in the dashboard, and connection settings in the Agent client. It explains supported Compose mappings, the separate source-run `.env`, shell overrides, and why recreation is required after edits.

Exposed `AB_MAX_SESSIONS_PER_MEMBER`, `AB_SESSION_TTL_SECONDS`, and `AB_SESSION_MAX_LIFETIME_SECONDS` in the setup configuration, retaining defaults of 1, 1800, and 14400. These map to existing settings in the published images and need no image release. Expanded `.env.compose.example` with the supported values and application command.

TypeScript and all 54 unit/API tests passed. A clean-directory installation from the generated public setup archive on the existing Ubuntu amd64 host verified that custom limits and lifetimes reach the pinned controller image, a plain restart keeps the previous environment, and recreation applies new values while preserving its volume and stored synthetic fixture. Doctor passed before and after the change. Only the disposable test installation was removed. Evidence is under `output/self-host-config-check/`; native Mac and fresh-host acceptance remain separate.

## Validation still required

- The user previously verified Mac deployment, but the newly published native arm64 image still needs its own physical Mac acceptance run. Linux ARM CI is not a substitute.
- The clean-directory Ubuntu test was on the existing server; deployment on an independent fresh host remains outstanding.
- A real TransGate proof and external-node interaction remain separate from the passing synthetic Schema Validator fixture.
- Cross-version Chrome/profile/extension upgrade and rollback, and longer-duration multi-user load/recovery tests, are still outstanding.
- Google and X can require verification or reject remote-browser sign-in. Successful synthetic tests and GitHub handoff do not establish universal login compatibility.

See [Roadmap](PLAN.md) for the next milestones and [Releasing](RELEASING.md) for the evidence required by each release.
