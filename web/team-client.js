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
    throw new Error('请先登录。');
  }
  if (!response.ok) throw new Error('无法确认登录状态，请稍后刷新。');
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
      row.append(`${credential.name} · ${new Date(credential.expires).toLocaleDateString()} 到期 `);
      const button = document.createElement('button'); button.className = 'quiet'; button.textContent = '撤销';
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
      message.textContent = '请复制到你使用的 Agent 配置中。关闭页面后不能再次查看，可撤销并重新创建。';
      await refresh();
    } catch (error) { message.textContent = error.message; }
  };
  await refresh();
}
