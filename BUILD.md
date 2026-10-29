# 从同一份源码构建、发布和部署完整 Agent

Mac（Intel / Apple Silicon）和 Ubuntu 使用同一个仓库、同一套 Node.js/npm/Buildx 命令。构建目标是 `linux/amd64` 与 `linux/arm64`，不是 macOS 镜像。源码移交包、相邻 LibreChat 仓库、服务器 `.deployment/` 和根目录 `.env` 都不属于构建依赖。

当前站点仍运行已经验收的 rc.6。新构建流程与新镜像的验证状态见 [进度](docs/plans/PROGRESS.md)。按维护者要求，Ubuntu 不执行 GHCR 上传或 Git push；以下发布操作由维护者执行。文中的 GHCR 地址不代表已经上线。

## 构建、发布、部署分别需要什么

| 阶段 | 输入 | 不需要的配置 |
| --- | --- | --- |
| 构建 | Git 源码、锁定上游与公共下载、目标架构、镜像版本标签 | Qwen、Turnstile、SMTP、管理员账号和站点域名 |
| 发布 GHCR | 完成构建的镜像及报告、版本号、GHCR namespace、Docker 已有登录 | 所有站点业务密钥 |
| 部署实例 | 固定镜像清单、安装目录；`init` 生成 `config/` 后填写模型及站点配置 | 源码和构建缓存 |

例如，同一镜像可以部署在两个域名，分别配置不同 Qwen key、预算和数据库。换模型密钥不需要重建镜像；更改程序代码才需要重建。配置挂载细节见 [CONFIGURATION.md](deploy/agent/CONFIGURATION.md)。

## 一次 clone 即可构建

构建机需要 Node.js 24+（含 npm）、Git、系统 tar、Docker Engine 28+ 与 Buildx；Mac 使用运行中的 Docker Desktop。打包需要 Docker API 1.49+ 的按平台 inspect/save 能力。无需在宿主安装 Python；开发、构建、发布和验收共用 Node.js。构建器默认限制为 2 CPU / 5 GiB，Docker VM 应留出额外内存和至少 30 GiB 可用空间。

先将所需源码提交并同步到主仓库，再在 Mac 或 Ubuntu clone 同一分支。私有 Git 仓库的读取权限与 Docker 的 GHCR 发布权限分别管理。

```bash
git clone --branch codex/librechat-integration https://github.com/infrasika/agentic-browser.git
cd agentic-browser
npm ci
npm run build:agent -- --committed \
  --platforms linux/amd64,linux/arm64 --tag v0.2.0-rc.7
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

## 使用 Docker 已有授权发布 GHCR

| 组件 | 镜像仓库 |
| --- | --- |
| Agent | `ghcr.io/infrasika/agentic-browser-agent` |
| Browser Service | `ghcr.io/infrasika/agentic-browser-service` |
| Chrome runtime | `ghcr.io/infrasika/agentic-browser-runtime` |
| Nginx / MongoDB / Redis | 官方多平台 digest，不复制发布 |

发布工具使用 Docker 的 `credHelpers` / `credsStore`，支持 Mac Docker Desktop / Keychain；不创建 `publish.env`。已有 Git Keychain 权限不一定包含 Docker GHCR 登录。必要时先执行 `docker login ghcr.io`，凭据交给 Docker 的存储管理；CI 可使用 `GITHUB_TOKEN`。[GitHub GHCR 认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry)

先预检（替换为本次构建目录，不读取凭据、不访问 registry）：

```bash
npm run publish:agent -- \
  --build-report output/build/build-EXAMPLE/amd64/report.json \
  --build-report output/build/build-EXAMPLE/arm64/report.json \
  --version v0.2.0-rc.7 --namespace infrasika
```

验收后上传，在上面命令末尾加：

```text
--run --output output/agent/ghcr/v0.2.0-rc.7
```

工具要求两平台来自同一源码，检查镜像标签和身份，先上传带 `-amd64` / `-arm64` 的固定架构标签，再生成同一个 `v0.2.0-rc.7` 多平台标签。逐一校验实际上传的镜像与最终 index，成功后生成含六个固定 digest 的 `release.json` 及发布回执。部署时 Docker 按主机架构选取对应子镜像。

已有版本指向不同内容时拒绝覆盖；相同内容可重试。跨仓库发布不是事务，同一 namespace 同时只允许一个发布进程。不会移动 `latest`。部分成功后请使用原镜像和报告重试，不要重建后覆盖同版本。

新 package 默认私有。需要公开分发时在 GitHub Packages 设置可见性，再验证两种架构的匿名拉取：

```bash
npm run publish:agent -- \
  --verify-public output/agent/ghcr/v0.2.0-rc.7/release.json
