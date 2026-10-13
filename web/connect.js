const button = document.getElementById('connect-browser');
const message = document.getElementById('connect-message');
const readLink = () => /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(location.hash.slice(1));
let connecting = false;
let rejectedLink;
// Preserve the fragment until the user claims the session. Removing it on
// load breaks refresh and reloads before the user can click Connect. Fragments
// are not sent to the server; no ticket is copied to browser storage.
document.getElementById('transport-warning').hidden = location.protocol === 'https:';
function showLink() {
  if (connecting) return;
  const valid = !!readLink();
  button.disabled = !valid || location.hash === rejectedLink;
  message.textContent = !valid
    ? '接管链接不完整，请从 Agent 复制完整地址（包括 # 后的内容）；也可以让 Agent 使用 browser_human_link 获取新链接。'
    : location.hash === rejectedLink
      ? '此链接已使用或过期，请让 Agent 使用 browser_human_link 获取新链接。'
      : '链接已就绪，请点击“连接并接管”。';
}
window.addEventListener('hashchange', showLink);
showLink();
button.onclick = async () => {
  const match = readLink();
  if (connecting || !match || location.hash === rejectedLink) return;
  const claimingLink = location.hash;
  connecting = true;
  button.disabled = true;
  message.textContent = '正在连接浏览器…';
  try {
    const response = await fetch('/api/public/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agentic-Browser': '1' }, body: JSON.stringify({ sessionId: match[1], ticket: match[2] }) });
    const result = await response.json();
    if (response.status === 410) rejectedLink = claimingLink;
    if (!response.ok) throw new Error(result.message || '无法连接，请获取新链接。');
    try { sessionStorage.removeItem('viewer-session'); sessionStorage.removeItem('team-viewer-id'); } catch { /* Storage may be disabled. */ }
    // Replace this history entry only after receiving the scoped human cookie.
    location.replace(result.humanUrl);
  } catch (error) {
    connecting = false;
    showLink();
    if (location.hash === claimingLink && claimingLink !== rejectedLink)
      message.textContent = `${error.message} 请重试；若链接已使用或过期，请让 Agent 获取新链接。`;
  }
};
