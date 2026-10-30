# 构建镜像

本指南在 **Mac（Intel / Apple Silicon）或 Ubuntu 构建机**上执行，从同一份源码生成 Linux amd64 / arm64 镜像。构建后按 [发布指南](RELEASING.md) 上传 GHCR、生成安装包；只想安装现成版本的用户直接阅读 [部署指南](DEPLOYMENT.md)。

## 1. 准备构建机

| 依赖 | 要求 |
| --- | --- |
| Node.js / npm | Node.js 24+，使用随附的 npm |
| Git / tar | 用于读取已提交源码和处理归档 |
| Docker / Buildx | Docker Engine 28+、API 1.49+、Buildx；Mac 使用运行中的 Docker Desktop |
| 资源与网络 | 至少 30 GiB 可用空间，双架构镜像和离线包需另留空间；可访问 GitHub、npm、镜像仓库、Google 浏览器和扩展下载服务 |

默认临时构建器限制为 2 CPU / 5 GiB；Docker Desktop 的 VM 内存还应给 daemon 和其他容器留出余量。宿主不需要 Python：上游原生 npm 模块需要的 Python、make、g++ 在 Docker 构建阶段安装。

```bash
node --version
npm --version
git --version
tar --version
docker version
docker buildx version
```

`docker version` 必须能读到 Server。构建、打包和发布应连接同一个 Docker daemon，脚本需要读取构建后留在本机的镜像。

## 2. 获取源码并检查

`main` 保存已合并的完整 Agent 源码，日常开发使用 `feature` 分支；构建正式版本时选择对应版本标签。以下从 `main` 获取源码，后续命令在仓库根目录执行：

```bash
git clone --branch main https://github.com/infrasika/agentic-browser.git
cd agentic-browser
npm ci
npm run check
npm test
git status --short
```

已有 checkout 直接切到所需提交并执行 `npm ci`。不要跨操作系统复制 `node_modules`。准备发布时，先审核并提交要交付的修改，后面的 `--committed` 只读取 Git 提交，不包含未提交文件。

**构建无需填写任何站点密钥。** 新 clone 中没有 `config/local/`、`.deployment/` 和根目录 `.env` 是正常的，也不需要从服务器复制这些目录。公开的 `config/settings.example.json`、`config/secrets.env.example` 供部署者查看字段；真实配置由 Linux 上的 `init` 生成。配置传递方式见 [配置指南](CONFIGURATION.md)。

## 3. 构建目标架构

选定一个新版本，后续构建、发布和打包沿用同一个版本号。下面的 `v0.1.0-preview.9` 仅为示例，不表示该版本已经发布。

```bash
AGENT_VERSION='v0.1.0-preview.9'
npm run build:agent -- --committed \
  --platforms linux/amd64,linux/arm64 \
  --tag "$AGENT_VERSION"
```

`npm run … -- …` 中的 `--` 把后面的参数传给脚本。`build:agent` 已包含执行开关，无需再加 `--run`。

| 参数 | 用途 |
| --- | --- |
| `--committed` | 使用已提交源码；发布和打包要求这种构建 |
| `--platforms linux/amd64,linux/arm64` | 构建两个平台；也可只传其中一个 |
| `--tag VERSION` | 本机镜像版本，发布时使用固定版本号 |
| `--builder NAME` | 使用已有 Buildx 构建器，便于复用缓存或使用原生多节点 |
| `--component agent\|browser\|runtime` | 开发时单独重建组件；完整安装包要求三个组件齐全 |

开发调试可以省略 `--committed`，读取已跟踪文件的工作区版本；这种报告不能用于发布或打包。

构建过程会自动：

1. 根据 `integrations/librechat/source.lock.json` 获取公开上游提交，应用定制补丁，核对摘要、完整 Git tree、许可证和浏览器协议。
2. 根据 `runtime/assets.lock.json` 下载并校验 Chrome 与原始扩展包，缓存到 `output/runtime/packages/`。
3. 为每个平台分别构建并加载 Agent、Browser Service、Chrome runtime 三个镜像。
4. 保存每个平台的报告与各组件日志。失败时停止，不用未校验的最新资源替代锁定版本。

Docker Desktop 支持跨架构模拟；Linux 构建器也可使用 QEMU 或多个原生节点。自定义 builder 可用 `docker buildx inspect NAME --bootstrap` 检查平台能力。跨架构编译可能明显慢于原生构建，配置方式见 [Docker 多平台构建](https://docs.docker.com/build/building/multi-platform/)。默认临时构建器在结束后删除；通过 `--builder` 传入的构建器由你管理。

## 4. 确认产物

命令输出本次实际构建目录，结构如下：

```text
output/build/build-XXXXXX/
├── reports.json
├── amd64/
│   ├── report.json
│   └── agent.log / browser.log / runtime.log
└── arm64/
    ├── report.json
    └── agent.log / browser.log / runtime.log
```

每份完整报告应为 `passed: true`、`sourceMode: committed`，`images` 包含 `agent`、`browser`、`runtime`。报告还记录架构、源码提交、LibreChat tree、资源摘要和镜像 ID。发布时需同时保留这些报告及对应本机镜像，不能只复制报告到另一台空的 Docker 主机。

本机镜像名为：

```text
agentic-browser-agent:VERSION-amd64
agentic-browser-service:VERSION-amd64
agentic-browser-runtime:VERSION-amd64
# arm64 对应 VERSION-arm64
```

MongoDB、Redis 和 Nginx 使用固定的官方镜像，由后续打包工具拉取，不在本步重新构建。构建锁定了主要源码和资源，但仍需网络下载 APT/npm 等依赖，不承诺字节级可复现。

## 5. 进入发布流程

在 [发布指南](RELEASING.md) 中把 `BUILD_DIR` 设置为本次真实目录，继续候选包验收、GHCR 上传和发行包交付。不要直接编辑 `report.json`、复用已指向其他内容的版本号，或清理尚需发布的本机镜像。

构建成功不等于运行验收通过。完整安装器运行在 Linux；Mac 可以构建、打包和发布，但不能直接在 macOS 上运行 `agentctl init`。两个目标架构需分别在相应原生 Linux 环境验收；源码测试在 Mac 会跳过两项 Linux `flock` 测试。已验证范围集中记录在 [当前状态](STATUS.md)，开发与测试入口见 [开发指南](DEVELOPMENT.md)。
