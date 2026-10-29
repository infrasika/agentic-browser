# Distribution and third-party notices

## Design reference

This project references the browser-session and human-handoff design of [Popcorn](https://github.com/reclaimprotocol/popcorn-oss). Its local documentation, module structure, and portions of the handoff implementation were reviewed before implementation.

The current implementation was reorganized for local use. Upstream service directories, browser runtime, frontend assets, and deployment files were not copied into this version.

The reviewed Popcorn version uses the MIT License. Its license is retained below as a provenance record. Preserve applicable notices if upstream code is incorporated in future changes.

```text
MIT License

Copyright (c) 2026 Reclaim Protocol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies

npm packages and their transitive dependencies retain their own licenses. Versions are locked in `package-lock.json`; principal dependencies include Playwright, Zod, tsx, and ws.

The separate LibreChat client includes [noVNC](https://github.com/novnc/noVNC) 1.7.0 in its frontend bundle, primarily under MPL-2.0 with some modules under other licenses. Its dependency license files are in the LibreChat checkout's `node_modules/@novnc/novnc/docs/LICENSE*`. The WebSocket service uses [ws](https://github.com/websockets/ws) under MIT. Retain dependency source and license notices as required when distributing the Agent and Browser images.

Desktop mode uses Xvfb, xauth, Openbox, and x11vnc under their respective package licenses. Google Chrome is installed from Google's official download service. The image contains the locked binary installation; its use and redistribution remain subject to Google's terms. Browser binaries are not committed as source files.

Development Chromium is downloaded separately by Playwright. Preserve bundled third-party notices when redistributing browsers or dependencies. This project does not include Fortress Browser or upstream fonts and icons.

## Browser image

`runtime/chrome-seccomp.json` derives from [Microsoft Playwright's Docker profile](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json). It permits sandbox namespaces for non-root Chrome. This project additionally allows the `chroot` system call so Chrome can initialize its sandbox within its own user namespace after container capabilities have been dropped; it grants no such capability to the outer process. The Apache-2.0 license is retained in `runtime/PLAYWRIGHT-LICENSE`.

The two zkPass extensions are original signed packages obtained from Google's official update service. Their versions and hashes are recorded in `runtime/assets.lock.json`. They are neither modified nor re-signed, and remain subject to their publishers' terms. Downloaded packages are cached under the untracked `output/runtime/packages/` directory. Release images retain the packages, installation metadata, and dependency licenses; they contain no personal login state or user profiles.

Consult each release's manifest and anonymous-pull verification receipt for its published image digests and availability.
