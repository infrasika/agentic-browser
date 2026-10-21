// Shared user-facing errors. Do not display HTML proxy responses or raw exceptions.
export function responseError(status, body = {}) {
  let message = body.message || 'The request failed. Try again.';
  if (status === 401) message = 'Your sign-in or access token is missing, expired or revoked. Sign in again; for your Agent, create or configure a valid personal token.';
  else if (['session_not_found', 'session_expired', 'session_closed'].includes(body.error) || status === 410)
    message = 'This session or handoff link has ended or expired. Ask your Agent for a fresh link; if the session ended, start a new browser.';
  else if (body.error === 'browser_operation_failed')
    message = 'The browser could not complete this action. Check the remote page and retry. If startup keeps failing, check Workspace status and run doctor. A website rejecting sign-in must be resolved through that website.';
  else if (status >= 500 && !body.message)
    message = 'The service is unavailable. Check that the controller is running and that its port or HTTPS proxy is reachable, then retry.';
  return Object.assign(new Error(message), { status, code: body.error });
}
export async function requestJson(path, options = {}) {
  let response;
  try { response = await fetch(path, { signal: AbortSignal.timeout(30000), ...options }); }
  catch { throw new Error('Cannot reach the service. Check your connection, the running controller and any SSH tunnel, then retry. An unconfirmed action may already have completed; check the session before repeating it.'); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw responseError(response.status, body || {});
  if (body === null) throw new Error('The server returned an unexpected response. Check the service URL and HTTPS proxy.');
  return body;
}
