# 自部署预览版

## 使用固定的发行镜像

当前预览版为 `v0.1.0-preview.1`，两个 GHCR 镜像均已公开，amd64/arm64 匿名拉取验收通过；安装时无需执行 `docker login`。版本摘要见 `deploy/release.env`，验收记录见 [进度](PROGRESS.md)。

发行版通过 GitHub Actions 在原生 `linux/amd64` 和 `linux/arm64` runner 上分别构建控制器、Chrome/zkPass 运行镜像。两个平台均完成扩展、Chrome 沙箱、团队隔离、人工接管和公共容量验收后，才合并发布版本标签。Ubuntu x86_64 使用 amd64，Ubuntu ARM64 和 M 系列 Mac 的 Docker Desktop 使用 Linux arm64；不包含 32 位 ARM。

从发行页或管理员取得 `agentic-browser-deploy.tar.gz`、`SHA256SUMS`、`RELEASE.json`。发行清单记录源代码提交、两个多架构镜像 digest、Chrome/扩展锁定版本。仓库可保持私有，管理员可单独分发部署包，GHCR 镜像须公开并通过匿名拉取验证才算对外可用。

```sh
# Linux；Mac 可用 shasum -a 256 -c SHA256SUMS
sha256sum -c SHA256SUMS
tar -xzf agentic-browser-deploy.tar.gz
cd agentic-browser
cp .env.compose.example .env.compose
bash scripts/release-compose.sh pull
bash scripts/release-compose.sh up -d --wait --wait-timeout 90
bash scripts/release-compose.sh exec controller node --import tsx src/doctor.ts
bash scripts/release-compose.sh exec controller node --import tsx src/members-cli.ts create alice
```

密码在终端内隐藏输入。打开 `http://127.0.0.1:3333`，登录成员账户后创建个人 Agent 凭据；团队 MCP 配置见包内 [客户端说明](AGENT_CLIENT.md) 的发行镜像示例。此路径仅需 Docker Engine 26+、Compose 2.24.4+ 和 Bash，无需本机安装 Node、Chrome 或扩展。Mac 使用 Docker Desktop 的 Linux engine。新发行镜像的 Mac 实机结果须单独记录，不能用 Linux ARM runner 的结果替代 Mac 验收。

`deploy/release.env` 的两个镜像引用均为 `ghcr.io/infrasika/agentic-browser-*@sha256:...`。脚本拒绝仅有可变标签的发行配置，先拉取控制器和运行镜像，再沿用现有 Compose 私有数据卷与隔离配置。只给控制器挂载 Docker socket；浏览器和代理没有此权限。`.env.compose` 可设置项目名、端口和并发数，不能覆盖发行文件锁定的镜像；测试其他发行文件可设置 `AB_RELEASE_FILE=/绝对路径/release.env`。

当前源码的 `deploy/release.env` 固定到已发布的 `v0.1.0-preview.1`。较早源码版本缺少此文件时，脚本会明确报错，可从所需版本部署包复制；不使用虚构 digest。管理员如需公共演示，先复制 `.env.public.example` 为 `.env.public`，再使用 `AB_COMPOSE_VARIANT=public bash scripts/release-compose.sh up -d --wait`；真实团队使用保持默认 team 模式。

升级时保留旧部署包及其 digest 配置，先结束活动会话、停止控制器，再在同一项目名和私有卷上启动新版本。不要执行 `down --volumes` 作为普通升级步骤。旧镜像可按旧 digest 恢复，但 Chrome Profile 的跨版本降级仍需验证或恢复升级前备份。

这里的“可复现”指通过摘要部署同一份已验收镜像。源码构建的基础镜像、npm、Chrome 与扩展已锁定；Debian apt 源仍会更新，因此不宣称不同日期从源码构建会得到逐字节相同的镜像。Chrome/CRX 官方端点不保证旧文件长期存在，Actions 按锁文件使用缓存或核验下载；不匹配时失败，不能自动刷新锁绕过检查。

## 从源码构建

源码构建入口继续保留。控制服务运行在 Linux 主机上，每个 Session 的 Chrome 与镜像服务运行在独立 Docker 容器中；不要求 Mac 安装扩展。先核对 [进度记录](PROGRESS.md)，其中分别列出自动化结果和真实账号待验收项。

M 系列 Mac 使用 Linux 控制器容器和数据卷，完整 Compose 链路已在 Linux amd64 验收，Mac 实机仍待确认。请按 [Mac 部署指南](MAC_DEPLOYMENT.md) 操作；本文下方是控制服务直接运行于 Linux 宿主机的方式。

## 安装和成员初始化

要求 Linux amd64 或 arm64、Node 24、npm、Python 3、Docker、util-linux 的 flock。控制服务使用非 root 用户，该用户需有 Docker 权限。每个浏览器容器上限 2 GiB 内存和 2 CPU，另有出网代理开销；根据主机资源降低 `MAX_SESSIONS`。当前 Docker 后端不支持 Mac 原生控制服务、Windows 或 rootless Docker 的保证性兼容。

在独立目录取得源码，保留来源说明。首次构建需下载官方 Chrome 与两个扩展，包摘要必须与锁文件一致。若上游已变更，不会静默采用新包；应恢复部署者保留的旧缓存，或审核升级并重新验收。

```sh
npm ci
npm run runtime:build
npm run setup
```

