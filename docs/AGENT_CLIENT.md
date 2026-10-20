# MCP integration reference

For installation and the human workflow, start with [Public demo usage](PUBLIC_DEMO.md) or [Self-hosting](SELF_HOST.md). This document is for Agent authors and client integrators.

## Transport and authority

| Mode | Endpoint | Authority | Tools |
| --- | --- | --- | --- |
| Public demo | `https://agentic-browser.zkpass.org/mcp` | No registration; each created session returns a private `sessionId` / `sessionKey` pair | 9 |
| Authenticated workspace | Your origin plus `/mcp` | `Authorization: Bearer <personal-token>` on every request, plus credential-owned session IDs | 11 |

Both use Streamable HTTP MCP. A website cookie, MCP transport ID, or session ID by itself is not Agent authority. A new `browser_create` allocates one isolated environment; subsequent calls reuse it until close or expiry. List tools from the connected server to obtain the current schemas.

Public tools: `browser_create`, `browser_status`, `browser_action`, `browser_screenshot`, `browser_handoff`, `browser_human_link`, `browser_wait`, `browser_extend`, `browser_close`. Private mode also exposes authorized session/profile listings. Credentials cannot create/delete saved profiles or operate on another credential's sessions. Rebinding a member-owned session enters human control and invalidates old operations; the member then explicitly hands it back.

## Handoff contract

1. Create a session and navigate to the task page.
2. When human input is needed, call `browser_handoff`.
3. **Display its actual `humanUrl` to the current user before waiting**, both as a clickable link and as the complete URL. Keep the `#` fragment intact. Never substitute the homepage, `/connect` without its fragment, or the `sessionKey`.
4. The person opens the link, clicks **Connect and take control**, completes the step, and clicks **Hand back to Agent**.
5. Call `browser_wait`, using the handoff `revision` as `afterRevision` when available. Continue browser actions only when the result confirms Agent control.
6. Close the session with `browser_close` when finished.

`browser_handoff` and `browser_human_link` return `humanUrl`, `userMessage`, structured content, and a separate text message for clients that render tool output differently. Show `userMessage` instead of merely telling the person to click an undisplayed “Connect” link.

Public handoff links expire after 2 minutes and are single-use. If missing, expired, or already consumed, call `browser_human_link` to issue a new one. The fragment is removed after a successful claim. Treat links and session keys as secrets. Team links instead require the owning member's website login.

The Agent cannot take screenshots, read page contents, or perform browser actions during human control. After handback it can read the signed-in page. Passwords and verification codes belong in the remote browser, not in the Agent conversation. Website anti-bot and sign-in restrictions still apply.

## Capacity and waiting

Public sessions start with 5 minutes and have a maximum lifetime of 10 minutes. Renewal never exceeds that maximum. The official demo allows 5 concurrent sessions and 2 per source IP; users behind one NAT share the IP limit.

When full, `browser_create` returns MCP `isError: true` with `status: 429`, `error: session_limit` or `source_limit`, current `capacity`, `retryAfterSeconds: 30`, and an English `userMessage`. Show that message and the current count. Do not automatically loop creation or close another user's sessions. The retry interval does not reserve a slot. The MCP transport can still return HTTP 200 while the tool result contains the error.

`browser_wait` waits at most 25 seconds. `timed_out` means only this wait ended; it does not hand back control or close the browser. A canceled wait releases the request but leaves the session intact. Waiting does not renew the session. Team mode allows 2 concurrent waits per credential and 64 per instance.

## Private client requirements

The Agent token and the human's workspace login are separate. The person opening the handoff link must be signed in as the owning member. Revocation prevents new credential-authorized operations; a pending wait rechecks revocation and binding. Grant only the saved profiles intended for that credential.

Authenticated HTTP MCP is the primary connection. The optional Docker/stdio adapter remains supported for existing integrations: it uses `AGENT_BROWSER_URL`, `AGENT_BROWSER_TOKEN` and optional `AGENT_BROWSER_VIEW_URL`. A remote adapter container needs no Docker socket, server volume or host mounts. The compatibility helper `scripts/release-compose.sh mcp-remote` starts that client from the pinned controller image; new HTTP clients do not need this helper.

## HTTP errors and recovery

| Status / error | Action |
| --- | --- |
| 401 `unauthorized` | Replace an expired or revoked personal credential; do not substitute a human cookie. |
| 404 `session_not_found` | The session is absent or not authorized for this credential. |
| 409 `control_unavailable` | Stop browser actions while human control or a transition is active. |
| 410 `session_ended` | Create a new session if still needed; old links cannot revive it. |
| 429 `session_limit` / `source_limit` / `wait_limit` | Report the limit and reduce requests or retry later. |
| 503 `runtime_stopped` | Wait for cleanup before opening a new session or saved profile. |
| 504 `operation_timeout` / `runtime_timeout` | Inspect state before retrying; do not blindly resubmit a form. |

The team wait endpoint is `POST /api/sessions/<session-id>/wait`, with a personal Bearer credential and JSON such as `{"control":"agent","afterRevision":1,"timeoutMs":20000}`. It returns `ready` or `timed_out` plus session state, and rechecks credentials and session binding while waiting.

Protocol tests run with `npm test`. The containerized end-to-end flow runs in `npm run test:controller`; public flow and capacity tests run in `npm run test:public-mcp`. They use synthetic accounts, not real login credentials.
