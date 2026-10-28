# 完整 Agent 自部署（开发预览）

本目录提供完整 LibreChat Agent 的配置、Compose 拓扑与 `agentctl.py` 安装运维入口。它使用原生浏览器工具，不需要 MCP 客户端。当前镜像在本地构建验收；已提供候选包构建/校验工具，公开镜像与面向最终用户的安装包尚未发布。完整命令见 [私有部署运维手册](OPERATIONS.md)。

2026-10-26（北京时间）：P10.1/P10.2 同机隔离验收通过，包含真实 Chrome、普通账号权限、排队/接管自动继续、重启保留、桌面和 390px 手机布局。使用模拟模型，没有调用付费模型；这不是干净新服务器的安装验收。

两个源码项目保持独立：`agentic-browser` 提供 Browser Service、运行时和发行工具；相邻的 `librechat-agent` 提供定制聊天应用。设计和阶段状态见 [自部署计划](../../docs/plans/AGENT_SELF_HOSTING.md)。

## 配置边界

- `config/settings.json`：站点 origin/名称、管理员邮箱、Qwen 模型及费率、初始 credits、每日预算、账期时区、并发数、注册和 Turnstile 开关。
- `config/secrets.env`：模型 API key、初始管理员密码、JWT/加密密钥和可选 Turnstile secret；仅 Agent 获得此文件。
- `config/browser-token`：内部服务密钥；仅 Agent 和 Browser Service 获得。Chrome 和入口代理都不获得这些密钥。
- 私密目录为 0700，配置文件为 0600。初始化重跑不覆盖现有设置、不旋转密钥。修改 bootstrap 密码不修改数据库已有密码。
- 默认关闭注册、并发 1、每账号 1。私有模式不要求 Cloudflare。开放注册必须同时配置 HTTPS origin、Turnstile site key 和 secret。
- HTTP 仅允许 loopback origin；服务器远程访问使用 SSH 隧道，或由管理员现有反向代理终结 HTTPS。代理只信任配置的外部 origin，不采用访客伪造的身份/协议头。
- 当前支持已集成的 Qwen transport 和对应费率，地址由部署者提供。初始个人 credits 只在创建用户时使用，日预算只在首次初始化时使用；已保存的管理设置优先。

## 开发构建

Linux amd64、Docker Engine 26+、Compose v2、Python 3，以及相邻的 LibreChat 源码是构建工具的要求。最终用户目标为只运行镜像，无需源码或宿主 Node。

```bash
python3 scripts/build-agent-images.py --run --committed --tag agent-v0.2.0-rc.4
```

构建器限制为 2 CPU / 5 GiB，从 Git 已跟踪源码和本目录受控文件创建上下文，不复制本机 `.env`、`node_modules`、`.deployment`、聊天或数据库。输出本地 Agent、Browser Service 和 runtime 三个固定源码镜像，不自动上传仓库或切换公网。报告和私有构建日志在 `.deployment/agent-build/`。

Compose 的 Agent 镜像包含以下配置命令，可通过临时容器运行，无需宿主 Node：

```text
node /app/selfhost/init.mjs init /config
node /app/selfhost/init.mjs check /config
node /app/selfhost/init.mjs render /config
```

将安装目录的 `config/` 挂载到 `/config`，使用宿主文件所有者的 UID/GID。初始化故意不填写模型/key/费率，配置不完整时拒绝启动。`render` 生成精确路由的 `nginx.conf`；不要将例子的模型费率直接视为当前供应商报价。

`agentctl.py` 根据 settings 和固定版本清单自动生成 `.env`，保存项目名称、镜像引用、UID/GID、Docker socket/GID、对外端口、origin 和运行容量。不要手工编辑派生的 `.env`；修改配置后用 `apply` 在空闲时备份并重新加载。只有 gateway 发布默认回环端口，Mongo/Redis/Browser 控制端口都不发布。Docker socket 只挂载给 Browser Service。

运行时镜像应提前拉取并固定 digest；Browser Service 根据会话创建 Chrome 和 egress 容器，不在 Compose 中启动共用 Chrome。运行时只挂载本会话的卷子目录。

## 隔离验收

```bash
node --test test/agent-deployment.test.mjs
node scripts/accept-agent-compose.mjs --run --release /path/to/release.json
python3 -m unittest discover -s test -p test_agent_operations.py
node scripts/accept-agent-operations.mjs --run --release /path/to/release.json
```

验收使用唯一 Compose project、新数据库/数据卷、回环 3334，以及不收费的模拟模型；真实 Chrome 访问带固定标记的 httpbin.org HTTP 测试页。模型模拟不代替真实供应商兼容性验收。完整流程包括关闭注册、管理员和普通用户登录/权限、原生工具、跨账号隔离、满额排队、输入 WebSocket、归还自动继续、预算与重启保留。结束清理本次专用容器/卷，生产进程应保持不变。

`--hold` 在流程通过后保留实例供界面检查；SIGTERM 后执行清理。失败诊断保存在本次 `.deployment/agent-acceptance/UUID/`，公开报告只有检查结果。不要把测试配置复制到公网站点。

## 尚未交付的范围

安装、普通账号创建/密码恢复、通用 TLS/STARTTLS SMTP、Compose 停写备份/新实例恢复及同拓扑镜像升级由 `agentctl.py` 提供。`schedule` / `maintain` 提供私有实例专属定时备份、轮转、受控目录副本和普通备份中断恢复，独立于公网 P9 备份。验收状态以开发计划为准。

独立新主机安装/恢复、实际跨版本数据库升级和公开发行仍未完成。目录副本支持受控远程挂载，但尚未配置和验证真实异地存储；也未对整台宿主执行重启/断电测试。会话登录状态不跨会话保留。

候选包制作和独立测试机验收见 [发行准备](RELEASING.md)；包内用户入口为 [安装说明](INSTALL.md)。候选版尚未构成公开发行。


构建、验收和交付状态统一记录在 [进度](../../docs/plans/LIBRECHAT_PROGRESS.md)。每次源码变更后重新生成候选包并验收，不能直接沿用先前包的通过报告。
