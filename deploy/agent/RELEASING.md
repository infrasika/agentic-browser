# 完整 Agent：构建、GHCR 发布与部署交付

当前完整 Agent 为 `v0.2.0-rc.6`、Linux amd64 候选版。按维护者要求，Ubuntu 测试服务器只准备源码、脚本和文档，**不在这里上传镜像或触发发布**。以下发布命令留待维护者在自己的 Mac 执行；这里的 GHCR 地址是计划目标，不代表已经发布。旧 MCP 产品的镜像与 `latest` 不应作为完整 Agent 的安装入口。

## Mac 准备

需要 Git、Python 3.12+ 和运行中的 Docker Desktop（Linux containers、Buildx）。构建/打包/发布使用当前 Docker context，不强制连接 Ubuntu 的 socket 路径。代码测试另需 Node 24。构建器使用 2 CPU / 5 GiB；给 Docker VM 留出额外系统资源和磁盘空间。

构建目标固定为 `linux/amd64`。Apple Silicon 上需要 amd64 模拟，构建可能明显较慢；**完整 Agent 在 Mac / arm64 的本地运行尚未验收**。当前安装器面向 Linux amd64，不能把“Mac 上构建成功”当成“Mac 本地部署受支持”。可以从 Mac 构建发布，再将安装包交给 Linux amd64 服务器部署。

准备两个相邻仓库：

```text
workspace/
  agentic-browser/       # Browser Service、runtime、构建/安装工具
  librechat-agent/       # 定制 LibreChat，不是上游原版
```

**只 clone 上游 LibreChat 不够。** 当前定制仓库的 origin 仍指向上游，定制提交 `0d7ee88b4fa9259b5176772968f8a29925348a01` 只在本地；需取得包含该提交的私有 fork 或源码移交包。本轮准备的 `agent-mac-handoff.tar.gz` 含两个仓库的 Git 源码快照、已锁定浏览器资源和无密钥构建报告（Browser 使用 Git bundle，浅克隆的 LibreChat 使用保留 shallow 边界的裸仓库）；它是私密源码交付，不是公开安装包。解压后先校验 `shasum -a 256 -c SHA256SUMS`，再执行包内 `README.md` 的 clone 命令。无需复制 Ubuntu 的 `.deployment`、业务配置或数据。

若通过 Git clone 获取源码，确认当前工作分支、安装工具提交和定制 LibreChat 提交都已在对应远端；本轮不会自动 push 到 GitHub。

## 源码与镜像

两个仓库分别保留提交历史。Agent 镜像由 LibreChat 提交加 Browser 仓库的 `deploy/agent/app` 构建，Browser Service 和 runtime 来自 Browser 仓库。先提交源码，再构建：

```bash
python3 scripts/fetch-runtime-assets.py --arch amd64
python3 scripts/build-agent-images.py --run --committed --tag agent-v0.2.0-rc.6
```

Mac 必须显式指定 `--arch amd64`，避免按照本机架构下载错误资源。资源读取只依赖 Python，无需 macOS 安装 `dpkg-deb`。移交包自带 `output/runtime/packages/` 缓存；上游滚动下载地址若已改变，将按 SHA-256 拒绝，不能用 `--refresh-lock` 绕过。浏览器资源更新应作为单独版本审核。

一次完整构建生成 Agent、Browser Service 和 runtime 三个镜像，使用独立 2 CPU/5 GiB buildx builder。`--committed` 读取 Git 对象，不使用工作区修改、未跟踪文件或先前编译产物。Chrome/扩展资源复制前逐项核对已提交 lock 的 SHA-256。基础镜像按 digest 固定；APT/npm 上游仍是网络依赖，完整重建不等于字节级可复现构建。

构建报告记录三镜像的本机 ID、两个源码提交及运行时资源摘要。只有 `passed: true`、`sourceMode: committed` 且三镜像完整的报告可以进入打包。镜像标签可变，验收和包内引用均使用固定 ID 或 registry digest。

