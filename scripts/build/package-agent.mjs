#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { bundleTools } from './bundle-tools.mjs';
import { committedCheckout } from './build-agent-images.mjs';
import { argumentsFor, cli, digest, exists, Failure, json, mainModule, run, same, walk } from '../../deploy/agent/lib/system.mjs';
export const ROOT = path.resolve(import.meta.dirname, '../..');
export const INFRA = {
  gateway: 'nginx@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951',
  mongo: 'mongo:8.0@sha256:4a4ab5d4834207389e0d7270fac988e21ffedccecba77991a552f755df229907',
  redis: 'redis:7.4-alpine@sha256:57e4255cc971b1c8d6f8a6ca283ac01bc3ecdd914273ef6bfaede87aaecd6541',
};
export const FILES = {
  'compose.yaml': 'deploy/agent/compose.yaml', 'nginx.host.conf': 'deploy/agent/nginx.host.conf',
  'README.md': 'deploy/agent/INSTALL.md', 'CONFIGURATION.md': 'deploy/agent/CONFIGURATION.md', 'OPERATIONS.md': 'deploy/agent/OPERATIONS.md',
  'acceptance/model-fixture.mjs': 'test/acceptance/fixtures/model-fixture.mjs',
  'LICENSES/DISTRIBUTION-NOTICES.md': 'runtime/DISTRIBUTION-NOTICES.md', 'LICENSES/PLAYWRIGHT-LICENSE': 'runtime/PLAYWRIGHT-LICENSE', 'LICENSES/LibreChat.txt': 'integrations/librechat/LICENSE',
};
export const gitBytes = (repo, revision, file) => run(['git', 'show', revision + ':' + file], { cwd: repo, binary: true });
export function validateReport(report) {
  if (report.passed !== true || report.sourceMode !== 'committed') throw new Failure('a completed build from committed sources is required');
  if (Object.keys(report.images ?? {}).sort().join(',') !== 'agent,browser,runtime') throw new Failure('a complete three-image build is required');
  if (!['linux/amd64', 'linux/arm64'].includes(report.platform)) throw new Failure('explicit supported build platform required');
  if (!/^[a-f0-9]{40}$/.test(report.librechatTree)) throw new Failure('verified LibreChat source tree required');
  if (!report.sourceCommits?.browser || !report.sourceCommits?.librechat || Object.values(report.sourceCommits).some(v => !/^[a-f0-9]{40}$/.test(v))) throw new Failure('invalid source revision');
  if (Object.values(report.images).some(i => !/^sha256:[a-f0-9]{64}$/.test(i.id))) throw new Failure('invalid image identity');
}
export async function validateImageSources(sourceCommit, packageCommit) {
  const paths = ['deploy/agent/app', 'deploy/agent/agent.Dockerfile', 'deploy/agent/browser.Dockerfile', 'src', 'runtime', 'integrations/librechat/source.lock.json', 'integrations/librechat/customizations.patch', 'integrations/librechat/LICENSE', 'package-lock.json', 'tsconfig.json'];
  if (await run(['git', 'diff', '--name-only', sourceCommit, packageCommit, '--', ...paths], { cwd: ROOT })) throw new Failure('application/image inputs changed since the recorded build; rebuild first');
  const before = JSON.parse(await gitBytes(ROOT, sourceCommit, 'package.json')), after = JSON.parse(await gitBytes(ROOT, packageCommit, 'package.json'));
  delete before.scripts; delete after.scripts;
  if (!same(before, after)) throw new Failure('application package manifest changed; rebuild first');
}
export async function platformReference(ref, platform, command = run) {
  const index = JSON.parse(await command(['docker', 'buildx', 'imagetools', 'inspect', '--raw', ref]));
  const children = (index.manifests ?? []).filter(d => d.platform?.os + '/' + d.platform?.architecture === platform);
  if (children.length !== 1) throw new Failure('release index missing unique build platform');
  return ref.split('@')[0] + '@' + children[0].digest;
}
export async function inspectImage(name, ref, platform, command = run) {
  if (name in INFRA && ref.includes('@sha256:')) { ref = await platformReference(ref, platform, command); await command(['docker', 'pull', '--platform', platform, ref], { timeout: 900_000 }); }
  return JSON.parse(await command(['docker', 'image', 'inspect', '--platform', platform, ref]))[0];
}
async function exportImages(file, refs, platform) {
  const child = spawn('docker', ['save', '--platform', platform, ...new Set(Object.values(refs))], { stdio: ['ignore', 'pipe', 'pipe'] }); child.stderr.resume();
  const done = new Promise((resolve, reject) => { child.once('error', () => reject(new Failure('image export unavailable'))); child.once('close', code => code === 0 ? resolve() : reject(new Failure('image export failed'))); });
  try { await Promise.all([pipeline(child.stdout, createGzip({ level: 1 }), fs.createWriteStream(file, { flags: 'wx', mode: 0o644 })), done]); }
  finally { if (child.exitCode === null) child.kill('SIGKILL'); }
}
export async function main() {
  const { values: args, positionals } = argumentsFor({ 'build-report': { type: 'string' }, version: { type: 'string' }, output: { type: 'string' }, release: { type: 'string' } });
  if (args.help) return console.log('Package committed images: --build-report FILE --version VERSION --output NEW_DIRECTORY [--release PUBLISHED_RELEASE_JSON]');
  if (positionals.length || !args['build-report'] || !args.output || !/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(args.version ?? '')) throw new Failure('Build report, fixed version and new output directory required');
  const output = path.resolve(args.output); if (exists(output)) throw new Failure('output directory already exists');
  const report = json(path.resolve(args['build-report'])); validateReport(report);
  const packageCommit = await run(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }); await validateImageSources(report.sourceCommits.browser, packageCommit);
  // The compiler must resolve exactly the dependencies in the committed lock.
  if (!fs.readFileSync(path.join(ROOT, 'package-lock.json')).equals(await gitBytes(ROOT, packageCommit, 'package-lock.json'))) throw new Failure('Commit dependency changes before packaging');
  let refs = { ...Object.fromEntries(Object.entries(report.images).map(([k, v]) => [k, v.id])), ...INFRA }, distribution = 'offline-candidate';
  if (args.release) {
    const release = json(args.release);
    if (release.version !== args.version || Object.keys(release.images ?? {}).sort().join(',') !== Object.keys(refs).sort().join(',') || Object.values(release.images).some(v => !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(v))) throw new Failure('immutable six-image release required');
    refs = release.images; distribution = 'registry-candidate';
  }
  const inventory = {};
  for (const [name, original] of Object.entries(refs)) {
    let ref = original;
    if (args.release && name in report.images) { ref = await platformReference(ref, report.platform); await run(['docker', 'pull', '--platform', report.platform, ref], { timeout: 900_000 }); }
    const info = await inspectImage(name, ref, report.platform);
    if (info.Os + '/' + info.Architecture !== report.platform) throw new Failure('bundle/build platform mismatch');
    if (name in report.images && info.Id !== report.images[name].id) throw new Failure('build/image mismatch');
    inventory[name] = { id: info.Id, platform: report.platform };
  }
  if (!args.release) refs = Object.fromEntries(Object.entries(inventory).map(([k, v]) => [k, v.id]));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.agent-package-'));
  try {
    const source = path.join(staging, 'source'); await committedCheckout(ROOT, source, packageCommit);
    const name = 'agentic-browser-agent-' + args.version, bundle = path.join(staging, name); fs.mkdirSync(bundle);
    await bundleTools(bundle, { source });
    for (const [name, sourcePath] of Object.entries(FILES)) {
      const file = path.join(bundle, name); fs.mkdirSync(path.dirname(file), { recursive: true });
      let data = fs.readFileSync(path.join(source, sourcePath));
      if (name === 'README.md') data = Buffer.from(data.toString().replaceAll('vX.Y.Z', args.version));
      fs.writeFileSync(file, data, { mode: 0o644 });
    }
    fs.writeFileSync(path.join(bundle, 'release.json'), JSON.stringify({ version: args.version, images: refs }, null, 2) + '\n');
    const build = { version: args.version, distribution, published: false, sourceCommits: report.sourceCommits, librechatTree: report.librechatTree, packageCommit, runtimeAssets: report.runtimeAssets, images: inventory, hostRuntime: 'Node.js 24+', acceptance: { independentHost: 'pending', note: 'Candidate packaging does not imply installation acceptance.' } };
    fs.writeFileSync(path.join(bundle, 'BUILD.json'), JSON.stringify(build, null, 2) + '\n');
    if (!args.release) await exportImages(path.join(bundle, 'images.tar.gz'), refs, report.platform);
    let sums = ''; for (const file of walk(bundle).sort()) { if (fs.lstatSync(file).isDirectory()) { fs.chmodSync(file, 0o755); continue; } fs.chmodSync(file, 0o644); sums += `${await digest(file)}  ${path.relative(bundle, file).split(path.sep).join('/')}\n`; }
    fs.writeFileSync(path.join(bundle, 'SHA256SUMS'), sums);
    await run([process.execPath, path.join(bundle, 'bundle.mjs'), 'verify'], { timeout: 300_000 });
    const archive = path.join(staging, name + '.tar.gz'); await tar.c({ cwd: staging, file: archive, gzip: { level: 1 }, portable: true }, [name]);
    fs.writeFileSync(path.join(staging, 'SHA256SUMS'), `${await digest(archive)}  ${path.basename(archive)}\n`);
    const ready = path.join(staging, 'complete'); fs.mkdirSync(ready);
    for (const file of [bundle, archive, path.join(staging, 'SHA256SUMS')]) fs.renameSync(file, path.join(ready, path.basename(file)));
    fs.renameSync(ready, output);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  console.log(JSON.stringify({ candidate: true, published: false, directory: output, images: Object.keys(inventory).length, packageCommit }));
}
if (mainModule('package-agent.mjs')) cli(main);
