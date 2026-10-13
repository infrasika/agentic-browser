import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const lock = JSON.parse(readFileSync('/app/runtime/assets.lock.json', 'utf8'));
const settings = { '*': { installation_mode: 'blocked' } };
mkdirSync('/opt/google/chrome/extensions', { recursive: true });
mkdirSync('/etc/opt/chrome/policies/managed', { recursive: true });
for (const extension of lock.extensions) {
  const path = `/opt/agentic-browser/extensions/${extension.id}.crx`;
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== extension.sha256)
    throw new Error(`Extension package hash mismatch: ${extension.id}`);
  writeFileSync(`/opt/google/chrome/extensions/${extension.id}.json`, JSON.stringify({ external_crx: path, external_version: extension.version }));
  settings[extension.id] = { installation_mode: 'allowed', toolbar_pin: 'force_pinned' };
}
writeFileSync('/etc/opt/chrome/policies/managed/agentic-browser.json', JSON.stringify({ ExtensionSettings: settings }));
