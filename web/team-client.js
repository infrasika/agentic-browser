const authConfig = await (await fetch('/api/auth/config')).json();
export const authMode = authConfig.mode;
export const defaultStartUrl = authConfig.defaultStartUrl;
export const team = ['team', 'demo', 'public'].includes(authMode);
export function browserHeaders() {
  return { 'Content-Type': 'application/json', 'X-Agentic-Browser': '1' };
}
export async function requireMember() {
  if (!team) return null;
  const response = await fetch('/api/auth/me');
  if (response.status === 401) {
    location.replace(['demo', 'public'].includes(authMode) ? '/' : `/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
    throw new Error('Please sign in first.');
  }
  if (!response.ok) throw new Error('Unable to confirm your sign-in status. Refresh in a moment.');
  return response.json();
}

export async function mountAccount(api) {
  const member = await requireMember();
  if (!member) return;
  document.getElementById('legacy-auth').hidden = true;
  document.getElementById('token').required = false;
  document.getElementById('account').hidden = false;
  document.getElementById('member-name').textContent = member.username;
  document.getElementById('logout').onclick = async () => {
    await api('/api/auth/logout', 'POST', {});
    sessionStorage.removeItem('team-viewer-id');
    location.assign('/login');
  };
  const output = document.getElementById('credential-secret');
  const message = document.getElementById('credential-message');
  const copy = document.getElementById('copy-private-mcp');
  const config = document.getElementById('private-mcp-config');
  document.getElementById('private-mcp-url').textContent = `${location.origin}/mcp`;
  copy.onclick = async () => {
    if (!output.value) return;
    const value = JSON.stringify({ mcpServers: { 'agentic-browser-local': {
      type: 'http', url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${output.value}` },
    } } }, null, 2);
    try { await navigator.clipboard.writeText(value); message.textContent = 'MCP configuration copied. Keep it private; it includes your personal token.'; }
    catch { config.value = value; config.hidden = false; config.focus(); config.select(); message.textContent = 'Copy the selected configuration into your MCP client.'; }
  };
  const refresh = async () => {
    const { credentials } = await api('/api/credentials');
    const { profiles } = await api('/api/profiles');
    const select = document.getElementById('credential-profiles');
    select.replaceChildren(...profiles.map(profile => new Option(profile.name, profile.id)));
    const list = document.getElementById('credentials'); list.replaceChildren();
    for (const credential of credentials) {
      const row = document.createElement('p');
      row.append(`${credential.name} · expires ${new Date(credential.expires).toLocaleDateString("en-US")} `);
      const button = document.createElement('button'); button.className = 'quiet'; button.textContent = 'Revoke';
      button.onclick = async () => {
        try { await api(`/api/credentials/${credential.id}`, 'DELETE'); await refresh(); output.value = ''; output.hidden = true; copy.disabled = true; config.value = ''; config.hidden = true; }
        catch (error) { message.textContent = error.message; }
      };
      row.append(button); list.append(row);
    }
  };
  document.getElementById('credential-form').onsubmit = async event => {
    event.preventDefault();
    try {
      const result = await api('/api/credentials', 'POST', { name: document.getElementById('credential-name').value, profileIds: [...document.getElementById('credential-profiles').selectedOptions].map(option => option.value) });
      output.value = result.token; output.hidden = false; copy.disabled = false; config.value = ''; config.hidden = true;
      message.textContent = 'Copy the MCP configuration into your Agent, or use this token with the MCP URL below. It cannot be shown again after leaving this page. Revoke it and create another if needed.';
      await refresh();
    } catch (error) { message.textContent = error.message; }
  };
  await refresh();
}
