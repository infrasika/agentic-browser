# Use the public demo

Try Agentic Browser with your own Agent, then use a self-hosted workspace for regular work.

| Entry point | Address |
| --- | --- |
| Website and current capacity | https://agentic-browser.zkpass.org/ |
| MCP server | https://agentic-browser.zkpass.org/mcp |
| Install your own workspace | https://agentic-browser.zkpass.org/self-host |

You need an Agent client that supports Streamable HTTP MCP, internet access, and a web browser. You do **not** need an Agentic Browser account, an Agentic Browser API key, Docker, or this repository. Your Agent client may require its own account or subscription.

## 1. Connect your Agent

Choose one method. Install the server in the same client and environment where you will run the task.

### Copy the setup prompt

Open the [official website](https://agentic-browser.zkpass.org/) and click **Copy prompt**. Paste it into your Agent. Follow any client approval, configuration, or restart steps it requests. Copying the prompt alone does not install the server.

### Codex CLI

Run in your terminal:

```sh
codex mcp add agentic-browser --url https://agentic-browser.zkpass.org/mcp
codex mcp get agentic-browser
```

Start a new Codex session, or reconnect its tools. Ask it to use `agentic-browser` explicitly if other browser tools are installed.

### Claude Code

Run in your terminal:

```sh
claude mcp add --transport http --scope user agentic-browser https://agentic-browser.zkpass.org/mcp
claude mcp get agentic-browser
```

Start Claude Code and use `/mcp` to check the connection. The user scope makes the server available across your local projects. Accept any client-side tool approval prompts. These commands configure Claude Code, not the separate Claude Desktop application. See the [Claude Code MCP reference](https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server) for client-specific options.

### Other MCP clients

Add a remote HTTP server with the URL above. For clients using `mcpServers` JSON:

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

Configuration formats differ between clients. No Authorization header or OAuth sign-in is required for this public endpoint. Use `/mcp`, not `/`, `/view`, or `/connect`.

## 2. Send the demo task

Paste this into your connected Agent:

> Open GitHub in Agentic Browser and send me a link to sign in. Wait until I hand control back, then count all the private repositories I own and list their names. Check every page and close the browser when finished.

Your Agent should create one temporary browser, open GitHub, and display a clickable sign-in link. The browser runs on the demo server; your existing local GitHub login is not automatically available there.

For a test that needs no website account:

> Open https://example.com in Agentic Browser and send me a link to take control. Wait until I hand control back, then read the page title, report it, and close the browser.

## 3. Complete your part in the browser

1. Open the **complete link your Agent sends**, including everything after `#`.
2. Click **Connect and take control**. Wait for **Connected** and the remote Chrome window.
3. Click inside the remote website and type directly. Complete sign-in and any verification there. Do not enter passwords or verification codes in the Agent chat.
4. Wait until the website shows that sign-in succeeded.
5. Click **Hand back to Agent** in the control panel beside the browser.

The Agent's browser tools cannot read the page, take screenshots, or send actions while you have control. After handback, the Agent can read the signed-in page. Hand back only after you have finished the private input step.

You can use Chrome's address bar, tabs, scrolling and keyboard normally inside the remote display. Use one viewer tab per session; a second active viewer can be rejected. **Extend session** renews the lease within the total time limit. **End session** closes the browser when you want to stop.

## 4. Let the Agent finish

The Agent should resume in the same signed-in browser, apply GitHub's **Private** repository filter to your personal account, check every results page, report the count and names, and close the session.

“Repositories I own” means repositories under your personal account. It does not mean every private organization repository that you can access. A public repository count on your profile is not a substitute for reading the signed-in private list.

If the Agent conversation stopped while waiting, tell it **“I have signed in and handed control back. Continue in the same session.”** If the browser has expired, a new session and a new sign-in are necessary.

A successful test includes all six steps: create → open the handoff link → human input → handback → Agent reads the result → close. The official deployment completed this GitHub flow on 2026-10-18. That result does not guarantee every account or website will accept a remote-browser sign-in.

## Time and capacity limits

| Limit | Official demo behavior |
| --- | --- |
| Concurrent browsers | 5 across the service |
| Browsers per source IP | 2; people behind the same NAT may share this quota |
| Initial session lifetime | 5 minutes |
| Maximum session lifetime | 10 minutes from creation, including extensions |
| Handoff link | Single use; expires after 2 minutes |
| Saved website login | Unavailable in public mode |

The handoff link and the browser session have **different expiry times**. If only the link expired, ask the Agent for a fresh link to the existing session. If the session expired, a new link cannot recover it. Open links promptly; waiting in the Agent chat does not extend a session.

The homepage shows aggregate capacity and updates every 10 seconds. Starting browsers and browsers awaiting cleanup count toward the limit. A displayed free slot is not a reservation. When full, the Agent receives the current count and a suggestion to retry after 30 seconds. Wait rather than repeatedly creating browsers.

## Privacy and isolation

Each session has its own temporary Chrome profile and runtime container. A new browser is created for each **session**, not for every tool call. Calls belonging to one task reuse that session. Other visitors do not receive its credentials and cannot list its contents.

Keep the handoff link private: someone holding a valid unused link can claim that session. The Agent also receives a private session key that must stay out of user-visible messages.

Closing or expiry triggers removal of the temporary browser data. Public mode does not save a reusable login profile. Signing in to a website does not create an Agentic Browser account. Signing out locally on your laptop does not sign out the remote browser.

The deployment administrator controls the server and stored data, and your Agent can read signed-in content after handback. Isolation between visitors does not make the public host private from its operator. Use [your own installation](SELF_HOST.md) for routine or sensitive work.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Agent does not have browser tools | Check the configured `/mcp` URL, reconnect/restart the client, and approve tools if prompted. |
| Agent says “click Connect” without a link | Ask: “Show the complete browser sign-in link.” It must include the fragment after `#`. |
| “Incomplete handoff link” | Open the full link from the Agent, not a bare `/connect` address. |
| Link expired or already used | If the viewer is already open, continue there. Otherwise ask the Agent for a fresh link while the session remains active. |
| Session ended or not found | Ask the Agent to create a new browser. Temporary login state cannot be recovered. |
| All browser slots are in use | Check the count on the homepage and try later. Close your own unused session. |
| Viewer is connected in another window | Close your other viewer tab before reconnecting here. |
| Viewer stays on “Connecting” | Check connectivity and session expiry, then use **Reconnect**. Persistent WebSocket/proxy problems need the operator. |
| Google, GitHub or X rejects sign-in | Complete the site's offered verification if possible, or try another task. Browser isolation does not bypass website anti-bot restrictions. |
| Agent is still waiting after login | Click **Hand back to Agent**; logging in alone does not transfer control. Then tell the Agent to continue if its turn ended. |
| `localhost` cannot be loaded | The official demo uses the public HTTPS domain. Loopback URLs belong to a self-hosted setup and require the service or a tunnel on that machine. |

To remove the server configuration later:

```sh
codex mcp remove agentic-browser
# Or, for Claude Code:
claude mcp remove agentic-browser
```

For custom Agent integrations and error handling, see the [MCP protocol reference](AGENT_CLIENT.md). For installation, accounts, tokens and saved profiles on your own host, see [Self-hosting](SELF_HOST.md).
