# 发行镜像来源和第三方说明

## 设计参考

本项目参考 [Popcorn](https://github.com/reclaimprotocol/popcorn-oss) 的浏览器会话和人工交互设计。实现前检查了本地 `popcorn-oss` 的文档、模块结构及部分会话交接代码。

当前版本按本地使用场景重新组织和实现，没有迁入上游的服务目录、浏览器运行时、前端素材或部署文件。

所检查的 Popcorn 版本采用 MIT License。保留其许可文本作为来源记录；未来如引入上游代码，应继续保留相应声明。

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

## 运行依赖

npm 依赖及其传递依赖各自保留其包内许可证，版本锁定于 `package-lock.json`。主要依赖为 Playwright、Model Context Protocol TypeScript SDK、Zod 和 tsx。

远程桌面客户端使用未修改的 [noVNC](https://github.com/novnc/noVNC) 1.7.0（MPL-2.0，包内部分模块使用其他许可证）；源码通过 `/vendor/novnc/` 提供，原有文件头声明保留，完整许可位于 `node_modules/@novnc/novnc/docs/LICENSE*`。WebSocket 服务使用 [ws](https://github.com/websockets/ws)（MIT）。发布时应保留依赖包内的全部许可文件。

桌面模式还使用系统安装的 Xvfb、xauth、Openbox 和 x11vnc，遵循各软件包许可。Google Chrome 稳定版从 Google 官方下载地址安装，不作为源码文件提交；浏览器镜像包含锁定版本的安装结果，其使用及再分发受 Google 条款约束。

Chromium 由 Playwright 安装器单独下载，本仓库不提交浏览器二进制。重新分发浏览器或依赖包时，应同时保留它们自带的第三方说明。本项目没有引入 Fortress 浏览器或上游的字体、图标。

## 浏览器运行镜像

`runtime/chrome-seccomp.json` 取自 [Microsoft Playwright 的 Docker 配置](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json)，用于允许 Chrome 在非 root 容器中创建沙箱命名空间；本项目额外允许 `chroot` 系统调用，以便在容器能力全部移除时，Chrome 仍能在自己的用户命名空间内完成沙箱初始化，不向外层进程授予该能力。保留 Apache-2.0 许可于 `runtime/PLAYWRIGHT-LICENSE`。

两个 zkPass 扩展从 Google 官方更新服务获取原始签名包，版本及摘要记录在 `runtime/assets.lock.json`。不修改扩展代码或重新签名；二进制位于忽略提交的 `output/runtime/packages/`，遵循原发布者的条款。发行镜像保留原始包、扩展安装元数据及依赖自带许可证；不包含网站登录状态或用户 Profile。镜像是否已公开发布及具体摘要，以对应发行清单和匿名拉取验收为准。
