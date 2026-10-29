#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { argumentsFor, cli, digest, exists, Failure, json, mainModule, run, sha } from '../../deploy/agent/lib/system.mjs';
export const ROOT = path.resolve(import.meta.dirname, '../..');

export async function prepare(source, target) {
  const integration = path.join(source, 'integrations/librechat');
  const lock = json(path.join(integration, 'source.lock.json')), patch = path.join(integration, 'customizations.patch');
  if (lock.format !== 1 || lock.repository !== 'https://github.com/LibreChat-AI/LibreChat.git') throw new Failure('Unsupported LibreChat source lock');
  if (['commit', 'tree'].some(k => !/^[a-f0-9]{40}$/.test(lock[k]))) throw new Failure('Exact LibreChat commit and tree required');
  if (await digest(patch) !== lock.patchSha256) throw new Failure('LibreChat patch checksum mismatch');
  if (exists(target)) throw new Failure('LibreChat output already exists; choose a new directory');
  fs.mkdirSync(target, { recursive: true });
  const git = (...args) => run(['git', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null', '-C', target, ...args], { timeout: 300_000 });
  await git('init', '-q'); await git('remote', 'add', 'origin', lock.repository);
  await git('fetch', '--depth=1', 'origin', lock.commit); await git('checkout', '--detach', '-q', 'FETCH_HEAD');
  await git('apply', '--index', '--whitespace=error', path.resolve(patch));
  if (await git('write-tree') !== lock.tree) throw new Failure('Customized LibreChat source tree mismatch');
  if (!fs.readFileSync(path.join(target, 'LICENSE')).equals(fs.readFileSync(path.join(integration, 'LICENSE')))) throw new Failure('LibreChat license mismatch');
  for (const name of ['actions', 'protocol']) {
    const checksum = sha(fs.readFileSync(path.join(source, `src/api/${name}.ts`)));
    if (!fs.readFileSync(path.join(target, `packages/data-provider/src/browser/${name}.ts`), 'utf8').split('\n')[0].includes('source SHA256 ' + checksum + '.')) throw new Failure('Browser contract changed; update LibreChat integration: ' + name);
  }
  return lock;
}
export async function main() {
  const { values, positionals } = argumentsFor({ output: { type: 'string', default: path.join(ROOT, 'output/sources/librechat') } });
  if (values.help) return console.log('Prepare pinned LibreChat source: --output NEW_DIRECTORY');
  if (positionals.length) throw new Failure('Unexpected positional argument');
  const directory = path.resolve(values.output), lock = await prepare(ROOT, directory);
  console.log(JSON.stringify({ directory, ...lock }));
}
if (mainModule('prepare-librechat.mjs')) cli(main);
