#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { argumentsFor, cli, digest, Failure, json, mainModule, run, walk } from './lib/system.mjs';
const DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock'];
export const REQUIRED = ['agentctl.mjs', 'bundle.mjs', 'nginx.host.conf', 'compose.yaml', 'release.json', 'BUILD.json', 'README.md', 'OPERATIONS.md', 'CONFIGURATION.md', 'config/settings.example.json', 'config/secrets.env.example', 'acceptance/verify.mjs', 'acceptance/model-fixture.mjs', 'LICENSES/TOOLS.txt', 'LICENSES/LibreChat.txt', 'LICENSES/PLAYWRIGHT-LICENSE'];
export async function verify(directory) {
  directory = fs.realpathSync(directory); const sums = path.join(directory, 'SHA256SUMS');
  if (fs.lstatSync(sums).isSymbolicLink()) throw new Failure('symlink checksum file');
  const entries = new Map();
  for (const row of fs.readFileSync(sums, 'utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9_./-]+)$/.exec(row);
    if (!match) throw new Failure('invalid checksum line');
    const [, expected, name] = match;
    if (path.posix.isAbsolute(name) || name.split('/').includes('..') || path.posix.normalize(name) !== name || entries.has(name) || name === 'SHA256SUMS') throw new Failure('unsafe or duplicate bundle path');
    const file = path.join(directory, name);
    if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile() || await digest(file) !== expected) throw new Failure('bundle checksum mismatch: ' + name);
    entries.set(name, expected);
  }
  const paths = walk(directory);
  if (paths.some(p => fs.lstatSync(p).isSymbolicLink())) throw new Failure('bundle symlinks are not allowed');
  const actual = paths.filter(p => !fs.statSync(p).isDirectory()).map(p => path.relative(directory, p).split(path.sep).join('/'));
  if (actual.length !== entries.size + 1 || actual.some(n => n !== 'SHA256SUMS' && !entries.has(n))) throw new Failure('unexpected or missing bundle files');
  if (REQUIRED.some(n => !entries.has(n))) throw new Failure('incomplete bundle');
  const release = json(path.join(directory, 'release.json')), build = json(path.join(directory, 'BUILD.json'));
  if (!['offline-candidate', 'registry-candidate'].includes(build.distribution)) throw new Failure('unknown bundle distribution');
  if (Object.keys(release.images ?? {}).sort().join(',') !== 'agent,browser,gateway,mongo,redis,runtime') throw new Failure('six release images required');
  if (Object.keys(build.images ?? {}).sort().join(',') !== Object.keys(release.images).sort().join(',')) throw new Failure('image inventory mismatch');
  for (const [name, ref] of Object.entries(release.images)) {
    const info = build.images[name];
    if (!/^sha256:[a-f0-9]{64}$/.test(info.id)) throw new Failure('invalid image identity');
    if (!['linux/amd64', 'linux/arm64'].includes(info.platform)) throw new Failure('unsupported platform');
    if (build.distribution === 'offline-candidate' ? ref !== info.id : !/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(ref)) throw new Failure('immutable image reference required');
  }
  if (new Set(Object.values(build.images).map(i => i.platform)).size !== 1) throw new Failure('mixed bundle architectures');
  if (build.distribution === 'offline-candidate' && !entries.has('images.tar.gz')) throw new Failure('missing offline image archive');
  return build;
}
export async function loadImages(directory, build) {
  if (build.distribution !== 'offline-candidate') throw new Failure('this bundle has no offline image archive');
  const child = spawn(DOCKER[0], [...DOCKER.slice(1), 'load', '--quiet'], { stdio: ['pipe', 'ignore', 'pipe'] }); child.stderr.resume();
  const done = new Promise((resolve, reject) => { child.once('error', () => reject(new Failure('image import unavailable'))); child.once('close', code => code === 0 ? resolve() : reject(new Failure('image import failed'))); });
  try { await Promise.all([pipeline(fs.createReadStream(path.join(directory, 'images.tar.gz')), createGunzip(), child.stdin), done]); }
  finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  for (const info of Object.values(build.images)) {
    const image = JSON.parse(await run([...DOCKER, 'image', 'inspect', info.id]))[0];
    if (image.Id !== info.id || image.Os + '/' + image.Architecture !== info.platform) throw new Failure('imported image mismatch');
  }
}
export async function main() {
  const { values, positionals } = argumentsFor({});
  if (values.help) return console.log('node bundle.mjs verify|load-images');
  if (positionals.length !== 1 || !['verify', 'load-images'].includes(positionals[0])) throw new Failure('Use verify or load-images');
  const directory = import.meta.dirname, build = await verify(directory);
  if (positionals[0] === 'load-images') await loadImages(directory, build);
  console.log(JSON.stringify({ verified: true, imagesImported: positionals[0] === 'load-images', version: build.version, distribution: build.distribution }));
}
if (mainModule('bundle.mjs')) cli(main);
