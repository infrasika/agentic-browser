const isHttps = location.protocol === 'https:';
document.getElementById('transport-warning').hidden = isHttps;
document.getElementById('github-task').hidden = !isHttps;

let capacityLoading = false;
async function refreshCapacity() {
  if (capacityLoading || document.hidden) return;
  capacityLoading = true;
  const status = document.getElementById('capacity-status');
  try {
    const response = await fetch('/api/public/capacity', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Capacity unavailable');
    const capacity = await response.json();
    status.textContent = `Active sessions: ${capacity.currentSessions} / ${capacity.maxSessions}. ${capacity.full
      ? 'All browser slots are in use. Please try again later (suggested wait: 30 seconds).'
      : `${capacity.availableSessions} browser ${capacity.availableSessions === 1 ? "slot" : "slots"} available.`}`;
  } catch {
    status.textContent = 'Session counts are temporarily unavailable. Retrying automatically. Your Agent will receive the current capacity when creating a browser.';
  } finally { capacityLoading = false; }
}
void refreshCapacity();
setInterval(() => { void refreshCapacity(); }, 10000);
document.addEventListener('visibilitychange', () => { void refreshCapacity(); });

function enableCopy(buttonId, sourceId, statusId, successMessage) {
  const button = document.getElementById(buttonId);
  const source = document.getElementById(sourceId);
  const status = document.getElementById(statusId);
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(source.textContent);
      status.textContent = successMessage;
    } catch {
      const preview = source.closest('details');
      if (preview) preview.open = true;
      source.focus();
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Automatic copying was blocked. The text is selected; press ⌘C / Ctrl+C to copy.';
    }
  };
  button.disabled = false;
}

try {
  const response = await fetch('/api/auth/config');
  if (!response.ok) throw new Error('Configuration unavailable');
  const config = await response.json();
  const mcpUrl = new URL(config.mcpUrl);
  if (!['https:', 'http:'].includes(mcpUrl.protocol)) throw new Error('Invalid MCP URL');
  const content = JSON.stringify({ mcpServers: { 'agentic-browser': { type: 'http', url: mcpUrl.href } } }, null, 2);
  const claudeCommand = `claude mcp add --transport http --scope user agentic-browser ${mcpUrl.href}`;
  const task = isHttps && mcpUrl.protocol === 'https:'
    ? document.getElementById('github-prompt').textContent
    : 'Use agentic-browser to open https://example.com and hand the browser to me. After I return control, read the page title and close the session. This service uses HTTP; use public pages and fictional data only.';
  document.getElementById('mcp-config').textContent = content;
  document.getElementById('codex-command').textContent = `codex mcp add agentic-browser --url ${mcpUrl.href}`;
  document.getElementById('claude-command').textContent = claudeCommand;
  document.getElementById('install-prompt').textContent = `Help me install and connect the Agentic Browser MCP server in this Agent client, then try a remote browser task with human handoff.

Server name: agentic-browser
Server URL: ${mcpUrl.href}
Transport: Streamable HTTP
This public demo requires no Agentic Browser account or API key. There is no browser or server to install locally.

Check how this client configures MCP servers and add this remote server while preserving existing settings. If a server with the same name already exists, check its URL before changing it. Adapt this generic JSON to the format supported by the current client:
${content}

For Claude Code, run this command in my local terminal. User scope makes it available across my projects:
${claudeCommand}
Then check the connection with claude mcp get agentic-browser and inspect the tools with /mcp inside Claude Code.

If you cannot edit the configuration directly, provide exact steps for this client. Explain any required approval, tool refresh, or restart, and wait until the connection is ready.

Verify that you can discover and call the tools before saying setup is complete. Then perform this task:
${task}

After browser_handoff, send its userMessage in this conversation, including the clickable humanUrl and the full raw URL with everything after #. Only then call browser_wait. Do not say “click Connect” without providing the actual link. If it is missing or expired, call browser_human_link for a new one; do not guess a URL.

If browser creation reports full capacity or a limit for this network, show the returned userMessage and current session count/limit. Ask me to try again later. Do not loop over creation attempts or close other sessions.

I will enter accounts, passwords, and verification codes in the remote browser. Do not request them in chat. Show handoff links only to me in this conversation; never publish or forward them. Use sessionKey only for tool calls and do not display it. Wait for me to return control before reading the page. Public sessions start with 5 minutes and last at most 10 minutes. Close the session when the task is complete.`;
  enableCopy('copy-prompt', 'install-prompt', 'prompt-status', 'Prompt copied. Paste it into your Agent to begin.');
  enableCopy('copy-config', 'mcp-config', 'copy-status', 'Configuration copied.');
  enableCopy('copy-claude', 'claude-command', 'claude-status', 'Claude Code command copied. Run it in your local terminal.');
} catch {
  document.getElementById('prompt-status').textContent = 'Unable to load the connection settings. Refresh the page to try again.';
}
