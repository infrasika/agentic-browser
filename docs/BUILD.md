# 构建镜像

Mac（Intel / Apple Silicon）和 Ubuntu 使用同一个仓库、同一套 Node.js/npm/Buildx 命令，生成 `linux/amd64` 与 `linux/arm64` 镜像。构建只读取源码和公共依赖，无需服务器配置目录。

完整 Agent 的公开分发状态及验收范围见 [STATUS.md](STATUS.md)。本页负责生成镜像，后续流程见 [发布与打包](RELEASING.md)。

## 构建、发布、部署分别需要什么

| 阶段 | 输入 | 不需要的配置 |
| --- | --- | --- |
| 构建 | Git 源码、锁定上游与公共下载、目标架构、镜像版本标签 | Qwen、Turnstile、SMTP、管理员账号和站点域名 |
| 发布 GHCR | 完成构建的镜像及报告、版本号、GHCR namespace、Docker 已有登录 | 所有站点业务密钥 |
| 部署实例 | 固定镜像清单、安装目录；`init` 生成 `config/` 后填写模型及站点配置 | 源码和构建缓存 |

例如，同一镜像可以部署在两个域名，分别配置不同 Qwen key、预算和数据库。换模型密钥不需要重建镜像；更改程序代码才需要重建。配置挂载细节见 [CONFIGURATION.md](CONFIGURATION.md)。

clone 后的 `config/settings.example.json` 和 `config/secrets.env.example` 可用于查看部署参数；构建时保持示例原样即可。真实文件由部署时的 `init` 生成，不从构建机传入镜像。

**Mac 上 clone 后没有 `config/local/` 是正常的。** 只做构建、打包或发布时，不用创建该目录、不用复制服务器的配置，也不用运行 `agent init`。下面的构建命令可以直接执行。当前完整 Agent 安装器仅支持 Linux；要启动并体验整套服务，请在目标 Linux 服务器或 Linux 虚拟机上初始化和填写配置。Mac 的构建支持不等于 macOS 原生部署支持。

## 一次 clone 即可构建

构建机需要 Node.js 24+（含 npm）、Git、系统 tar、Docker Engine 28+ 与 Buildx；Mac 使用运行中的 Docker Desktop。打包需要 Docker API 1.49+ 的按平台 inspect/save 能力。无需在宿主安装 Python；开发、构建、发布和验收共用 Node.js。构建器默认限制为 2 CPU / 5 GiB，Docker VM 应留出额外内存和至少 30 GiB 可用空间。

先将所需源码提交并同步到远端，再在 Mac 或 Ubuntu clone 对应分支或标签。私有 Git 仓库的读取权限与 Docker 的 GHCR 发布权限分别管理。

```bash
git clone --branch codex/librechat-integration https://github.com/infrasika/agentic-browser.git
cd agentic-browser
npm ci
npm run build:agent -- --committed \
  --platforms linux/amd64,linux/arm64 --tag v0.2.0-rc.8
```

`npm run <命令> -- <参数>` 中的 `--` 把后面的参数传给脚本，见 [npm 参数说明](https://docs.npmjs.com/cli/v11/commands/npm-run/)。`build:agent` 已包含 `--run`，无需再写一次；`publish:agent` 默认只预检，上传仍需显式 `--run`。

版本号是示例，实际发布应使用新的固定版本。`--committed` 只读取 Git 对象；本地改动先提交。开发时可省略它，但工作区构建不能发布。

脚本自动完成：

1. 读取 `integrations/librechat/source.lock.json`，获取固定的公开上游提交、应用仓库内补丁，校验补丁 SHA-256、完整 Git tree、许可证与浏览器协议。
2. 从固定版本地址下载对应架构的 Chrome 与原始扩展包，核对 `runtime/assets.lock.json`；缓存位于 `output/runtime/packages/`。不需要从服务器复制缓存。
3. 分别构建两种架构的 Agent、Browser Service、Chrome runtime，共六个镜像。每个目标平台独立安装原生 npm 依赖，逐个 `--load`，兼容 classic/containerd 镜像存储。
4. 输出 `output/build/build-…/amd64/report.json`、`arm64/report.json` 和构建日志。报告记录平台、源码提交、定制 LibreChat tree、资源摘要及本机镜像 ID。

只构建一种架构时传 `--platforms linux/amd64` 或 `linux/arm64`。Buildx 支持 QEMU 或多个原生构建节点；Mac Docker Desktop 默认提供模拟，Ubuntu 的官方 BuildKit 也包含模拟器。模拟原生模块/前端编译通常较慢，可用 `--builder NAME` 指向已配置的原生多节点构建器；工具不会删除传入的 builder，也可以借此保留缓存供后续构建使用。默认临时 builder 在结束后移除。[Docker 多平台构建说明](https://docs.docker.com/build/building/multi-platform/)

基础镜像均锁定包含两种架构的 manifest index。Chrome 使用带版本号的官方 URL；扩展下载仍依赖商店提供锁定版本。若任何下载与锁定摘要不符，构建会停止，不能自动退回最新版本。资源升级需审核并更新 lock；APT/npm 等网络依赖仍存在，不承诺字节级可复现。

## 发布前验证

```bash
npm ci
npm run check
npm test
```

每个架构的构建报告应为 `passed: true`，且三镜像完整。构建成功只证明镜像可以生成；完整运行验收需在对应架构的原生 Linux 主机完成，包含登录、模型调用、Chrome 沙箱、扩展和接管恢复。Mac 可作为构建机，当前安装器仍面向 Linux 主机。

`npm test` 在 Mac 上跳过两项 Linux `flock` 运维锁测试；它们在 Linux 上必须通过。镜像构建和发布不使用 `flock`，Mac 不必安装该工具。

构建报告、发布回执和验收记录应一并保留。`deploy/agent/agent.Dockerfile` 在 Docker builder 内安装 Python、make 和 g++，用于上游 npm 原生依赖编译；开发者不需要在宿主安装 Python。npm 工具职责与测试入口见 [开发指南](DEVELOPMENT.md)。