`setup` 只在 `.env` 不存在时创建文件。按下面内容编辑自己的 `.env`，先设置数据目录，再建立成员；不要复制其他部署的 `.env` 或 Profile。

```dotenv
BROWSER_AUTH_MODE=team
BROWSER_MODE=docker
BROWSER_RUNTIME_IMAGE=agentic-browser:zkpass-prototype
BROWSER_NETWORK=public
BROWSER_DATA_DIR=.data
HOST=127.0.0.1
PORT=3333
PUBLIC_URL=http://127.0.0.1:3333
MAX_SESSIONS=4
MAX_SESSIONS_PER_MEMBER=2
SESSION_TTL_SECONDS=1800
SESSION_MAX_LIFETIME_SECONDS=14400
```

团队模式忽略共享 `AGENT_BROWSER_TOKEN`。如有其他管理域名或管理公网 IP，在 `BROWSER_EGRESS_DENY_HOSTS` 中逗号分隔填写；`PUBLIC_URL` 的主机名自动加入禁止出网目标。

```sh
npm run doctor
npm run members -- create alice
npm run members -- create bob
npm start
```

密码在本机终端隐藏输入。网页登录后创建个人 Agent 凭据，默认仅允许临时会话；复用保存配置需逐项授权。详见 [成员管理](TEAM_SETUP.md) 和 [Agent 接入](AGENT_CLIENT.md)。共享主机的系统管理员、Docker 管理员仍须被信任。

## 本地转发与 HTTPS

Cursor/SSH 只需转发服务端口 3333，镜像 WebSocket 使用同一端口。Mac 上打开编辑器给出的本地转发地址，例如 `http://localhost:50350`；不要把服务器内部 VNC/CDP 端口开放到公网。端口映射变化时更新 MCP 客户端的 `AGENT_BROWSER_VIEW_URL`，保留实际 HTTP API 地址。工具本身不会自动建立 SSH 隧道。

需要团队远程直连时，用可信反向代理提供 HTTPS，将 `PUBLIC_URL` 设置为实际 origin，并保留 Host、Origin 和 WebSocket 升级；控制服务仍可只监听回环地址。不要把 HTTP 明文登录入口直接公开。服务不信任客户端任意提交的转发头；入口限流需在代理侧配置。若代理统一来源 IP，应用的登录/访客限速会合并计算。

## 自动验收

完整测试需要宿主机 Chromium、Chrome/X11 依赖与已构建镜像；它们用于兼容旧模式和模拟访问镜像的用户浏览器，正常 Docker 自部署仅需上面的运行依赖。

```sh
npm run browser:install
npm run desktop:install
npm run runtime:build
docker build -f runtime/controller.Dockerfile -t agentic-browser:controller-preview .
npm run verify
```

`verify` 顺序运行类型检查、单元/API、Chromium、原生桌面、团队镜像、扩展、独立 Runtime、Compose 控制器、真实 MCP 容器链路和双访客演示。需安装 Compose；控制器验收仅给测试控制器挂载 Docker socket，并使用独立随机命名卷，结束后删除。任何一步失败即停止，记录 `output/acceptance/<UTC时间>/results.tsv` 与各项日志。测试不复用真实账号配置；公网 Runtime 测试依赖外部无凭据测试服务可达。

`npm run doctor` 是只读环境检查，不代表浏览器或真实登录流程已经通过。干净目录重新安装通过，也不等价于另一台干净主机的验收。

## 本地源码包与升级

```sh
npm run package:preview
```

输出在 `output/releases/<UTC时间>/`，包含源码归档和 `SHA256SUMS`；包内 `PREVIEW-MANIFEST.json` 记录每个源文件摘要。打包使用文件类型及目录允许清单，拒绝符号链接，排除 `.env`、`.data`、`.git`、依赖、缓存、日志与 Chrome/CRX 二进制包。该命令不上传、不发布、不创建 Git 提交。

升级前保留上一份源码归档、已验收的镜像 ID、扩展包缓存和锁文件。停止接收新任务，正常结束活动 Session 后停止服务。私有数据的备份应在浏览器和 SQLite 使用者关闭后由部署管理员保存到受限位置，不能放入发行包；本轮没有替用户制作真实数据备份。

在新目录安装依赖、构建并验收新镜像，再将 `BROWSER_RUNTIME_IMAGE` 指向审核过的镜像 ID，使用原私有数据目录启动。每个控制进程启动时把镜像标签解析为固定 ID，不会在活动 Session 中替换镜像。当前只支持实例级选择一个镜像；尚无网页模板市场或 Session 自选任意镜像。

回退代码与运行镜像不保证 Chrome Profile 可降级。先使用虚构配置测试兼容；不兼容时由所有者选择恢复升级前私有备份或创建新配置。实际跨 Chrome/扩展版本升级和回退仍待单独验收。

## 停止和移除

使用 SIGTERM 或终端 Ctrl+C 正常停止控制服务，等待浏览器及代理回收完成。异常退出后，下次启动会依据本实例标签和资源账本清理残留，不应使用全局 `docker system prune` 处理本项目。

删除源码不等于删除主动保存的登录配置。需要移除数据时，先由成员在工作台删除自己的未占用 Profile；服务器卸载由管理员确认备份保留策略后处理实例专属目录。不要删除团队共用的其他应用目录或 Docker 资源。
