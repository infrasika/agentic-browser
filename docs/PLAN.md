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
| Fresh-host and Mac acceptance | Next | Native arm64 release on a physical Mac; independent fresh Ubuntu host |
| Upgrade and sustained-load acceptance | Planned | Profile migration/rollback and longer-running quota/recovery checks |
| Live zkPass proof acceptance | Planned | Real external proof flow, cancellation and failure reporting |

## Next acceptance work

1. Install the same pinned release on an Apple Silicon Mac and a clean Ubuntu host. Record OS, Docker versions, architecture, image digests, resource usage, and the handoff result.
2. Exercise a saved profile across a controlled Chrome/extension upgrade and rollback with synthetic data. Document when restoring a backup is necessary.
3. Run sustained multi-user tests at the configured capacity, including disconnects, expiry, revocation, controller interruption, and failed resource cleanup. Confirm capacity recovers without cross-user access.
4. Validate a live TransGate proof and Schema Validator workflow, including cancellation and unavailable external services. Keep real-account results separate from synthetic CI tests.
5. Validate the image-based remote MCP client on users' machines. The standalone installer covers server deployment; remote clients run the published image directly without source access.

## Scope boundaries

Do not add a built-in LLM, payment flow, shared public login profiles, arbitrary per-session Docker images, or multi-host scheduling until a concrete requirement justifies them. Website anti-bot restrictions are not a compatibility promise.

Each completed milestone needs a short entry in [Progress](PROGRESS.md) with the version/commit, test scope, evidence location, and remaining limitations. Keep logs and screenshots under `output/`; avoid duplicating them in design documents.
