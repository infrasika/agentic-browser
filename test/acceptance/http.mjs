export function generationPending(route, response, body) {
  if (!/^\/api\/agents\/chat\/status\/[^/?]+$/.test(route) || response.status !== 503 || response.headers.has('x-agent-maintenance') || response.headers.get('retry-after') !== '1') return false;
  try { return JSON.parse(body).code === 'SERVER_NOT_READY'; } catch { return false; }
}
