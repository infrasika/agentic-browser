# Agent clients

## Public demo: remote HTTP MCP

- Website: **https://agentic-browser.zkpass.org/**
- MCP endpoint: **https://agentic-browser.zkpass.org/mcp**
- No Agentic Browser registration, API key, or local adapter is needed.

```json
{
  "mcpServers": {
    "agentic-browser": {
      "type": "http",
      "url": "https://agentic-browser.zkpass.org/mcp"
    }
  }
}
```

For Codex CLI:

```sh
codex mcp add agentic-browser --url https://agentic-browser.zkpass.org/mcp
```

For Claude Code:

```sh
claude mcp add --transport http --scope user agentic-browser https://agentic-browser.zkpass.org/mcp
claude mcp get agentic-browser
```

Use `/mcp` inside Claude Code to inspect the connection. Refresh tools or restart the client if needed. Client configuration formats can differ; the homepage's **Copy prompt** includes the endpoint and setup guidance. Codex and Claude Code public flows have been manually verified.

Try this task:

> Open GitHub in Agentic Browser and send me a link to sign in. Wait until I hand control back, then count all the private repositories I own and list their names. Check every page and close the browser when finished.

Each `browser_create` starts one separate temporary environment and returns a `sessionId` and `sessionKey`. Subsequent calls reuse that session and require both values; a new environment is not created for every tool call. Public mode provides 9 tools and no account-wide session or saved-profile listing.

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

## Private deployment: personal credentials

A team administrator creates your member account. Sign in to the workspace and create a personal Agent credential. It allows temporary sessions by default; grant specific saved profiles only when you want the Agent to reuse them. Do not share a credential between members.

The [public setup download](https://agentic-browser.zkpass.org/self-host) includes the helper used below. All application commands run inside the published controller image. Neither option requires a source checkout, host Node.js, or npm dependencies.

### Agent on the deployment machine

With the controller running, use the setup helper to launch the MCP client inside it. Run `pwd` in the extracted setup directory and replace `/ABSOLUTE/PATH/agentic-browser` with that path:

```json
{
  "mcpServers": {
    "agentic-browser": {
      "command": "bash",
      "args": ["/ABSOLUTE/PATH/agentic-browser/scripts/release-compose.sh", "mcp"],
      "env": {
        "AGENT_BROWSER_URL": "http://127.0.0.1:3333",
        "AGENT_BROWSER_TOKEN": "REPLACE_WITH_YOUR_PERSONAL_AGENT_CREDENTIAL",
        "AGENT_BROWSER_VIEW_URL": "http://127.0.0.1:3333"
      }
    }
  }
}
```

The helper uses the project name in `.env.compose` and keeps MCP's stdio stream free of terminal formatting. For the default loopback setup, the API URL points to internal port 3333 inside the controller. If `AB_PUBLIC_URL` uses a public domain, set both URL values to that origin and ensure it is reachable from the controller; a loopback API address would be rejected by host validation. Set the view URL to the address reachable from your own browser, including a changed host port. This option assumes the Agent already has access to your local Docker engine.

### Agent on another machine

Remote team members need only their own Docker installation, the downloaded setup files, their private service's address, and their personal credential. They do not need source access or permissions on the server's Docker engine.

On the Agent's machine, extract the setup archive and pull only the controller image, which also contains the MCP client:

```sh
bash scripts/release-compose.sh pull-client
```

Do not run `up` or create a local member for this client-only setup. Use the helper's `mcp-remote` command:

```json
{
  "mcpServers": {
    "agentic-browser": {
      "command": "bash",
      "args": ["/ABSOLUTE/PATH/agentic-browser/scripts/release-compose.sh", "mcp-remote"],
      "env": {
        "AGENT_BROWSER_URL": "https://YOUR_PRIVATE_BROWSER_DOMAIN",
        "AGENT_BROWSER_TOKEN": "REPLACE_WITH_YOUR_PERSONAL_AGENT_CREDENTIAL",
        "AGENT_BROWSER_VIEW_URL": "https://YOUR_PRIVATE_BROWSER_DOMAIN"
      }
    }
  }
}
```

The helper starts a temporary client container from the pinned controller image, with no Docker socket, host directories, or private data volumes mounted. It connects to the existing service over HTTPS and is removed when the MCP client disconnects. Pulling the image before connecting avoids a first-connection timeout.

The remote-client example requires a service address reachable from the client container and matching the configured public origin. SSH forwarding for opening the website is covered in [Self-hosting](SELF_HOST.md); it does not automatically make a host loopback tunnel available to this client container.

`AGENT_BROWSER_VIEW_URL` only rewrites human links; it does not create an SSH tunnel. Both URL settings accept HTTP(S) origins, not paths or embedded credentials. Private deployments currently use this stdio client with personal credentials; the public demo's account-free HTTP `/mcp` endpoint is a separate mode.

Team mode exposes 11 tools, including authorized session and profile listings. A credential cannot read other credentials' sessions or create/delete saved profiles. Rebinding a member-owned session to another credential enters human control and invalidates old queued operations; the member then explicitly hands control back.

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