**构建会生成新的 report.json。** 不要拿 Ubuntu 的镜像 ID 报告指认 Mac 上重新构建的镜像。若直接从 rc.6 离线包导入同一组镜像，应先运行包内校验和 `load-images`，并确认 Docker 29 containerd image store 与源端一致。

## 发布前验收

```bash
npm ci
npm run check
npm test
npm run test:python
node scripts/sync-browser-contract.mjs ../librechat-agent --check
```

构建后生成离线候选包，在 Linux amd64 测试机按包内 `acceptance/verify.py` 完成安装、人机交接、备份恢复和错误升级验收。仅测试脚本和镜像构建通过不能代替完整验收。新构建重新验收；旧 rc.6 的报告不能直接证明另一台机器的新构建。

## GHCR 上传：使用 Mac 已有登录

| 组件 | 计划镜像仓库 |
| --- | --- |
| Agent | `ghcr.io/infrasika/agentic-browser-agent` |
| Browser Service | `ghcr.io/infrasika/agentic-browser-service` |
| Chrome runtime | `ghcr.io/infrasika/agentic-browser-runtime` |
| Gateway / Mongo / Redis | 官方仓库，固定 digest，不复制发布 |

发布脚本读取 Docker 的既有 `credHelpers` / `credsStore`，支持 Docker Desktop / `osxkeychain`；只请求 `ghcr.io` 凭据，Token 留在内存，不创建 `publish.env` 或修改凭据存储。Git 的 Keychain 登录与 Docker GHCR 登录不是同一项；若 Docker 尚未登录，需要先完成 GHCR 的 Docker 登录。不要把 Git OAuth 令牌当作 GHCR PAT。GitHub Actions 则可使用仓库 `GITHUB_TOKEN`，不必在服务器保存个人发布 Token。[GitHub 官方认证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry)

先在 Mac 只读预检，使用**本次构建输出的报告路径**：

```bash
python3 scripts/publish-agent-images.py \
  --build-report .deployment/agent-build/BUILD_DIRECTORY/report.json \
  --version v0.2.0-rc.6 --namespace infrasika
```

未加 `--run` 时不访问凭据、不登录、不拉取或推送镜像。确认本次候选验收通过后，在 Mac 显式上传：

```bash
python3 scripts/publish-agent-images.py \
  --build-report .deployment/agent-build/BUILD_DIRECTORY/report.json \
  --version v0.2.0-rc.6 --namespace infrasika \
  --run --output output/agent/ghcr/v0.2.0-rc.6
```

同一 namespace 同时只运行一次发布。脚本检查三个目标标签：已指向相同镜像时可恢复执行，指向不同内容时拒绝；认证/网络错误不会被当成标签空缺。每个镜像上传后按 digest 拉回并核对本机身份，全部成功才写 `release.json` 与 `publication.json`。跨仓库推送不是事务；中途失败可能已有部分镜像上传，可用原构建重试，不能重建后覆盖同版本。新内容使用新版本号。本候选流程不移动 `latest`。

新 GHCR package 默认私有。在 GitHub Packages 设置中按需要将这三个镜像设为 Public，源码仓库仍保持私有；Agent 与 Service 若缺少仓库关联，可在 package 设置关联源仓库。之后验证匿名访问：

```bash
python3 scripts/publish-agent-images.py \
  --verify-public output/agent/ghcr/v0.2.0-rc.6/release.json \
  > output/agent/ghcr/v0.2.0-rc.6/anonymous-pull.json
```

此命令使用空 Docker 凭据配置，保留当前本机 Docker socket，检查实际匿名 pull 权限。已缓存层不等于全新主机下载验收；独立主机检查仍需单独完成。[Package 可见性说明](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)

## 生成可部署的安装包

先提交安装工具与文档，再打包；打包器同样从 Git HEAD 的固定白名单读取，不从整个工作目录复制：

