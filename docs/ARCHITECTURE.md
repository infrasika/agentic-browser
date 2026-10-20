# Architecture

## Product boundary

Agentic Browser provides browser tools to an external Agent. It does not require a built-in LLM or payment service. The public demo exposes Streamable HTTP MCP; private deployments expose the same /mcp route with personal Bearer-token authentication. The stdio adapter remains available for existing clients. Both private transports call the same authenticated HTTP API and share the tool definitions.

A session represents a continuous task. `browser_create` allocates one environment; action, screenshot, handoff, and wait calls reuse it until close or expiry. Each session has its own Chrome process, profile directory, runtime container, and egress-proxy container.

## Components

| Component | Responsibility |
| --- | --- |
| Controller | HTTP/MCP API, identities, ownership, quotas, lifecycle, display gateway |
| Runtime | Sandboxed Chrome, Xvfb, desktop, VNC, browser automation |
| Egress proxy | Validate destinations and relay permitted HTTP(S)/WebSocket traffic |
| Web client | Dashboard, session display, reconnect, handoff and expiry controls |
| Private volume | Member records, optional saved profiles, lifecycle bookkeeping |

Only the controller mounts the Docker socket. The runtime receives only its authorized profile subdirectory, not the identity database or the whole data volume. The controller resolves the administrator-selected runtime image to a fixed image ID at startup; sessions cannot supply arbitrary images, Docker arguments, or host paths.

## Control and lifecycle

Sessions move through startup, active control, and cleanup. Agent and human control are exclusive. Handoff drains or rejects conflicting operations, disconnects automation while the human is using the browser, and revokes old display access when control returns to the Agent. A transition revision lets waiters distinguish a new handback from stale state.

A dropped display connection can reconnect while the session remains active. Expiry reminders and renewal controls respect the maximum lifetime. Restart recovery removes abandoned resources belonging to this instance; it does not replay actions or resume an old session ID. Explicitly saved profiles can be opened in a new session after cleanup finishes.

The controller uses instance labels, a resource ledger, and exclusive locking for recovery. Slots and profile locks remain held while cleanup is pending; a failed deletion must not let another session reuse a profile still mounted by a runtime.

## Team identities and profiles

Each member has their own password, human login cookie, Agent credentials, sessions, and saved profiles. Passwords use salted scrypt hashes; Agent secrets are stored as hashes. Human cookies are HttpOnly, SameSite=Strict, and Secure for HTTPS deployments.

Agent credentials expire, can be revoked independently, and contain explicit saved-profile grants. They cannot impersonate a human login or access another credential's sessions. A member can explicitly rebind their own session; the old credential's queued operations and waits lose access. Password changes or member disablement revoke existing access.

Profiles are opt-in persistent website state, owned by one member and locked to one session at a time. Public mode never saves profiles. Legacy unowned profiles are frozen until an administrator claims them for a member. Profile deletion and member administration are separate from ordinary Agent browser tools.

## Public guests and capacity

A public MCP client receives a session-specific secret, not an instance-wide token. Human access uses a short-lived, single-use ticket in a URL fragment and a guest cookie after claim. No public session/profile directory is exposed. Capacity APIs reveal totals only.

Total and per-IP limits, request size/rate limits, bounded waits, and serialized control changes protect the instance from accidental overload. Several people behind the same NAT share the source-IP limit. Proxy trust must be explicitly configured; user-provided forwarding headers are not accepted by default.

## Runtime and network isolation

Browser containers run as non-root with a read-only root filesystem, all Linux capabilities dropped, no-new-privileges, and CPU, memory, and PID limits. Chrome's namespace and seccomp sandboxes remain enabled. No privileged mode or host networking is used.

The browser has no direct external network route. Its proxy validates all resolved addresses before connecting, rejects internal/reserved targets, and permits only approved web ports. The chosen IP is used for the connection to avoid a second DNS lookup changing the destination. Direct UDP/WebRTC egress is unavailable. Administrator-configured management domains and the service's own public hostname are denied.

The synthetic test site `https://agentic-browser.invalid/demo` maps only to the intended fixture assets. It does not provide a route to the controller's administration API.

These controls separate users and their Agents. They do not hide data from the deployment administrator, guarantee resistance to every container escape, or stop a website from applying its own login checks. After human handback, the authorized Agent can read the signed-in page.

## Images and extensions

The runtime contains pinned Google Chrome plus the original signed zkPass TransGate and Schema Validator packages. A fresh profile installs the bundled packages locally; images are never made by committing a browser containing a real user's login data. Extension ID, enabled state, and version are checked during startup and acceptance tests.

Native Linux amd64 and arm64 images are published together only after both runners pass. The deployment bundle fixes their multi-platform digests. Image selection is instance-wide; arbitrary per-session images and an image marketplace are outside the current scope.

Offline tests verify extension UI, synthetic data capture, profile/storage isolation, and the handoff path. A live TransGate proof, external node connectivity, and Chrome/profile upgrades need separate acceptance. See [Runtime development](../runtime/README.md), [Releasing](RELEASING.md), and [Frozen baseline](STATUS.md).

## Deployment access modes

One Compose `.env` selects `AB_MODE=authenticated` or `public`. Authenticated mode can bootstrap the initial account from `AB_ADMIN_USERNAME` and `AB_ADMIN_PASSWORD`, only when no members exist. Existing and disabled accounts are never overwritten. The initial account has ordinary member resource scope; deployment administration remains a host responsibility. Passwords are salted and hashed; Agent tokens are stored as digests. Public mode ignores bootstrap settings and uses separate temporary identity storage.
