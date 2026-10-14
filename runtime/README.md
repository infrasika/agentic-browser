# Browser runtime development

The runtime image contains Google Chrome, desktop/mirroring dependencies, and the original signed zkPass TransGate and Schema Validator packages. It contains no personal website state. Each fresh profile installs the bundled extensions locally without contacting the Web Store.

The release supports native Linux amd64 and arm64. Apple Silicon uses Linux arm64 through Docker Desktop; a physical Mac acceptance run is recorded separately from Linux ARM CI.

## Build and verify

```sh
npm run runtime:build
npm run test:extensions
```

The first asset fetch needs network access; subsequent builds use `output/runtime/packages/` when the hashes match. `assets.lock.json` pins Chrome 155.0.8059.79 for both architectures, TransGate 0.5.5, and Schema Validator 0.1.3. A changed upstream package fails verification. Intentionally refresh with `python3 scripts/fetch-runtime-assets.py --refresh-lock`, review the changes, and rerun acceptance. Keep verified caches because upstream endpoints may stop serving old versions.

Extension tests use fresh, offline containers with read-only filesystems and temporary data. They mount only a synthetic screenshot-output directory, never a real profile or Docker socket. Checks cover:

- Extension IDs, enabled state, versions, and actual UI screenshots.
- Chrome namespace, PID, network, seccomp, and TSYNC sandbox state.
- Synthetic cookie and extension-storage isolation between independent profiles.
- Human handoff, disconnected automation, native keyboard input, and display revocation on handback.
- The original Schema Validator extension capturing a local synthetic JSON response, reporting success, and returning control to the Agent.

Logs and screenshots are under `output/runtime/` and are not committed. These checks do not prove live TransGate proofs, external-node availability, every failure/cancel path, or cross-version profile compatibility. See [Progress](../docs/PROGRESS.md).

## Isolation and licenses

The runtime is non-root, drops all capabilities, enables no-new-privileges, and keeps Chrome's sandbox enabled. It uses neither privileged mode nor host networking. `chrome-seccomp.json` derives from Playwright's profile and permits `chroot` so Chrome can initialize its sandbox inside its own user namespace; it does not grant CAP_SYS_CHROOT to the outer process.

Per-session containers, controlled egress, image pinning, and extension readiness checks are described in [Architecture](../docs/ARCHITECTURE.md). Preserve [distribution notices](DISTRIBUTION-NOTICES.md) and [Playwright's license](PLAYWRIGHT-LICENSE) when redistributing. See [Self-hosting](../docs/SELF_HOST.md) for deployment and [Releasing](../docs/RELEASING.md) for immutable multi-platform images.
