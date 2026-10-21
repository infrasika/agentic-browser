import { requestJson } from "/request.js";
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
    ? 'Incomplete handoff link. Copy the full URL from your Agent, including everything after #, or ask it for a new link.'
    : location.hash === rejectedLink
      ? 'This link has been used or has expired. Ask your Agent for a new link.'
      : 'Link ready. Click “Connect and take control”.';
}
window.addEventListener('hashchange', showLink);
showLink();
button.onclick = async () => {
  const match = readLink();
  if (connecting || !match || location.hash === rejectedLink) return;
  const claimingLink = location.hash;
  connecting = true;
  button.disabled = true;
  message.textContent = 'Connecting to the browser…';
  try {
    const result = await requestJson('/api/public/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agentic-Browser': '1' }, body: JSON.stringify({ sessionId: match[1], ticket: match[2] }) });
    try { sessionStorage.removeItem('viewer-session'); sessionStorage.removeItem('team-viewer-id'); } catch { /* Storage may be disabled. */ }
    // Replace this history entry only after receiving the scoped human cookie.
    location.replace(result.humanUrl);
  } catch (error) {
    if (error.status === 410) rejectedLink = claimingLink;
    connecting = false;
    showLink();
    if (location.hash === claimingLink && claimingLink !== rejectedLink)
      message.textContent = `${error.message} Please retry. If the link has been used or has expired, ask your Agent for a new one.`;
  }
};
