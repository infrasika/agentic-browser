#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { argumentsFor, cli, digest, exists, Failure, id, json, mainModule, run, same, sha } from '../../deploy/agent/lib/system.mjs';
const ROOT = path.resolve(import.meta.dirname, '../..');
const EXTENSIONS = { afkoofjocpbclhnldmmaphappihehpma: 'zkPass TransGate', kpcbjghknfclbkejkdllpjhhheppaoca: 'zkPass Schema Validator' };

export async function debMetadata(file) {
  const fd = fs.openSync(file, 'r'); let offset = 8;
  const read = (size, at) => { const data = Buffer.alloc(size); if (fs.readSync(fd, data, 0, size, at) !== size) throw new Failure('Truncated Debian archive'); return data; };
  try {
    if (read(8, 0).toString() !== '!<arch>\n') throw new Failure('Invalid Debian archive');
    while (offset < fs.fstatSync(fd).size) {
      const header = read(60, offset); offset += 60;
      if (header.subarray(58).toString() !== '`\n') throw new Failure('Invalid Debian member');
      const name = header.subarray(0, 16).toString().trim().replace(/\/$/, ''), size = Number(header.subarray(48, 58).toString().trim());
      if (!Number.isSafeInteger(size) || size < 0) throw new Failure('Invalid Debian member size');
      if (/^control\.tar(?:\.(?:gz|xz|bz2|zst))?$/.test(name)) {
        if (size > 4 * 1024 * 1024) throw new Failure('Debian metadata too large');
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deb-'));
        try {
          const archive = path.join(temporary, name); fs.writeFileSync(archive, read(size, offset));
          // macOS bsdtar and Linux GNU tar both read xz control archives; no dpkg/Python.
          const names = (await run(['tar', '-tf', archive])).split('\n').filter(n => ['control', './control'].includes(n));
          if (names.length !== 1) throw new Failure('Invalid Debian control file');
          const content = await run(['tar', '-xOf', archive, names[0]], { maxBuffer: 1024 * 1024 });
          const fields = {};
          for (const line of content.split('\n')) {
            const match = /^(Version|Architecture):\s*(.+)$/.exec(line);
            if (match) { if (fields[match[1]]) throw new Failure('Duplicate Debian control field'); fields[match[1]] = match[2].trim(); }
          }
          if (!fields.Version || !fields.Architecture) throw new Failure('Missing Debian metadata');
          return fields;
        } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
      }
      offset += size + size % 2;
    }
    throw new Failure('Missing Debian control archive');
  } finally { fs.closeSync(fd); }
}

