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
        try { await api(`/api/credentials/${credential.id}`, 'DELETE'); await refresh(); output.value = ''; output.hidden = true; }
        catch (error) { message.textContent = error.message; }
      };
      row.append(button); list.append(row);
    }
  };
  document.getElementById('credential-form').onsubmit = async event => {
    event.preventDefault();
    try {
      const result = await api('/api/credentials', 'POST', { name: document.getElementById('credential-name').value, profileIds: [...document.getElementById('credential-profiles').selectedOptions].map(option => option.value) });
      output.value = result.token; output.hidden = false;
      message.textContent = 'Copy this credential into your Agent configuration. It cannot be shown again after leaving this page. Revoke it and create another if needed.';
      await refresh();
    } catch (error) { message.textContent = error.message; }
  };
  await refresh();
}
