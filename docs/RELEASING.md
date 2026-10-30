# 发布镜像与安装包

本指南面向维护者：把 [构建指南](BUILD.md) 产生的镜像发布到 GHCR，并交付可独立安装的版本包。**构建、打包、上传在 Mac 或 Ubuntu 执行；运行验收在匹配架构的 Linux 主机执行。** 全程不需要部署站点的模型、Turnstile 或 SMTP 密钥。

当前公开分发与验收状态见 [STATUS.md](STATUS.md)。以下命令中的版本、构建目录和 GitHub namespace 都需要替换，不表示示例版本已发布。

## 1. 固定本次发布输入

在源码仓库根目录设置变量，后续在同一终端执行：

```bash
AGENT_VERSION='v0.2.0-rc.9'
BUILD_DIR="$PWD/output/build/build-XXXXXX"
GHCR_NAMESPACE='your-github-user-or-org'
CANDIDATE_DIR="$PWD/output/agent/candidates/$AGENT_VERSION"
PUBLISH_DIR="$PWD/output/agent/ghcr/$AGENT_VERSION"
RELEASE_DIR="$PWD/output/agent/releases/$AGENT_VERSION"
```

`BUILD_DIR` 使用构建命令实际输出的目录。双架构发行需 `amd64/report.json` 和 `arm64/report.json`：二者均为完整三镜像构建，`passed: true`、`sourceMode: committed`，源码提交和 LibreChat tree 相同；对应镜像仍在当前 Docker daemon 中。只发行单架构时，仅传该平台报告，并在版本说明中标明支持范围。

打包工具从**当前 Git HEAD**读取安装工具、模板和文档。先提交要交付的改动；纯文档改动可重新打包，镜像输入发生变化则必须重新构建。所有 `--output` 必须指向尚不存在的目录，工具不会覆盖以前的产物。以下循环遇到错误会停止；先解决失败并核对两平台产物完整，再进入下一步。

## 2. 生成离线候选包并验收

先在构建机生成两个平台的候选包，不上传任何内容：

```bash
for arch in amd64 arm64; do
  npm run package:agent -- \
    --build-report "$BUILD_DIR/$arch/report.json" \
    --version "$AGENT_VERSION" \
    --output "$CANDIDATE_DIR/$arch" || break
done
```

每个目录包含解压后的安装包、同名 `.tar.gz` 归档及归档的 `SHA256SUMS`。离线包内有六个镜像的 `images.tar.gz`，不需要 GHCR 登录。**两架构归档名相同，必须保存在不同目录。**

将某一架构的归档和同目录 `SHA256SUMS` 复制到匹配架构的 Linux 测试机。在该机的下载目录执行；版本与路径换成本次值：

```bash
AGENT_VERSION='v0.2.0-rc.9'
sha256sum -c SHA256SUMS
tar -xzf "agentic-browser-agent-${AGENT_VERSION}.tar.gz"
cd "agentic-browser-agent-${AGENT_VERSION}"
node bundle.mjs verify
node bundle.mjs load-images
node acceptance/verify.mjs --work "$HOME/agent-acceptance-$AGENT_VERSION"
```

测试机需要 Node.js 24+、Docker、Compose 和 `flock`；完整要求见 [部署指南](DEPLOYMENT.md)。工作目录必须是新目录。验收使用真实 Chrome、模拟模型，创建三个临时实例，默认占用回环端口 3340–3342 及约 4–6 GiB 内存，不消耗 LLM 额度或发送邮件。成功后清理测试实例，只保留报告；核对 `passed` 与 `cleanup.passed` 均为 `true`。

两个平台分别执行，QEMU 构建不替代原生运行验收。还应记录目标站点的真实模型、域名 HTTPS、Turnstile、可选邮件，以及有数据的升级/恢复结果；自动化包验收不能代替这些检查。更细的业务与运维验收入口见 [开发指南](DEVELOPMENT.md)。

### 可选：使用 GitHub 原生 runner

`.github/workflows/accept-agent-bundle.yml` 可在全新 Linux runner 上执行同一套包验收，不 checkout 项目源码、不安装 npm 依赖。