export async function download(url, file, expected) {
  if (exists(file) && !fs.lstatSync(file).isSymbolicLink() && expected && await digest(file) === expected) return fs.readFileSync(file);
  if (exists(file) && fs.lstatSync(file).isSymbolicLink()) throw new Failure('Package cache symlinks are not allowed');
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (response.status !== 200) throw new Failure('Package download failed: HTTP ' + response.status);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 300 * 1024 * 1024) throw new Failure('Package exceeds size limit'); chunks.push(chunk); }
  const data = Buffer.concat(chunks);
  if (expected && sha(data) !== expected) throw new Failure(path.basename(file) + ': upstream package changed; review before --refresh-lock');
  const pending = file + '.' + id() + '.partial';
  try {
    fs.writeFileSync(pending, data, { flag: 'wx', mode: 0o600 });
    fs.renameSync(pending, file);
  } finally { fs.rmSync(pending, { force: true }); }
  return data;
}
function varint(data, start) {
  let value = 0n;
  for (let offset = start; offset < Math.min(data.length, start + 10); offset++) {
    const byte = data[offset]; value |= BigInt(byte & 127) << BigInt((offset - start) * 7);
    if (!(byte & 128)) { if (value > BigInt(Number.MAX_SAFE_INTEGER)) break; return [Number(value), offset + 1]; }
  }
  throw new Failure('Invalid protobuf varint');
}
function byteFields(data) {
  const result = new Map(); let offset = 0;
  while (offset < data.length) {
    let tag, size; [tag, offset] = varint(data, offset); [size, offset] = varint(data, offset);
    if (tag % 8 !== 2 || offset + size > data.length) throw new Failure('Invalid CRX header');
    const field = Math.floor(tag / 8); result.set(field, [...(result.get(field) ?? []), data.subarray(offset, offset + size)]); offset += size;
  }
  return result;
}
export function inspectCrx(data, expectedId) {
  if (data.length < 12 || data.subarray(0, 4).toString() !== 'Cr24' || data.readUInt32LE(4) !== 3) throw new Failure('Expected original CRX3 package');
  const size = data.readUInt32LE(8);
  if (size > 1024 * 1024 || 12 + size >= data.length) throw new Failure('Invalid CRX3 header size');
  const signed = byteFields(data.subarray(12, 12 + size)).get(10000);
  if (signed?.length !== 1) throw new Failure('Invalid CRX signed header');
  const ids = byteFields(signed[0]).get(1);
  if (ids?.length !== 1 || ids[0].length !== 16 || [...ids[0].toString('hex')].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('') !== expectedId) throw new Failure('Extension ID does not match signed header');
  const files = unzipSync(data.subarray(12 + size), { filter: file => file.name === 'manifest.json' && file.originalSize <= 1024 * 1024 });
  if (!files['manifest.json']) throw new Failure('Missing or oversized extension manifest');
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
  if (manifest.manifest_version !== 3) throw new Failure('Only Manifest V3 packages are accepted');
  return manifest;
}
export async function fetchAssets({ arch = process.arch === 'arm64' ? 'arm64' : 'amd64', output = path.join(ROOT, 'output/runtime/packages'), refresh = false, source = ROOT } = {}) {
  if (!['amd64', 'arm64'].includes(arch)) throw new Failure('Use amd64 or arm64');
  const lockPath = path.join(source, 'runtime/assets.lock.json');
  if (!exists(lockPath) && !refresh) throw new Failure('Missing assets lock; review versions before --refresh-lock');
  const old = exists(lockPath) ? json(lockPath) : {}, key = arch === 'arm64' ? 'chromeArm64' : 'chrome', expected = old[key];
  if (!expected && !refresh) throw new Failure('Missing Chrome lock for ' + arch);
  fs.mkdirSync(output, { recursive: true });
  const file = path.join(output, `chrome-${arch}.deb`);
  const chrome = await download(refresh ? `https://dl.google.com/linux/direct/google-chrome-stable_current_${arch}.deb` : expected.url, file, refresh ? undefined : expected.sha256);
  const metadata = await debMetadata(file);
  if (metadata.Architecture !== arch) throw new Failure('Chrome package architecture mismatch');
  const version = metadata.Version;
  const result = { ...old, format: 1, [key]: { version, url: `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${version}_${arch}.deb`, sha256: sha(chrome) }, extensions: [] };
  for (const [extensionId, name] of Object.entries(EXTENSIONS)) {
    const previous = old.extensions?.find(e => e.id === extensionId);
    if (!refresh && !previous?.sha256) throw new Failure('Missing extension lock');
    const query = new URLSearchParams({ response: 'redirect', prodversion: version.split('-')[0], acceptformat: 'crx3', x: `id=${extensionId}&uc` });
    const data = await download('https://clients2.google.com/service/update2/crx?' + query, path.join(output, extensionId + '.crx'), refresh ? undefined : previous.sha256);
    const manifest = inspectCrx(data, extensionId);
    result.extensions.push({ id: extensionId, name, version: manifest.version, sha256: sha(data), manifestVersion: manifest.manifest_version, permissions: manifest.permissions ?? [], popup: manifest.action?.default_popup ?? null, source: `https://chromewebstore.google.com/detail/${extensionId}` });
    console.log(`Verified package metadata: ${name} ${manifest.version}`);
  }
  if (refresh) fs.writeFileSync(lockPath, JSON.stringify(result, null, 2) + '\n');
  else if (!same(result, old)) throw new Failure('Asset metadata differs from lock');
  console.log(`Packages ready; Chrome ${version}; hashes verified against runtime/assets.lock.json`);
  return result;
}
export async function main() {
  const { values, positionals } = argumentsFor({ 'refresh-lock': { type: 'boolean' }, arch: { type: 'string' }, output: { type: 'string' } });
  if (values.help) return console.log('Fetch locked packages: --arch amd64|arm64 --output DIRECTORY [--refresh-lock]');
  if (positionals.length) throw new Failure('Unexpected positional argument');
  await fetchAssets({ arch: values.arch, output: values.output && path.resolve(values.output), refresh: values['refresh-lock'] });
}
if (mainModule('fetch-runtime-assets.mjs')) cli(main);
