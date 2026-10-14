#!/usr/bin/env python3
"""Produce a local, allowlisted source preview without private runtime state."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
from datetime import datetime, timezone

root = Path(__file__).resolve().parent.parent
names = {"package.json", "package-lock.json", "tsconfig.json", ".env.example",
         ".dockerignore", ".gitignore", ".env.compose.example", ".env.public.example", "compose.yaml", "compose.public.yaml", "README.md", "deploy/release.env"}
names.update(str(path.relative_to(root)) for path in (root / "deploy/releases").glob("*-public-verification.json"))
allowed = {"src": {".ts"}, "web": {".html", ".js", ".css"}, "test": {".ts"},
           "docs": {".md"}, "scripts": {".py", ".sh", ".mjs"},
           "runtime": {".json", ".mjs", ".md", ".Dockerfile"}, "deploy": {".conf"}}
for directory, suffixes in allowed.items():
    for path in (root / directory).rglob("*"):
        if path.is_symlink():
            raise SystemExit(f"Refusing symlink: {path.relative_to(root)}")
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if path.suffix in suffixes or str(relative) in {"runtime/Dockerfile", "runtime/PLAYWRIGHT-LICENSE"}:
            names.add(str(relative))
contents = {}
for name in sorted(names):
    path = root / name
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f"Missing or unsafe source: {name}")
    contents[name] = path.read_bytes()
manifest = {"kind": "local-source-preview", "files": {
    name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}}
contents["PREVIEW-MANIFEST.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
destination = root / "output" / "releases" / stamp
destination.mkdir(parents=True, exist_ok=False)
archive = destination / "agentic-browser-preview.tar.gz"
with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as bundle:
        for name, data in contents.items():
            entry = tarfile.TarInfo("agentic-browser/" + name)
            entry.size = len(data)
            entry.mode = 0o644
            bundle.addfile(entry, io.BytesIO(data))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(destination / "SHA256SUMS").write_text(f"{digest}  {archive.name}\n")
print(archive.relative_to(root))
print(f"{len(contents) - 1} source files; SHA256 {digest}")
print("Excluded: .env, .data, output, node_modules, .git, CRX/Chrome packages and local credentials.")
