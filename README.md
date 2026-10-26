# Agentic Browser

A chat Agent with a private remote browser beside the conversation. The Agent opens a website, hands control to you for sign-in or confirmation, then continues in the same browser when you click Done.

**[Public demo](https://agentic-browser.zkpass.org/) · [Demo guide](docs/AGENT_DEMO.md) · [Complete Agent installation](deploy/agent/INSTALL.md) · [Development progress](docs/plans/LIBRECHAT_PROGRESS.md)**

## Try the demo

Register a local account and open a chat. The GitHub example asks you to sign in inside the remote browser, then counts and lists the private repositories owned by your account. Complete sign-in while you have control and return control to the Agent; the task resumes automatically. Keep passwords and verification codes in the remote browser.

Each user has a separate account, chat history, credits and browser session. The public service has a shared daily budget and a queue when browser capacity is full. Administrators can manage access and budget through the application. A remote browser does not inherit your laptop's website login.

The public site includes the Agent and model. You do not need an external MCP client. Its old public MCP endpoint is closed.

## Deploy the complete Agent

The self-hosting target is a versioned bundle and prebuilt images, with only Python and Docker on the host. It includes:

- LibreChat: chat, local accounts, native Agent tools, credits and a site budget.
- Browser Service: per-user sessions, queueing, live display, control handoff and Chrome lifecycle.
- Private MongoDB and Redis, plus one HTTP gateway. Only the gateway publishes a loopback port.

Configure your own Qwen model and rates once in private files. Registration is closed by default; creating local users does not require Cloudflare or OAuth. Public registration requires HTTPS and Turnstile. SMTP password recovery is optional; a server-side recovery command is available without email.

**Current status: Linux amd64 installation candidate.** Same-host Compose installation and recovery have passed; independent new-server acceptance and public Agent image publication are pending. Candidate bundles can include all six fixed images for transfer to a test server. Do not use the old MCP `install.sh` to install the complete Agent.

See [installation](deploy/agent/INSTALL.md), [operations](deploy/agent/OPERATIONS.md), and [release preparation](deploy/agent/RELEASING.md). Start with one browser and validate capacity on your own host. ARM64/macOS support from the older MCP product is not an acceptance claim for this Agent.

## Project boundaries

Two source projects remain independent:

| Project | Responsibility |
| --- | --- |
| `agentic-browser` (this repository) | Browser Service, Chrome runtime, private HTTP API and `deploy/agent/` packaging/operations |
| `librechat-agent` (separate checkout) | Customized LibreChat interface, authentication, native Agent tools and accounting |

The Agent calls Browser Service over a private authenticated interface. Browser features are native Agent tools; MCP is not part of this deployment. Browser Service alone receives the Docker socket to create isolated runtimes. Each Chrome runtime receives only its session directory; model keys and database volumes stay outside it.

The deployment administrator controls the host and stored data. The configured cloud model receives prompts and tool results. During human control, Agent browser actions and observation are suspended; after you return control the Agent can read the signed-in page.

[Architecture and scope](docs/plans/AGENT_SELF_HOSTING.md) describe the implementation and acceptance boundaries. Build and test commands are in [deploy/agent/README.md](deploy/agent/README.md). End users do not need the source checkouts or host Node.js.

## Earlier MCP releases

The v0.1.x external-agent/MCP product and its existing images remain historical releases. Their installer does not deploy LibreChat, and their accounts or saved profiles are not automatically migrated. See the [archived MCP documentation index](docs/legacy/MCP.md). Current Agent packaging uses separate commands and image names; it does not advance the older controller's `latest` tag.

## Distribution notices

Chrome and the zkPass extensions are locked in [runtime/assets.lock.json](runtime/assets.lock.json). Preserve the [third-party distribution notices](runtime/DISTRIBUTION-NOTICES.md), [Playwright license](runtime/PLAYWRIGHT-LICENSE), LibreChat MIT license and dependency licenses when distributing images. The installation bundle includes the applicable top-level notices. No website login profile or deployment secrets belong in a release.