```

## 生成安装包与部署

安装包按目标架构生成，使用对应的报告；同一个 registry 版本标签包含两种架构。

```bash
npm run package:agent -- \
  --build-report output/build/build-EXAMPLE/amd64/report.json \
  --version v0.2.0-rc.7 \
  --release output/agent/ghcr/v0.2.0-rc.7/release.json \
  --output output/agent/releases/v0.2.0-rc.7-amd64
```

ARM 包改用 `arm64/report.json` 与另一输出目录。不传 `--release` 则生成包含六镜像归档的离线候选包；传入时生成轻量包、固定清单和安装工具。Node 管理工具与依赖编译成独立文件，并附带 `LICENSES/TOOLS.txt`；部署者无需源码或 `npm install`。所有工具/文档来自 Git HEAD 白名单，不包含任何部署目录。打包不发布镜像或更改站点。

将匹配架构的安装包放到 Linux 服务器，按 [INSTALL.md](deploy/agent/INSTALL.md) 校验、`init`、填写 `config/settings.json` 与 `config/secrets.env`、`up`、`doctor`。宿主数据位于安装目录 `data/`；生成的 `.env` 只用于 Compose 插值。升级和备份见 [OPERATIONS.md](deploy/agent/OPERATIONS.md)。

独立新服务器、原生 ARM64 全流程、真实版本升级/恢复、匿名下载与拉取均应记录到版本验收结果；已有 amd64 rc.6 验收不能代替新构建的证据。可用 `.github/workflows/accept-agent-bundle.yml` 在干净 runner 验收可信候选包，工作流准备好不代表已经执行。

## npm 命令与工具职责

第一次 clone 或锁文件更新后执行 `npm ci`；不要在 Mac 与 Ubuntu 之间复制 `node_modules`。依赖版本固定在同一份 `package-lock.json`。

| 命令 | 用途及额外参数示例 |
| --- | --- |
| `npm run source:prepare -- --output output/sources/librechat` | 获取并验证上游与补丁，供修改 LibreChat；完整镜像构建会自动执行 |
| `npm run runtime:fetch -- --arch arm64` | 下载并核对该架构的 Chrome、扩展；无需 dpkg |
| `npm run build:agent -- --committed --platforms linux/amd64 --tag v0.2.0-rc.7` | 构建完整三镜像；可用 `--component agent` 单独调试组件，部分报告不能发布 |
| `npm run publish:agent -- --help` | 双架构预检、GHCR 发布与匿名拉取验证 |
| `npm run package:agent -- --help` | 从已提交源码编译管理工具，打包已构建镜像，不重建应用 |
| `npm run agent -- --help` | 在源码环境使用安装、配置、账号、备份和恢复工具；管理实际实例需传 `--directory` |
| `npm run accept:bundle -- --bundle /absolute/bundle --work /absolute/new-test-directory` | 只使用发行包验收临时实例，不使用真实模型 |
| `npm run check` / `npm test` | TypeScript 检查、应用及工具链回归测试；`npm run test:tools` 可单跑工具测试 |

`scripts/build/*.mjs` 是源码准备、资源下载、镜像构建/发布和打包工具；`deploy/agent/*.mjs` 是部署运维工具；`test/tooling/*.test.mjs` 验证这些行为，`test/acceptance/` 做真实 Docker/浏览器验收。`bundle-tools.mjs` 是发行打包器内部的 esbuild 入口，无需单独运行。项目已移除自有 Python 脚本和 Python 测试。

`deploy/agent/agent.Dockerfile` 的 builder 阶段仍安装 Python、make 和 g++，用于上游 npm 原生依赖的 node-gyp 编译，由 Docker 自动准备。它不构成宿主 Python 环境或第二套项目脚本。部署宿主使用 Node.js 24+、Docker 和 Linux 自带的 `flock`；定时备份记录 Node 可执行文件的绝对路径，升级 Node 后如路径改变需重新生成并加载调度单元。
