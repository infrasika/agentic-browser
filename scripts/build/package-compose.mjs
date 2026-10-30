#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const root = path.resolve(import.meta.dirname, '../..');
export function composeFiles(release, { source = root, development = false } = {}) {
  const names = ['agent', 'browser', 'runtime', 'gateway', 'mongo', 'redis'];
  if (Object.keys(release.images ?? {}).sort().join() !== names.sort().join()) throw new Error('Six release images required');
  let template = fs.readFileSync(path.join(source, 'deploy/compose/compose.template.yaml'), 'utf8');
  const version = release.version ?? 'development';
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(version)) throw new Error('Invalid release version');
  template = template.replaceAll('@@VERSION@@', version);
  for (const [name, ref] of Object.entries(release.images)) {
    if (typeof ref !== 'string' || !(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(ref) || development && /^[a-zA-Z0-9./:_-]+$/.test(ref))) throw new Error('Immutable release images required');
    template = template.replaceAll('@@' + name.toUpperCase() + '_IMAGE@@', ref);
  }
  if (template.includes('@@')) throw new Error('Unresolved Compose image');
  return {
    'compose.yaml': template,
    'settings.json': fs.readFileSync(path.join(source, 'config/settings.example.json'), 'utf8'),
    'secrets.env': fs.readFileSync(path.join(source, 'deploy/compose/secrets.env.example'), 'utf8'),
    'COMPOSE.md': fs.readFileSync(path.join(source, 'docs/COMPOSE.md'), 'utf8'),
    'LICENSE': fs.readFileSync(path.join(source, 'LICENSE'), 'utf8'),
  };
}
export function writeCompose(release, output, options) {
  const files = composeFiles(release, options);
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(output, name), data, { flag: 'wx', mode: name === 'secrets.env' ? 0o600 : 0o644 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { release: { type: 'string' }, output: { type: 'string' }, development: { type: 'boolean' } } });
    if (!values.release || !values.output) throw new Error('Use --release release.json --output NEW_DIRECTORY [--development for local images]');
    writeCompose(JSON.parse(fs.readFileSync(values.release, 'utf8')), path.resolve(values.output), { development: values.development });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
