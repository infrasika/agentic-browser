# Roadmap

## Product direction

Provide browser tools for external Agents, with reliable human handoff. The public website demonstrates the flow; everyday work belongs on a user's or team's self-hosted instance. Keep the source repository private and distribute public, versioned container images.

The first supported deployment targets are Ubuntu amd64/arm64 and Docker Desktop on Apple Silicon. Images include Chrome, zkPass TransGate, and zkPass Schema Validator. Each session receives a separate runtime; saved profiles are an explicit team-member choice.

## Milestones

| Milestone | Status | Acceptance |
| --- | --- | --- |
| Agent actions and human handoff | Complete | Create, operate, handoff, handback, wait, close |
| Session stability | Complete for current scope | Expiry, bounded renewal, reconnect, cleanup, saved-profile reopening |
| Private team isolation | Complete for current scope | Separate members/credentials/profiles, revocation and binding checks |
| Public MCP demo | Complete | Codex and Claude Code flows, links, quotas and capacity feedback |
| Multi-platform image delivery | Released preview | Native amd64/arm64 CI, pinned public images, anonymous pulls |
| English product and documentation | Complete | All first-party UI/messages/docs in English; consolidated guides |
| Public self-hosting setup files | Complete | Standalone installer, native Compose commands, fixed public images, no repository access required |
| Unified setup and authenticated HTTP MCP | Released in preview.3 | One .env, first-start account, URL-plus-token MCP, preserved member isolation |
| Published Docker MCP client | Passed on amd64/arm64 | Separate client containers, reconnect, handoff, credential/profile scope, revocation and cleanup |
| Bounded concurrency and failure recovery | Released in preview.4 | Five five-browser cycles locally; native amd64/arm64 release gates passed, including expiry, runtime/controller termination, member isolation and revocation |
| Fresh-host and Mac acceptance | Ubuntu passed; Mac pending | Preview.4 installer passed on fresh native Ubuntu amd64/arm64 runners; physical Mac check remains separate |
| Release upgrade and backup recovery | Passed on amd64/arm64 | Published preview.3 → preview.4, offline backup and fresh-volume rollback with synthetic member/profile data |
| Sustained synthetic load | Passed on amd64/arm64 | Two active hours per architecture: 30 public and 30 authenticated five-browser cycles, recovery checks and complete cleanup |
| Native streaming and external workloads | Passed on amd64/arm64 | 15 measured minutes of visible pixels/input, recovery, three public website flows and native handoff |
| HTTPS reverse-proxy acceptance | In progress | Certificate validation, authenticated HTTP MCP, secure cookies and native handoff over WSS |
| Browser-version migration | Planned | A future Chrome version change with saved profiles and backup-based recovery |
| zkPass-specific acceptance | Skipped by request | Bundled extensions remain available; live proof testing is outside the current acceptance scope |

## Next acceptance work

1. Run `npm run test:self-host` on a physical Apple Silicon Mac. Preview.4 has passed the independent `accept-self-host.yml` workflow on fresh Ubuntu amd64/arm64 runners. Repeat that workflow whenever the public installer or accepted image pins change; record host, Docker versions, architecture, image digests, resource usage, and handoff results.
2. Extend the passing release-upgrade/backup tests when a future Chrome version change is proposed. Preview.3 → preview.4 and fresh-volume rollback passed `accept-upgrade.yml` on both architectures, but those releases have identical browser assets. Test older images with their pre-upgrade backup when browser formats change; do not assume an in-place downgrade is safe.
3. Repeat `accept-experience.yml` and `accept-soak.yml` when accepted images or relevant behavior change. Preview.4 passed 15 minutes of native desktop streaming and three public website flows on both architectures, alongside the separate two-hour synthetic workload. Extend compatibility coverage only for concrete website requirements; keep login restrictions and longer-term resource trends separate from these bounded results.
4. Verify authenticated HTTP MCP and native handoff through the documented Nginx HTTPS proxy. Exercise certificate verification, secure cookies, reconnects and access checks on a disposable installation. Keep real DNS, cross-host firewall and physical Mac results separate from local proxy acceptance.
5. Repeat the passing `accept-remote-client.yml` workflow when the published adapter changes; record physical Mac/client-machine and cross-host TLS checks separately. The optional image-based stdio adapter receives no server mounts or Docker socket. Authenticated HTTP MCP is the primary private connection and requires no Docker on the Agent machine.

## Scope boundaries

Do not add a built-in LLM, payment flow, shared public login profiles, arbitrary per-session Docker images, or multi-host scheduling until a concrete requirement justifies them. Website anti-bot restrictions are not a compatibility promise. Per the 2026-10-18 decision, skip further zkPass-specific tests; no demo URL or app/schema identifiers are required to continue. This does not remove the bundled extensions or invalidate previously recorded checks.

Each completed milestone needs a short entry in [Progress](PROGRESS.md) with the version/commit, test scope, evidence location, and remaining limitations. Keep logs and screenshots under `output/`; avoid duplicating them in design documents.