```bash
python3 scripts/package-agent.py \
  --build-report .deployment/agent-build/BUILD_DIRECTORY/report.json \
  --version v0.2.0-rc.6 \
  --output output/agent/releases/v0.2.0-rc.6
```

默认生成带六个镜像的离线候选包，以及外层/内层 SHA256SUMS、源码/工具提交清单、安装器、运维/安装手册、纯 Python 验收脚本和许可。镜像 archive 使用本机 image ID，导入后显式 `--development` 安装；不会将 ID 冒充 registry digest。包内 Mongo/Redis 也固定 ID，不依赖目标机已有仓库缓存。

新构建机缺少 gateway/Mongo/Redis 时，打包器按固定的官方 digest 拉取这三个依赖；应用镜像缺失会直接失败，必须先完成构建或导入已验收镜像。

已发布镜像后生成不含镜像归档的轻量包：

```bash
python3 scripts/package-agent.py \
  --build-report .deployment/agent-build/BUILD_DIRECTORY/report.json \
  --version v0.2.0-rc.6 \
  --release output/agent/ghcr/v0.2.0-rc.6/release.json \
  --output output/agent/registry-releases/v0.2.0-rc.6
```

清单必须有 version 与 agent/browser/runtime/gateway/mongo/redis 六个不可变 registry digest；本机检查实际镜像身份与构建报告一致。打包器不上传镜像、创建 Git tag、发布 GitHub Release 或更改当前站点。`BUILD.json` 的 `published: false` 表示安装包本身尚未上传，镜像发布证据另见 `publication.json`。

将轻量包和外层 SHA256SUMS 交给 Linux amd64 部署者，依次校验、解压、`init`、填写配置、`up`、`doctor`；完整命令见 [INSTALL.md](INSTALL.md)，字段含义见 [CONFIGURATION.md](CONFIGURATION.md)。后续升级使用新包的工具与固定清单，见 [OPERATIONS.md](OPERATIONS.md)。公开镜像不自动使私有仓库的 Release 附件公开，安装包下载渠道需要单独安排。

`BUILD.json` 的应用源码提交与安装工具提交允许不同：安装工具/Compose/文档不烘焙进应用镜像。更改 `deploy/agent/app`、应用或 runtime 后必须重新构建对应完整镜像组，不能仅更新工具提交来掩盖陈旧镜像。

## 验收与发布门槛

1. 配置、运维和包边界测试通过；安装包文件校验通过。
2. 解压后的包独立完成安装、普通用户/credits、真实 Chrome、接管/自动继续、定时备份/新实例恢复、升级程序演练和资源清理；强杀备份进程及注入错误升级镜像，验证自动恢复与备份回退。模拟模型不产生真实供应商费用，也不证明供应商兼容性。
3. 在独立干净 Linux amd64 机器重复上述验收，记录机器来源、Docker/Compose/Python 版本、六镜像身份及清理结果。现有宿主的新 Compose project 不能算新机器。
4. 对实际前后两个发行版本做升级/恢复验收；同一镜像的版本号演练只能证明操作流程。
5. 确定公开镜像仓库、固定版本标签及安装包的可下载位置后发布；匿名拉取/下载后重新校验。当前源码仓库私有，GitHub Release 附件不能被当作匿名下载入口。

候选包可以先交给测试机验收。未完成门槛时保持 candidate 状态，不把未发布的地址写成可用下载链接。

可选 `.github/workflows/accept-agent-bundle.yml` 在 GitHub 的全新 Ubuntu runner 执行同一验收，输入可信 HTTPS 候选包地址与 SHA-256；不 checkout 源码、不 setup Node、不构建镜像。测试 PATH 只提供 Python/Docker，报告单独记录 runner 来源。该 workflow 已准备但尚未推送或执行；需先提供测试机可下载的候选包位置，不能把“已写 workflow”当作通过证据。
