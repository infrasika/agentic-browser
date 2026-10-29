#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import { prepare } from './prepare-librechat.mjs';
import { fetchAssets } from './fetch-runtime-assets.mjs';
import { argumentsFor, cli, digest, exists, Failure, id, json, mainModule, run, walk } from '../../deploy/agent/lib/system.mjs';
export const ROOT = path.resolve(import.meta.dirname, '../..');
function publicSourcePaths(files) {
  for (const relative of files) {
    if (relative.split('/').some(p => ['.git', 'node_modules', '.deployment', '.data', 'output'].includes(p)) || relative.startsWith('config/') && !['config/settings.example.json', 'config/secrets.env.example'].includes(relative)) throw new Failure('Private/generated path is tracked; refusing build context');
  }
  return files;
}
export function platforms(value) {
  const items = value.split(',');
  if (new Set(items).size !== items.length || items.some(p => !['linux/amd64', 'linux/arm64'].includes(p))) throw new Failure('Use linux/amd64, linux/arm64 or both, without duplicates');
  return items;
}
function readableDirectories(target) {
  for (const file of [target, ...walk(target)]) {
    const info = fs.lstatSync(file);
    if (info.isDirectory()) fs.chmodSync(file, 0o755);
    else if (info.isFile()) fs.chmodSync(file, info.mode & 0o111 ? 0o755 : 0o644);
  }
}
export async function checkout(source, target) {
  fs.mkdirSync(target);
  for (const relative of publicSourcePaths((await run(['git', 'ls-files', '-z'], { cwd: source })).split('\0').filter(Boolean))) {
    const original = path.join(source, relative), dest = path.join(target, relative);
    if (!exists(original)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.lstatSync(original).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(original), dest);
    else { fs.copyFileSync(original, dest); fs.chmodSync(dest, fs.statSync(original).mode & 0o111 ? 0o755 : 0o644); }
  }
  readableDirectories(target);
}
export async function committedCheckout(source, target, revision) {
  publicSourcePaths((await run(['git', 'ls-tree', '-r', '-z', '--name-only', revision], { cwd: source })).split('\0').filter(Boolean));
  fs.mkdirSync(target);
  const data = await run(['git', 'archive', revision], { cwd: source, binary: true, maxBuffer: 128 * 1024 * 1024 });
  await pipeline(Readable.from([data]), tar.x({ cwd: target, strict: true, preservePaths: false }));
  readableDirectories(target);
}
export async function runtimeAssets(source, context, architecture) {
  const lock = json(path.join(context, 'runtime/assets.lock.json'));
  const assets = { [`chrome-${architecture}.deb`]: lock[architecture === 'arm64' ? 'chromeArm64' : 'chrome'].sha256, ...Object.fromEntries(lock.extensions.map(e => [e.id + '.crx', e.sha256])) };
  const destination = path.join(context, 'output/runtime/packages'); fs.mkdirSync(destination, { recursive: true });
  for (const [name, expected] of Object.entries(assets)) {
    const original = path.join(source, 'output/runtime/packages', name);
    if (fs.lstatSync(original).isSymbolicLink() || await digest(original) !== expected) throw new Failure('Locked runtime asset mismatch: ' + name);
    fs.copyFileSync(original, path.join(destination, name)); fs.chmodSync(path.join(destination, name), 0o644);
  }
  return assets;
}
export async function main() {
  const { values, positionals } = argumentsFor({ run: { type: 'boolean' }, platforms: { type: 'string', default: 'linux/amd64,linux/arm64' }, builder: { type: 'string' }, tag: { type: 'string', default: 'development' }, component: { type: 'string', default: 'all' }, committed: { type: 'boolean' }, 'browser-commit': { type: 'string' } });
  if (values.help || !values.run) return console.log('Build images: --run [--committed] [--platforms linux/amd64,linux/arm64] [--tag VERSION] [--component all|agent|browser|runtime] [--builder NAME] [--browser-commit SHA]');
  if (positionals.length || !/^[a-z0-9][a-z0-9_.-]{0,60}$/.test(values.tag) || !['all', 'agent', 'browser', 'runtime'].includes(values.component)) throw new Failure('Invalid build arguments');
  if (values['browser-commit'] && (!values.committed || !/^[a-f0-9]{40}$/.test(values['browser-commit']))) throw new Failure('Commit override requires --committed and an exact SHA');
  const targets = platforms(values.platforms);
  process.umask(0o077);
  const parent = path.join(ROOT, 'output/build'); fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, 'build-')), builder = values.builder ?? 'agent-build-' + id().slice(0, 10), reports = {};
  let created = false;
  try {
    const revision = await run(['git', 'rev-parse', '--verify', (values['browser-commit'] ?? 'HEAD') + '^{commit}'], { cwd: ROOT });
    const sources = { browser: path.join(work, 'source-browser'), librechat: path.join(work, 'source-librechat') };
    if (values.committed) await committedCheckout(ROOT, sources.browser, revision); else await checkout(ROOT, sources.browser);
    const lock = await prepare(sources.browser, sources.librechat);
    if (!values.builder) { await run(['docker', 'buildx', 'create', '--name', builder, '--driver', 'docker-container', '--driver-opt', 'memory=5g,cpu-period=100000,cpu-quota=200000']); created = true; }
    for (const target of targets) {
      const architecture = target.split('/')[1], directory = path.join(work, architecture); fs.mkdirSync(directory);
      const report = { published: false, images: {}, platform: target, sourceCommits: { browser: revision, librechat: lock.commit }, librechatTree: lock.tree, runtimeAssets: {}, sourceMode: values.committed ? 'committed' : 'working-tree' };
      reports[target] = path.join(directory, 'report.json');
      try {
        for (const component of ['agent', 'browser', 'runtime']) {
          if (!['all', component].includes(values.component)) continue;
          const context = path.join(directory, component), source = sources[component === 'agent' ? 'librechat' : 'browser'];
          fs.cpSync(source, context, { recursive: true, filter: file => path.basename(file) !== '.git', dereference: false });
          if (component === 'agent') fs.cpSync(path.join(sources.browser, 'deploy/agent/app'), path.join(context, 'selfhost'), { recursive: true });
          fs.copyFileSync(path.join(sources.browser, component === 'runtime' ? 'runtime/Dockerfile' : `deploy/agent/${component}.Dockerfile`), path.join(context, 'Dockerfile.agent'));
          if (component === 'runtime') { await fetchAssets({ source: sources.browser, arch: architecture }); report.runtimeAssets = await runtimeAssets(ROOT, context, architecture); }
          fs.writeFileSync(path.join(context, '.dockerignore'), '.git\nnode_modules\n.deployment\n.data\n.env\n.env.*\n' + (component === 'runtime' ? '' : 'output\n'));
          const image = `agentic-browser-${component === 'browser' ? 'service' : component}:${values.tag}-${architecture}`;
          const logfile = path.join(directory, component + '.log'); console.log(`Building ${component} for ${target}; log: ${logfile}`);
          const fd = fs.openSync(logfile, 'w', 0o600);
          try {
            // Keep BuildKit's output in the private log, including stderr.
            await buildCommand(['docker', 'buildx', 'build', '--builder', builder, '--platform', target, '--load', '--provenance=false', '--progress', 'plain', '--file', path.join(context, 'Dockerfile.agent'), '--tag', image,
              '--label', 'org.opencontainers.image.source=https://github.com/infrasika/agentic-browser', '--label', 'org.opencontainers.image.revision=' + revision, '--label', 'dev.agentic-browser.librechat-revision=' + lock.commit, '--label', 'dev.agentic-browser.librechat-tree=' + lock.tree,
              '--build-arg', 'AB_REVISION=' + revision, '--build-arg', 'AB_VERSION=' + values.tag, context], fd);
          } finally { fs.closeSync(fd); }
          const info = JSON.parse(await run(['docker', 'image', 'inspect', image]))[0];
          if (info.Os + '/' + info.Architecture !== target) throw new Failure('Built platform mismatch');
          report.images[component] = { tag: image, id: info.Id }; fs.rmSync(context, { recursive: true, force: true });
        }
        report.passed = true;
      } finally { fs.writeFileSync(reports[target], JSON.stringify(report, null, 2) + '\n'); }
    }
    for (const source of Object.values(sources)) fs.rmSync(source, { recursive: true, force: true });
  } finally {
    if (created) await run(['docker', 'buildx', 'rm', builder]).catch(() => {});
    fs.writeFileSync(path.join(work, 'reports.json'), JSON.stringify(reports, null, 2) + '\n'); console.log(JSON.stringify({ directory: work, reports }));
  }
}
async function buildCommand(args, fd) {
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: ROOT, stdio: ['ignore', fd, fd] });
    const stop = signal => child.kill(signal);
    const interrupt = () => stop('SIGTERM'); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    child.on('error', () => reject(new Failure('Build command unavailable')));
    child.on('close', code => { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); code === 0 ? resolve() : reject(new Failure('Build failed; inspect the private component log')); });
  });
}
if (mainModule('build-agent-images.mjs')) cli(main);
