try {
  const response = await fetch('/api/version', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error();
  const { version, revision } = await response.json();
  for (const element of document.querySelectorAll('[data-service-version]'))
    element.textContent = `Controller ${version} · ${revision.slice(0, 12)}`;
} catch {
  for (const element of document.querySelectorAll('[data-service-version]'))
    element.textContent = 'Version unavailable. Check the service connection.';
}