1. 将工作流放到 GitHub 默认分支，使手动触发入口可用；运行时选择待验收分支。[GitHub 手动运行说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
2. 把**完整离线包**放到受信任的公开 HTTPS 地址。不要使用不含镜像的 registry 包，或在 URL 中携带私密凭据。
3. 在 Actions 中分别运行 `architecture: amd64` 和 `architecture: arm64`，填写对应 `bundle_url` 和从可信发布渠道取得的归档 `sha256`。
4. 下载 `complete-agent-candidate-acceptance-amd64` / `-arm64` artifact，核对 `host-evidence.json`、`BUILD.json`、`release.json`、`report.json` 的架构、提交、摘要和通过状态。

工作流分别使用 `ubuntu-24.04`、`ubuntu-24.04-arm`，导入前检查宿主与镜像架构一致；需要仓库具备相应 Actions 权限和额度。工作流文件存在不代表已完成验收。

## 3. 准备 Docker 的 GHCR 登录

仅上传项目维护的三个镜像仓库：

| 组件 | 地址 |
| --- | --- |
| Agent | `ghcr.io/<namespace>/agentic-browser-agent` |
| Browser Service | `ghcr.io/<namespace>/agentic-browser-service` |
| Chrome runtime | `ghcr.io/<namespace>/agentic-browser-runtime` |

Nginx、MongoDB、Redis 直接引用官方固定 digest，不重复上传。

发布工具读取 Docker 的 `credHelpers` / `credsStore`，可以使用 Mac Docker Desktop 的 Keychain；已有可用登录就直接继续。Git 的登录凭据与 Docker 的 GHCR 登录分别管理。首次登录时，准备有 `write:packages` 权限的 GitHub Personal access token **classic**，确保账号能写入目标 namespace；组织启用 SSO 时还需授权该 token。交互执行：

```bash
docker login ghcr.io --username YOUR_GITHUB_USERNAME
```

在密码提示中输入 token，不把它写进命令、源码或站点 `secrets.env`。Docker 负责保存凭据，无需 `publish.env`。CI 可通过具有 `packages: write` 权限的 `GITHUB_TOKEN` 登录 Docker；仓库现有验收工作流不会自动发布。[GHCR 认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry)

## 4. 预检并上传镜像

先在本机预检；此命令检查报告和本机镜像，不读发布凭据、不访问 registry：

```bash
npm run publish:agent -- \
  --build-report "$BUILD_DIR/amd64/report.json" \
  --build-report "$BUILD_DIR/arm64/report.json" \
  --version "$AGENT_VERSION" --namespace "$GHCR_NAMESPACE"
```

确认目标地址和两平台信息正确、运行验收通过后上传：

```bash
npm run publish:agent -- \
  --build-report "$BUILD_DIR/amd64/report.json" \
  --build-report "$BUILD_DIR/arm64/report.json" \
  --version "$AGENT_VERSION" --namespace "$GHCR_NAMESPACE" \
  --run --output "$PUBLISH_DIR"
```

工具先上传 `VERSION-amd64` / `VERSION-arm64` 标签，再生成同一个 `VERSION` 多平台标签，核对远程镜像和 index，最后输出：

- `release.json`：六个固定 registry digest，供安装和打包使用。
- `publication.json`：上传回执，记录本次发布结果。

不会更新 `latest`，也拒绝把已有版本改为不同镜像。部分上传成功后，用原镜像和原报告重试；跨仓库发布不是事务，同一 namespace 同时只运行一个发布进程。

准备公开分发时，在 GitHub Packages 中将三个 package 设为公开，再验证匿名拉取：

```bash
npm run publish:agent -- --verify-public "$PUBLISH_DIR/release.json"
```

发布成功与匿名可读是两项独立检查；私有仓库的 Git 权限不会自动让镜像公开。

## 5. 生成面向部署者的安装包

使用上传后生成的固定清单，按架构打包：

```bash
for arch in amd64 arm64; do
  npm run package:agent -- \
    --build-report "$BUILD_DIR/$arch/report.json" \
    --version "$AGENT_VERSION" \
    --release "$PUBLISH_DIR/release.json" \
    --output "$RELEASE_DIR/$arch" || break
done
```

| 包类型 | 打包参数 | 部署时获取镜像 |
| --- | --- | --- |
| Registry 包 | 传 `--release` | `init` 根据固定 digest 拉取 |
| 离线候选包 | 不传 `--release` | 先 `load-images`，再 `init --development` |

两种包共用安装工具和配置方式。包内包含独立 Node 工具、Compose/Nginx 模板、配置示例、部署/配置/运维指南、校验清单与依赖许可证；部署者不需要源码或 `npm install`。`docs/DEPLOYMENT.md` 会成为包内 `README.md`，其中的版本占位符会替换为实际版本；发布前同步其分发状态、下载说明与仓库 README、STATUS，避免把旧候选状态带进正式包。`BUILD.json` 记录镜像源码与工具源码提交；打包成功仍只表示候选产物生成，不代表已公开发行。

在干净 Linux 环境按 [部署指南](DEPLOYMENT.md) 再验证要交付的 registry 包：匿名下载、完整性校验、镜像拉取、初始化、启动和真实任务。每个平台只宣称已完成的验收范围。

## 6. 交付下载渠道与版本说明

工具不会自动创建 GitHub Release 或上传安装包。维护者需向用户提供：

1. 每个架构的归档下载地址与对应 `SHA256SUMS`。
2. 版本、架构、源码提交、固定镜像摘要和验收范围。
3. 宿主要求、安装步骤、已知限制以及升级/恢复说明。

可以使用分别标注 `amd64/`、`arm64/` 的下载目录；若使用同一个 GitHub Release，应给交付归档增加架构后缀，并同步生成与这些文件名对应的校验文件，说明解压后的目录名不变。保留原候选产物，重新验证实际下载文件；不要修改包内文件后沿用旧摘要。

首次公开发行前确认项目主许可证，并保留组件和依赖的适用许可证。交付物不得含站点配置、密钥、浏览器登录档案或用户数据。发行记录集中在版本说明与 [STATUS.md](STATUS.md)，不把某台测试服务器的配置复制进通用安装文档。
