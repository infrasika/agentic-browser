#!/usr/bin/env python3
"""Fetch official browser/extension packages; locked hashes are required on reuse."""
import argparse
import hashlib
import io
import json
import platform
from pathlib import Path
import struct
import tarfile
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'output/runtime/packages'
LOCK = ROOT / 'runtime/assets.lock.json'
EXTENSIONS = {
    'afkoofjocpbclhnldmmaphappihehpma': 'zkPass TransGate',
    'kpcbjghknfclbkejkdllpjhhheppaoca': 'zkPass Schema Validator',
}


def deb_metadata(path):
    """Read Debian package metadata without requiring Linux's dpkg on macOS."""
    with path.open('rb') as package:
        if package.read(8) != b'!<arch>\n': raise ValueError('Invalid Debian archive')
        while header := package.read(60):
            if len(header) != 60 or header[58:] != b'`\n': raise ValueError('Invalid Debian member')
            name = header[:16].decode('ascii').strip().rstrip('/')
            size = int(header[48:58])
            if size < 0: raise ValueError('Invalid Debian member size')
            if name.startswith('control.tar'):
                if size > 4 * 1024 * 1024: raise ValueError('Debian metadata too large')
                with tarfile.open(fileobj=io.BytesIO(package.read(size)), mode='r:*') as archive:
                    entries = [m for m in archive.getmembers() if m.name in ('control', './control')]
                    if len(entries) != 1 or not entries[0].isfile() or entries[0].size > 1024 * 1024:
                        raise ValueError('Invalid Debian control file')
                    fields = {}
                    for line in archive.extractfile(entries[0]).read().decode().splitlines():
                        if line.startswith((' ', '\t')): continue
                        key, separator, value = line.partition(':')
                        if separator and key in ('Version', 'Architecture'):
                            if key in fields: raise ValueError('Duplicate Debian control field')
                            fields[key] = value.strip()
                    if set(fields) != {'Version', 'Architecture'}: raise ValueError('Missing Debian metadata')
                    return fields
            package.seek(size + size % 2, 1)
    raise ValueError('Missing Debian control archive')


def download(url, path, expected=None):
    if path.exists() and expected and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        return path.read_bytes()
    with urllib.request.urlopen(url, timeout=60) as response:
        if response.status != 200:
            raise RuntimeError(f'Package download failed: HTTP {response.status}')
        data = response.read(300 * 1024 * 1024 + 1)
    if len(data) > 300 * 1024 * 1024:
        raise RuntimeError('Package exceeds size limit')
    digest = hashlib.sha256(data).hexdigest()
    if expected and digest != expected:
        raise RuntimeError(f'{path.name}: upstream package changed; review before --refresh-lock')
    path.with_suffix('.partial').write_bytes(data)
    path.with_suffix('.partial').replace(path)
    return data


def varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, offset
    raise ValueError('Invalid protobuf varint')


def byte_fields(data):
    result = {}
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        if tag & 7 != 2:
            raise ValueError('Unexpected CRX header field')
        length, offset = varint(data, offset)
        if offset + length > len(data):
            raise ValueError('Truncated CRX header')
        result.setdefault(tag >> 3, []).append(data[offset:offset + length])
        offset += length
    return result


def inspect_crx(data, expected_id):
    if data[:4] != b'Cr24' or struct.unpack_from('<I', data, 4)[0] != 3:
        raise ValueError('Expected original CRX3 package')
    header_length = struct.unpack_from('<I', data, 8)[0]
    if header_length > 1024 * 1024 or 12 + header_length >= len(data):
        raise ValueError('Invalid CRX3 header size')
    header = byte_fields(data[12:12 + header_length])
    signed = byte_fields(header[10000][0])
    crx_id = signed[1][0]
    actual_id = ''.join(chr(97 + int(n, 16)) for n in crx_id.hex())
    if actual_id != expected_id:
        raise ValueError('Extension ID does not match signed header')
    # Chrome verifies the original signature at installation; never repackage it.
    with zipfile.ZipFile(io.BytesIO(data[12 + header_length:])) as package:
        if package.getinfo('manifest.json').file_size > 1024 * 1024:
            raise ValueError('Manifest exceeds size limit')
        manifest = json.loads(package.read('manifest.json'))
    if manifest['manifest_version'] != 3:
        raise ValueError('Only Manifest V3 packages are accepted')
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--refresh-lock', action='store_true')
    parser.add_argument('--arch', choices=['amd64', 'arm64'], default='arm64' if platform.machine() in ['aarch64', 'arm64'] else 'amd64')
    args = parser.parse_args()
    if not LOCK.exists() and not args.refresh_lock:
        raise SystemExit('Missing assets lock. Review versions and use --refresh-lock explicitly.')
    old = json.loads(LOCK.read_text()) if LOCK.exists() else {}
    chrome_key = 'chromeArm64' if args.arch == 'arm64' else 'chrome'
    expected_chrome = old.get(chrome_key, {})
    if not expected_chrome and not args.refresh_lock:
        raise SystemExit(f'Missing Chrome lock for {args.arch}')
    ASSETS.mkdir(parents=True, exist_ok=True)
    chrome_url = f'https://dl.google.com/linux/direct/google-chrome-stable_current_{args.arch}.deb'
    chrome_path = ASSETS / f'chrome-{args.arch}.deb'
    chrome = download(chrome_url, chrome_path, None if args.refresh_lock else expected_chrome.get('sha256'))
    metadata = deb_metadata(chrome_path)
    if metadata['Architecture'] != args.arch:
        raise RuntimeError('Chrome package architecture mismatch')
    chrome_version = metadata['Version']
    result = {**old, 'format': 1, chrome_key: {'version': chrome_version, 'url': chrome_url, 'sha256': hashlib.sha256(chrome).hexdigest()}, 'extensions': []}
    for extension_id, name in EXTENSIONS.items():
        query = urllib.parse.urlencode({'response': 'redirect', 'prodversion': chrome_version.split('-')[0], 'acceptformat': 'crx3', 'x': f'id={extension_id}&uc'})
        url = 'https://clients2.google.com/service/update2/crx?' + query
        previous = next((e for e in old.get('extensions', []) if e['id'] == extension_id), {})
        data = download(url, ASSETS / f'{extension_id}.crx', None if args.refresh_lock else previous.get('sha256'))
        manifest = inspect_crx(data, extension_id)
        result['extensions'].append({'id': extension_id, 'name': name, 'version': manifest['version'], 'sha256': hashlib.sha256(data).hexdigest(), 'manifestVersion': manifest['manifest_version'], 'permissions': manifest.get('permissions', []), 'popup': manifest.get('action', {}).get('default_popup'), 'source': f'https://chromewebstore.google.com/detail/{extension_id}'})
        print(f"Verified package metadata: {name} {manifest['version']}", flush=True)
    if args.refresh_lock:
        LOCK.write_text(json.dumps(result, indent=2) + '\n')
    elif result != old:
        raise RuntimeError('Asset metadata differs from lock')
    print(f'Packages ready; Chrome {chrome_version}; hashes recorded in runtime/assets.lock.json')


if __name__ == '__main__':
    main()
