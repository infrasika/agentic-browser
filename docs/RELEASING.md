# 发布镜像与部署文件

维护者从 [构建](BUILD.md) 得到三种项目镜像，再发布到 GHCR，交付同版本的 Compose 和配置模板。用户服务器只需 Docker / Compose，发布不需要站点密钥。项目采用 [MIT](../LICENSE)，镜像保留第三方组件的适用许可证。实际发布状态见 [STATUS](STATUS.md)。

## 推荐：GitHub Actions

1. 在开发分支更新 package.json 和 lockfile，例如 `npm version 0.1.0-preview.11 --no-git-tag-version`；使用尚未发布的实际版本。
2. 提交、推送并创建 PR。源码检查通过后合并到 `main`，确保远程包含本次版本和修改。
3. 本机安装 GitHub CLI 并完成 `gh auth login`，在仓库根目录运行：

```bash
npm run release -- --dry-run
npm run release
```

命令从 package.json 读取版本，触发远程 `main` 的 `Publish Agent preview` 工作流。本机可以处于 `feature`，但待发布改动必须已合并到远程 main。它不自动提交、推送、修改版本或在本机构建。显式版本可用 `npm run release -- vX.Y.Z-preview.N`；工作流只允许 `main`，当前仅接受 preview 版本格式。

流水线依次执行：

1. Ubuntu amd64 / arm64、macOS 的源码和类型检查。
2. 原生 Linux 双架构分别构建，校验镜像与源码报告，推送架构候选。
3. 合并不可变多架构索引，生成六镜像 `release.json`，包括固定的官方 Nginx、MongoDB、Redis。
4. 两个全新原生 Linux runner 分别匿名拉取全部镜像，运行 Docker-only 完整验收。
5. 核对版本、源码提交、镜像、架构和清理结果，生成部署文件、摘要及 GitHub 预发布。不更新 `latest`。

验收使用真实 Chrome、本地模型和 TLS 邮件模拟服务，覆盖账号隔离、排队、接管恢复、credits、预算、登出清理、密码找回、持久化、备份恢复、失败升级回退和每日备份。部署子进程 PATH 只有 Docker；测试驱动本身运行在维护者的 Node 环境。真实供应商、域名、Turnstile 和实际收件效果仍需在目标部署验收。

仓库需允许 Actions 的 `contents:write`、`packages:write` 权限。镜像包需在 GitHub Packages 中设为 Public，才能通过匿名拉取验收；私有仓库的 Release 下载仍需仓库权限。源码与镜像可见性是独立设置。

工作流可从先前成功构建阶段复用 `build_run_id`，用于修复验收或发行工具后重跑；它仍会比较全部镜像输入。应用、依赖、Dockerfile 或镜像内运维代码变化必须重新构建。不要编辑构建报告绕过检查。

## 手动发布：Mac 或 Ubuntu

先完成 `--committed` 双架构三镜像构建。变量替换为真实值，输出目录必须尚不存在：

```bash
AGENT_VERSION='v0.1.0-preview.11'
BUILD_DIR="$PWD/output/build/build-实际目录"
PUBLISH_DIR="$PWD/output/releases/$AGENT_VERSION"
```

报告和对应镜像必须同时存在于当前 Docker daemon。确保 Docker 已登录 `ghcr.io`，优先复用 Docker Desktop / 系统凭据库。新登录使用适当的 GitHub Packages 凭据，通过交互或 `--password-stdin` 输入，不把 Token 写进源码、站点配置或命令行历史。

先查看发布计划，不上传：

```bash
npm run publish:agent -- \
  --build-report "$BUILD_DIR/amd64/report.json" \
  --build-report "$BUILD_DIR/arm64/report.json" \
  --version "$AGENT_VERSION" --namespace YOUR_GITHUB_OWNER
```

确认后上传并验证匿名拉取：

```bash
npm run publish:agent -- \
  --build-report "$BUILD_DIR/amd64/report.json" \
  --build-report "$BUILD_DIR/arm64/report.json" \
  --version "$AGENT_VERSION" --namespace YOUR_GITHUB_OWNER \
  --run --output "$PUBLISH_DIR"
npm run publish:agent -- --verify-public "$PUBLISH_DIR/release.json"
```

三个项目包分别为 `agentic-browser-agent`、`agentic-browser-service`、`agentic-browser-runtime`。官方基础服务不重新打包。输出的 release.json 保存不可变镜像引用，publication.json 保存发布证据；上传成功不代表独立主机验收已完成。

## 验收与交付

在目标架构的原生 Linux 测试机取得本次源码和发行清单，执行：

```bash
npm ci
npm run accept:compose -- \
  --release /absolute/path/to/release.json \
  --work "$PWD/output/tests/release-实际版本" --port 3350
```

工作目录必须是新目录，3350、3351 需空闲；维护者测试机需 Docker、Compose、OpenSSL 和约 6 GiB 可用内存。验收与已有站点隔离，不调用付费模型或外部邮件。两个平台分别核对 report.json 的 `passed`、`cleanup.passed`、版本、架构和镜像。QEMU 构建不能代替原生运行验收。

生成通用部署目录：

```bash
npm run package:compose -- \
  --release "$PUBLISH_DIR/release.json" \
  --output "$PWD/output/delivery-$AGENT_VERSION"
```

输出包含 compose.yaml、settings.json、secrets.env、nginx.host.conf、部署/配置/运维指南和 LICENSE。工具从当前 checkout 读取模板与指南，因此先提交并检查交付源码；正式流水线使用对应 GitHub 提交。镜像来自发行清单，工具拒绝可变标签或覆盖已有目录。

正式 Release 还需附上 release.json、publication.json、两平台匿名拉取及验收报告，并对全部文件生成 SHA256SUMS。推荐使用 Actions 完成最终收集和发布。不要把填写过的用户配置、测试目录、备份或本机数据加入 Release。

不再交付需要宿主 Node 的安装归档。部署者从 [部署指南](DEPLOYMENT.md) 开始，后续升级使用 [运维指南](OPERATIONS.md) 的 `ops upgrade`。镜像中的 ops 已携带依赖及许可证，服务器无需 npm 安装。
