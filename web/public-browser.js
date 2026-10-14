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
  document.getElementById('install-prompt').textContent = `Help me connect this Agent to Agentic Browser, then try a browser task together.

Connection: ${mcpUrl.href} (remote MCP server, named agentic-browser).
Keep my existing connections. No Agentic Browser account or API key is needed. If setup needs my help or a restart, guide me through it and confirm the connection works before starting.

Once connected:
${task}

I will enter my password and any verification codes directly in the browser, not in this chat. If the browser link stops working, send me a new one. If all browsers are busy, tell me how many are in use and ask me to try again later.`;
  enableCopy('copy-task', 'github-prompt', 'task-status', 'Task copied. Paste it into your connected Agent.');
  enableCopy('copy-prompt', 'install-prompt', 'prompt-status', 'Prompt copied. Paste it into your Agent to begin.');
  enableCopy('copy-config', 'mcp-config', 'copy-status', 'Configuration copied.');
  enableCopy('copy-claude', 'claude-command', 'claude-status', 'Claude Code command copied. Run it in your local terminal.');
} catch {
  document.getElementById('prompt-status').textContent = 'Unable to load the connection settings. Refresh the page to try again.';
}
