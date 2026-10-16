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
| Bounded concurrency and failure recovery | Released in preview.4 | Five five-browser cycles locally; native amd64/arm64 release gates passed, including expiry, runtime/controller termination, member isolation and revocation |
| Fresh-host and Mac acceptance | Ubuntu passed; Mac pending | Preview.4 installer passed on fresh native Ubuntu amd64/arm64 runners; physical Mac check remains separate |
| Release upgrade and backup recovery | Passed on amd64/arm64 | Published preview.3 → preview.4, offline backup and fresh-volume rollback with synthetic member/profile data |
| Sustained synthetic load | Verifier added; acceptance pending | Separate native amd64/arm64 workflow targeting two active hours with five browsers across public and authenticated modes |
| Browser-version migration and external workloads | Planned | Chrome/extension version changes and representative third-party website workloads |
| Live zkPass proof acceptance | Planned | Real external proof flow, cancellation and failure reporting |

## Next acceptance work

1. Run `npm run test:self-host` on a physical Apple Silicon Mac. Preview.4 has passed the independent `accept-self-host.yml` workflow on fresh Ubuntu amd64/arm64 runners. Repeat that workflow whenever the public installer or accepted image pins change; record host, Docker versions, architecture, image digests, resource usage, and handoff results.
2. Extend the passing release-upgrade/backup tests to a future Chrome/extension version change. Preview.3 → preview.4 and fresh-volume rollback passed `accept-upgrade.yml` on both architectures, but those releases have identical browser assets. Test older images with their pre-upgrade backup when browser formats change; do not assume an in-place downgrade is safe.
3. Complete `accept-soak.yml` on both native architectures and retain its measured activity time, resource samples, image digests, verifier revision and cleanup result. The default `npm run test:soak` target is two active hours split between public and authenticated modes. This extends the passing bounded reliability run; synthetic workload acceptance and third-party website compatibility remain distinct.
4. Validate a live TransGate proof and Schema Validator workflow, including cancellation and unavailable external services. Keep real-account results separate from synthetic CI tests.
5. Validate the image-based remote MCP client on users' machines. The standalone installer covers server deployment; remote clients connect over HTTP MCP with a personal token.

## Scope boundaries

Do not add a built-in LLM, payment flow, shared public login profiles, arbitrary per-session Docker images, or multi-host scheduling until a concrete requirement justifies them. Website anti-bot restrictions are not a compatibility promise.

Each completed milestone needs a short entry in [Progress](PROGRESS.md) with the version/commit, test scope, evidence location, and remaining limitations. Keep logs and screenshots under `output/`; avoid duplicating them in design documents.
