# 发布镜像与安装包

先按 [构建指南](BUILD.md) 从同一已提交源码生成两份完整构建报告，并完成对应架构验收。构建机可用 Mac 或 Ubuntu；部署目标是 Linux。发布使用 Docker 的 registry 凭据，不读取站点密钥。当前分发状态见 [STATUS.md](STATUS.md)。

以下 `infrasika`、版本号和 `build-EXAMPLE` 仅为命令示例，请替换为自己的 namespace、新版本与真实构建目录。

## 发布前验收

两平台必须是相同源码的完整三镜像构建，报告为 `passed: true`、`sourceMode: committed`。源码变动先提交；打包器从当前 Git HEAD 读取工具和文档，并检查镜像输入与构建报告一致。安装文档变更可以单独重新打包，程序或镜像内分发声明变更则必须重新构建。

上传前可生成离线候选包，在匹配架构的空闲 Linux 主机验收：

```bash
npm run package:agent -- \
  --build-report output/build/build-EXAMPLE/amd64/report.json \
  --version v0.2.0-rc.8 \
  --output output/agent/candidates/v0.2.0-rc.8-amd64
npm run accept:bundle -- \
  --bundle output/agent/candidates/v0.2.0-rc.8-amd64/agentic-browser-agent-v0.2.0-rc.8 \
  --work output/tests/bundle-v0.2.0-rc.8-amd64
```

需要完整业务和邮件运维验收时，使用候选包的 `release.json`，按 [开发指南](DEVELOPMENT.md) 运行 `accept:agent` 和 `accept:agent-ops`。在另一台服务器验收时，先按包内 README 校验归档和导入镜像，再运行包内 `acceptance/verify.mjs`。多架构可构建不代表两种架构均已完成运行验收。

## 1. 使用 Docker 已有授权发布 GHCR

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
  --version v0.2.0-rc.8 --namespace infrasika
```

验收后上传，在上面命令末尾加：

```text
--run --output output/agent/ghcr/v0.2.0-rc.8
```

工具要求两平台来自同一源码，检查镜像标签和身份，先上传带 `-amd64` / `-arm64` 的固定架构标签，再生成同一个 `v0.2.0-rc.8` 多平台标签。逐一校验实际上传的镜像与最终 index，成功后生成含六个固定 digest 的 `release.json` 及发布回执。部署时 Docker 按主机架构选取对应子镜像。

已有版本指向不同内容时拒绝覆盖；相同内容可重试。跨仓库发布不是事务，同一 namespace 同时只允许一个发布进程。不会移动 `latest`。部分成功后请使用原镜像和报告重试，不要重建后覆盖同版本。

新 package 默认私有。需要公开分发时在 GitHub Packages 设置可见性，再验证两种架构的匿名拉取：

```bash
npm run publish:agent -- \
  --verify-public output/agent/ghcr/v0.2.0-rc.8/release.json
```

## 2. 生成安装包

安装包按目标架构生成，使用对应的报告；同一个 registry 版本标签包含两种架构。

```bash
npm run package:agent -- \
  --build-report output/build/build-EXAMPLE/amd64/report.json \
  --version v0.2.0-rc.8 \
  --release output/agent/ghcr/v0.2.0-rc.8/release.json \
  --output output/agent/releases/v0.2.0-rc.8-amd64
```

ARM 包改用 `arm64/report.json` 与另一输出目录。不传 `--release` 则生成包含六镜像归档的离线候选包；传入时生成轻量包、固定清单和安装工具。Node 管理工具与依赖编译成独立文件，并附带 `LICENSES/TOOLS.txt`；部署者无需源码或 `npm install`。所有工具/文档来自 Git HEAD 白名单，不包含任何部署目录。打包不发布镜像或更改站点。

将匹配架构的安装包放到 Linux 服务器，按 [部署指南](DEPLOYMENT.md) 校验、`init`、填写 `config/settings.json` 与 `config/secrets.env`、`up`、`doctor`。宿主数据位于安装目录 `data/`；生成的 `.env` 只用于 Compose 插值。升级和备份见 [运维指南](OPERATIONS.md)。

独立新服务器、原生 ARM64 全流程、真实版本升级/恢复、匿名下载与拉取均应记录到版本验收结果；旧版本验收不能代替新构建的证据。

## 在 GitHub 原生 runner 验收

`.github/workflows/accept-agent-bundle.yml` 使用全新的 Linux runner，只下载离线候选包，不 checkout 源码、不安装 npm 依赖、不构建镜像。它调用包内同一套验收工具，使用模拟模型，保留汇总报告。

1. 将工作流推送到 GitHub 默认分支，使手动运行入口可用；待验收的工作流分支可在运行时选择，参见 [手动运行工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。
2. 将**完整离线包**上传到受信任的 HTTPS 下载地址。不要传入不含镜像的 registry 轻量包；这里验证的是离线完整安装路径。
3. 在 Actions 中选择该工作流，分别运行两次：`architecture: amd64` 对应 `ubuntu-24.04`，`architecture: arm64` 对应 `ubuntu-24.04-arm`。分别填写该架构的 `bundle_url` 和从可信发布渠道取得的 `sha256`。不要在 URL 中携带密钥或短期签名，它属于工作流输入；尚未公开的包可在受控独立主机按包内命令验收。
4. 下载对应的 `complete-agent-candidate-acceptance-amd64` / `-arm64` artifact，核对 `host-evidence.json`、`BUILD.json`、`release.json` 和 `report.json` 的架构、源码提交、归档摘要、`passed` 与 `cleanup.passed`。

工作流在导入镜像前检查宿主、Node、Docker daemon 和六个镜像的平台是否一致，拒绝把 QEMU 构建或其他架构误记为原生运行验收。两个平台各自执行，不能用其中一次成功代替另一次。runner 标签和仓库可用性见 [GitHub 官方说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)。工作流准备好不代表已经执行，仓库权限、Actions 配额和下载渠道需要发布者提供。

## 3. 发布下载渠道

安装包工具只生成本机产物，镜像发布工具只上传 GHCR；两者不会自动创建 GitHub Release。维护者还需在可信发布渠道提供每个已验收架构的 `.tar.gz`、同目录 `SHA256SUMS`、版本说明和验收范围。不同架构的归档文件名相同，应放在分别标明 `amd64/`、`arm64/` 的下载目录，不能在同一个目录互相覆盖。

版本说明应列出源码提交、镜像摘要、宿主依赖、支持架构、已验收流程和升级限制，并指向包内 README。从无 registry 登录的环境重新下载并校验包，再验证镜像匿名拉取。首次公开发布前确认项目主许可证，保留 [第三方分发声明](DISTRIBUTION-NOTICES.md)、上游及依赖许可证。包内不应包含安装配置、模型密钥、登录档案、聊天或用户数据。
