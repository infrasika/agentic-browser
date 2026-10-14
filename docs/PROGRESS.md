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

The source repository is private. Both GHCR packages are public, and anonymous pulls were rechecked after restoring repository privacy. Public images do not make GitHub Release attachments public; an administrator supplies the deployment bundle.

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

## Validation still required

- The user previously verified Mac deployment, but the newly published native arm64 image still needs its own physical Mac acceptance run. Linux ARM CI is not a substitute.
- The clean-directory Ubuntu test was on the existing server; deployment on an independent fresh host remains outstanding.
- A real TransGate proof and external-node interaction remain separate from the passing synthetic Schema Validator fixture.
- Cross-version Chrome/profile/extension upgrade and rollback, and longer-duration multi-user load/recovery tests, are still outstanding.
- Google and X can require verification or reject remote-browser sign-in. Successful synthetic tests and GitHub handoff do not establish universal login compatibility.

See [Roadmap](PLAN.md) for the next milestones and [Releasing](RELEASING.md) for the evidence required by each release.
