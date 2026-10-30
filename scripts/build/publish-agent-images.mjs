#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INFRA, ROOT, validateImageSources, validateReport } from './package-agent.mjs';
import { argumentsFor, cli, exists, Failure, json, mainModule, run, same, sha } from '../../deploy/agent/lib/system.mjs';
export const NAMES = { agent: 'agentic-browser-agent', browser: 'agentic-browser-service', runtime: 'agentic-browser-runtime' };
const ACCEPT = ['application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');
export const inspect = async ref => JSON.parse(await run(['docker', 'image', 'inspect', ref]))[0];
export async function credentials() {
  const file = path.join(process.env.DOCKER_CONFIG ?? path.join(os.homedir(), '.docker'), 'config.json'), data = exists(file) ? json(file) : {};
  const helper = data.credHelpers?.['ghcr.io'] ?? data.credsStore; let username, secret;
  if (helper) {
    if (!/^[a-zA-Z0-9_-]+$/.test(helper)) throw new Failure('Invalid Docker credential helper');
    const saved = JSON.parse(await run(['docker-credential-' + helper, 'get'], { input: 'ghcr.io\n' })); username = saved.Username; secret = saved.Secret;
  } else {
    const raw = Buffer.from(data.auths?.['ghcr.io']?.auth ?? '', 'base64').toString(), split = raw.indexOf(':');
    if (split > 0) { username = raw.slice(0, split); secret = raw.slice(split + 1); }
  }
  if (!username || !secret || username === '<token>') throw new Failure('GHCR login unavailable; use docker login ghcr.io with your existing credential store');
  return [username, secret];
}
export class Registry {
  constructor(login = null) { this.login = login; }
  async manifest(repository, reference) {
    const query = new URLSearchParams({ service: 'ghcr.io', scope: 'repository:' + repository + (this.login ? ':pull,push' : ':pull') });
    const headers = this.login ? { Authorization: 'Basic ' + Buffer.from(this.login.join(':')).toString('base64') } : {};
    const tokenResponse = await fetch('https://ghcr.io/token?' + query, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!tokenResponse.ok) throw new Failure('GHCR token request failed; tag availability is unknown');
    const { token } = await tokenResponse.json(); if (typeof token !== 'string') throw new Failure('Invalid registry authorization response');
    const response = await fetch(`https://ghcr.io/v2/${repository}/manifests/${reference}`, { headers: { Authorization: 'Bearer ' + token, Accept: ACCEPT }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Failure('GHCR manifest request failed; tag availability is unknown');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Failure('Registry manifest too large'); chunks.push(chunk); }
    const raw = Buffer.concat(chunks), digest = 'sha256:' + sha(raw);
    if (response.headers.get('Docker-Content-Digest') !== digest) throw new Failure('Registry manifest digest mismatch');
    return [digest, JSON.parse(raw)];
  }
}
export async function sameImage(remote, local, registry, repository, architecture) {
  const [digest, manifest] = remote, known = new Set([local.Id, ...(local.RepoDigests ?? []).map(ref => ref.split('@').at(-1))]);
  if (known.has(digest) || manifest.config?.digest === local.Id) return true;
  const platforms = (manifest.manifests ?? []).filter(d => d.platform?.os === 'linux' && d.platform?.architecture === architecture);
  if (platforms.length !== 1) return false;
  const child = await registry.manifest(repository, platforms[0].digest);
  return Boolean(child && (known.has(child[0]) || child[1].config?.digest === local.Id));
}
export async function plan(reports, version, namespace, { command = run, imageInfo = inspect, validateSources = validateImageSources } = {}) {
  if (!/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw new Failure('Version must be a fixed release tag');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(namespace)) throw new Failure('Invalid GHCR namespace');
  if (!reports.length) throw new Failure('At least one platform build required');
  const head = await command(['git', '-C', ROOT, 'rev-parse', 'HEAD']);
  const images = Object.fromEntries(Object.entries(NAMES).map(([name, file]) => [name, { target: `ghcr.io/${namespace}/${file}:${version}`, platforms: {} }])), seen = new Set();
  for (const report of reports) {
    validateReport(report); const target = report.platform;
    if (seen.has(target)) throw new Failure('Duplicate build platform'); seen.add(target);
    if (!same(report.sourceCommits, reports[0].sourceCommits) || report.librechatTree !== reports[0].librechatTree) throw new Failure('All platform builds must use the same source');
    await validateSources(report.sourceCommits.browser, head);
    for (const [name, entry] of Object.entries(report.images)) {
      const info = await imageInfo(entry.id), labels = info.Config?.Labels ?? {};
      if (info.Id !== entry.id || info.Os + '/' + info.Architecture !== target) throw new Failure('Build image identity/platform mismatch: ' + name);
      if (labels['org.opencontainers.image.revision'] !== report.sourceCommits.browser || labels['dev.agentic-browser.librechat-revision'] !== report.sourceCommits.librechat || labels['dev.agentic-browser.librechat-tree'] !== report.librechatTree) throw new Failure('Build image source labels mismatch: ' + name);
      images[name].platforms[target] = { id: entry.id, target: images[name].target + '-' + target.split('/')[1] };
    }
  }
  return { version, namespace, sourceCommits: reports[0].sourceCommits, librechatTree: reports[0].librechatTree, platforms: [...seen].sort(), toolCommit: head, images, infrastructure: INFRA, published: false };
}
export async function matchesIndex(remote, originals, registry, repository) {
  const descriptors = remote[1].manifests ?? [], actual = descriptors.map(d => (d.platform?.os ?? '') + '/' + (d.platform?.architecture ?? ''));
  if (!same([...actual].sort(), Object.keys(originals).sort())) return false;
  for (const [platform, local] of Object.entries(originals)) {
    const child = await registry.manifest(repository, descriptors[actual.indexOf(platform)].digest);
    if (!child || !await sameImage(child, local, registry, repository, platform.split('/')[1])) return false;
  }
  return true;
}
export async function publish(prepared, registry, docker = run, imageInfo = inspect) {
  const originals = {}, existing = {};
  for (const [name, image] of Object.entries(prepared.images)) { originals[name] = {}; for (const [platform, item] of Object.entries(image.platforms)) originals[name][platform] = await imageInfo(item.id); }
  for (const [name, item] of Object.entries(prepared.images)) {
    const repository = item.target.slice('ghcr.io/'.length).split(':')[0], remote = await registry.manifest(repository, prepared.version);
    if (remote && !await matchesIndex(remote, originals[name], registry, repository)) throw new Failure('Version tag already names another image: ' + name);
    existing[name] = remote;
    for (const [platform, child] of Object.entries(item.platforms)) {
      const remoteChild = await registry.manifest(repository, child.target.split(':').at(-1));
      if (remoteChild && !await sameImage(remoteChild, originals[name][platform], registry, repository, platform.split('/')[1])) throw new Failure('Architecture tag already names another image: ' + name + ' ' + platform);
    }
  }
  const refs = { ...prepared.infrastructure }, receipts = {};
  for (const ref of Object.values(refs)) for (const platform of prepared.platforms) await docker(['docker', 'pull', '--platform', platform, ref], { timeout: 900_000 });
  for (const [name, item] of Object.entries(prepared.images)) {
    const repository = item.target.slice('ghcr.io/'.length).split(':')[0], children = [];
    for (const [platform, child] of Object.entries(item.platforms)) {
      const tag = child.target.split(':').at(-1); let remote = await registry.manifest(repository, tag);
      if (!remote) { console.log('Publishing ' + child.target); await docker(['docker', 'tag', child.id, child.target]); await docker(['docker', 'push', child.target], { timeout: 1_800_000 }); }
      remote = await registry.manifest(repository, tag);
      if (!remote || !await sameImage(remote, originals[name][platform], registry, repository, platform.split('/')[1])) throw new Failure('Published image does not match accepted build: ' + name + ' ' + platform);
      const ref = 'ghcr.io/' + repository + '@' + remote[0]; await docker(['docker', 'pull', '--platform', platform, ref], { timeout: 900_000 });
      if ((await imageInfo(ref)).Id !== child.id) throw new Failure('Pulled image identity mismatch: ' + name); children.push(ref);
    }
    if (!existing[name]) await docker(['docker', 'buildx', 'imagetools', 'create', '--tag', item.target, ...children], { timeout: 900_000 });
    const remote = await registry.manifest(repository, prepared.version);
    if (!remote || !await matchesIndex(remote, originals[name], registry, repository)) throw new Failure('Published multi-platform index mismatch: ' + name);
    refs[name] = 'ghcr.io/' + repository + '@' + remote[0]; receipts[name] = { ...item, digest: remote[0], reference: refs[name] };
  }
  return [{ version: prepared.version, platforms: prepared.platforms, images: refs }, { ...prepared, images: receipts, published: true, anonymousPullVerified: false, independentHostVerified: false }];
}
export async function verifyPublic(release, docker = run, registry = new Registry()) {
  if (Object.keys(release.images ?? {}).sort().join(',') !== [...Object.keys(NAMES), ...Object.keys(INFRA)].sort().join(',')) throw new Failure('Six release images required');
  if (Object.entries(INFRA).some(([name, ref]) => release.images[name] !== ref)) throw new Failure('Unexpected infrastructure image');
  const platforms = release.platforms ?? [];
  if (!platforms.length || new Set(platforms).size !== platforms.length || platforms.some(p => !['linux/amd64', 'linux/arm64'].includes(p))) throw new Failure('Release platforms required');
  for (const name of Object.keys(NAMES)) {
    const ref = release.images[name]; if (!/^ghcr\.io\/[a-z0-9/-]+@sha256:[a-f0-9]{64}$/.test(ref)) throw new Failure('Invalid GHCR digest reference');
    const [repository, digest] = ref.slice('ghcr.io/'.length).split('@'), remote = await registry.manifest(repository, digest);
    if (!remote || remote[0] !== digest) throw new Failure('Anonymous manifest mismatch');
  }
  const host = process.env.DOCKER_HOST ?? await docker(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (!host.startsWith('unix://')) throw new Failure('Anonymous verification requires a local Unix Docker socket');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-anonymous-'));
  try { for (const ref of Object.values(release.images)) for (const platform of platforms) await docker(['docker', '--config', directory, '--host', host, 'pull', '--platform', platform, ref], { timeout: 900_000 }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
  return { version: release.version, anonymousPullVerified: true, images: release.images };
}
export async function main() {
  const { values: args, positionals } = argumentsFor({ 'build-report': { type: 'string', multiple: true }, version: { type: 'string' }, namespace: { type: 'string' }, output: { type: 'string' }, run: { type: 'boolean' }, 'verify-public': { type: 'string' } });
  if (args.help) return console.log('Plan publication: --build-report AMD64_REPORT --build-report ARM64_REPORT --version VERSION --namespace OWNER\nUpload: add --run --output NEW_DIRECTORY\nAnonymous verification: --verify-public RELEASE_JSON');
  if (positionals.length) throw new Failure('Repeat --build-report for each platform; see --help');
  if (args['verify-public']) { if (args.run) throw new Failure('--verify-public and --run are mutually exclusive'); console.log(JSON.stringify(await verifyPublic(json(args['verify-public'])), null, 2)); return; }
  if (!args['build-report']?.length || !args.version || !args.namespace) throw new Failure('--build-report, --version and --namespace are required');
  const prepared = await plan(args['build-report'].map(json), args.version, args.namespace);
  if (!args.run) return console.log(JSON.stringify({ ...prepared, dryRun: true, credentialsRead: false }, null, 2));
  if (!args.output || exists(args.output)) throw new Failure('--output must be a new directory');
  const [release, receipt] = await publish(prepared, new Registry(await credentials())); fs.mkdirSync(args.output, { recursive: true });
  for (const [name, value] of [['release.json', release], ['publication.json', receipt]]) fs.writeFileSync(path.join(args.output, name), JSON.stringify(value, null, 2) + '\n');
  console.log(JSON.stringify({ published: true, output: path.resolve(args.output), anonymousPullVerified: false }));
}
if (mainModule('publish-agent-images.mjs')) cli(main);
