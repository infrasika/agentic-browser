# 在自己的服务器部署 Agentic Browser

本指南安装完整聊天 Agent、同屏浏览器、本地账号、credits 和全站预算。服务器只需 Docker / Compose，无需源码、Node.js、npm 或独立 MCP。公网步骤使用 Cloudflare + Nginx，自用可通过 SSH 隧道访问并关闭注册。

本文对应包含 `ops` 服务的新发行文件。使用同一版本 Release 的文件和镜像；preview.10 及更早发行物缺少新运维入口。当前发布进度见源码仓库的 `docs/STATUS.md`。

## 1. 准备服务器

| 项目 | 要求 |
| --- | --- |
| 系统 | Linux amd64 / arm64，本机系统 Docker daemon，socket `/var/run/docker.sock` |
| CPU | amd64 需 AVX；arm64 需符合 MongoDB 平台要求 |
| 起步资源 | 建议 4 vCPU、8 GiB 内存、30 GiB 可用空间，从一个浏览器开始，另留备份空间 |
| 容器工具 | Docker Engine 26+、Compose plugin v2/v5；新机安装当前受支持版本 |
| 模型 | 可用模型 ID、兼容 API 根地址、API key、输入和输出费率 |
| 公网服务 | Cloudflare 管理的域名及服务器 IP；开放注册需要 Turnstile，邮件可选 |

按 [Docker Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) 安装 Engine 和 Compose plugin，确认部署用户可以访问 Docker。浏览器服务通过 socket 创建 Chrome 容器，使用可信管理员账号；不使用 rootless 或远程 daemon。CPU 要求参见 [MongoDB 平台说明](https://www.mongodb.com/docs/manual/administration/production-notes/#platform-support)。

```bash
docker version
docker compose version
docker info --format '{{.OSType}} / {{.Architecture}}'
```

服务器需访问镜像仓库、模型接口和目标网站。公网安装另装 Nginx，例如 Ubuntu 的 `sudo apt install nginx`。

## 2. 下载同一版本的部署文件

从 [GitHub Releases](https://github.com/infrasika/agentic-browser/releases) 选择已通过验收的版本，把该版全部附件下载到空目录，包括 SHA256SUMS。仓库私有期间需要仓库访问权限；公开镜像拉取无需登录。

```bash
mkdir -m 700 "$HOME/my-agent"
cd "$HOME/my-agent"
# 将选定 Release 的全部附件下载到这里，然后核对：
sha256sum -c SHA256SUMS
chmod 600 secrets.env
```

最小运行文件为 `compose.yaml`、`settings.json`、`secrets.env`；指南、nginx.host.conf、许可证和报告可保留。不要直接使用源码 compose.template.yaml，它包含待发布工具填写的镜像占位符。

## 3. 填写两份配置

```bash
nano settings.json
nano secrets.env
```

| 位置 | 首次必填内容 |
| --- | --- |
| settings → `adminEmail` | 管理员邮箱 |
| `model.name`、`model.baseURL` | 模型 ID 和 API 根地址，通常以 `/v1` 结尾，不加 `/chat/completions` |
| `model.promptRate`、`model.completionRate` | 输入/输出美元每百万 tokens 价格，填数字 |
| `origin` | 自用保持 `http://127.0.0.1:3333`；公网填自己的 HTTPS 域名 |
| secrets → `QWEN_API_KEY` | 与模型、区域和接口匹配的密钥 |
| `DEMO_ADMIN_PASSWORD` | 至少 12 字符的首次管理员密码，保存到密码管理器 |

首次保持 `registration: closed`、`browser.maximum: 1`。未启用 Turnstile 时公私钥同时留空。每账号最多一个会话，全局可设 1–10。字段、费率换算和配置位置见 [配置参考](CONFIGURATION.md)。

管理员密码只用于首次建号；应用登录/加密密钥由容器自动生成并持久保存。新 clone 只构建镜像时无需填写这些值，也不需要复制本站配置。

## 4. 启动并验证本地入口

在部署目录新建 `.env`，明确项目名，后续查询网络时使用同一个名字：

```dotenv
COMPOSE_PROJECT_NAME=my-agent
AGENT_PORT=3333
AGENT_BIND=127.0.0.1
```

```bash
docker compose up -d
docker compose ps -a
docker compose logs --tail 50 init
docker compose run --rm ops status
```

首次会拉取六种镜像并初始化。`init`、`runtime-image` 成功后显示 `Exited (0)`，其他主服务运行，status 返回 `healthy: true`。ops 按需运行，backup 在后面启用。数据库、浏览器控制 API 不发布外部端口。

自用时在自己的电脑执行：

```bash
ssh -L 3333:127.0.0.1:3333 USER@SERVER
```

保持连接，打开 `http://127.0.0.1:3333`，用管理员邮箱和密码登录。纯自用可跳到第 7 步，Cloudflare 不是本地运行的硬依赖。

## 5. 公网域名与 Cloudflare

流量路径为 Cloudflare HTTPS → 宿主 Nginx HTTPS → `127.0.0.1:3333` → Compose gateway。

1. 创建域名 A 记录指向服务器 IP，开启代理；服务器实际提供 IPv6 时才添加 AAAA。
2. 准备覆盖该域名的源站证书和私钥。已有有效证书直接复用，否则可在 SSL/TLS → Origin Server 创建 Origin CA 证书。边缘证书用于访客到 Cloudflare，源站证书用于 Cloudflare 到服务器。
3. 允许服务器 443 入站，确认 Cloudflare WebSocket 开启；不要对聊天、API 和浏览器连接设置缓存规则。

先在服务器配置证书和 443，再将此应用切到 Full (strict)。源站证书须有效且覆盖目标域名，可以由受信任 CA 或 Cloudflare Origin CA 签发。[Full (strict) 要求](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

## 6. 配置 Nginx 与客户端 IP

查询前端网桥 IP，项目名与 `.env` 一致：

```bash
docker network inspect my-agent_front \
  --format '{{range .IPAM.Config}}{{.Gateway}}{{"\n"}}{{end}}'
```

把实际结果填入 settings 顶层，如 `"trustedProxyIPs": ["172.20.0.1"]`。这是宿主代理进入 Docker 的来源 IP，不是 Cloudflare 网段或访客地址。初装尚无任务时保存配置后执行：

```bash
docker compose stop
docker compose up -d --force-recreate
docker compose run --rm ops status
```

保留网络可保持网桥地址稳定；若删除并重建网络，应重新核对。

将证书和配套私钥放入自己的 Nginx 证书目录，私钥权限 0600。新站点可用以下路径；已有证书在模板里引用现有路径，不覆盖它：

```bash
sudo install -d -m 700 /etc/nginx/agentic-browser
sudo install -m 600 /你的证书路径/origin.pem /etc/nginx/agentic-browser/origin.pem
sudo install -m 600 /你的私钥路径/origin.key /etc/nginx/agentic-browser/origin.key
sudo install -m 644 nginx.host.conf /etc/nginx/conf.d/agentic-browser.conf
sudoedit /etc/nginx/conf.d/agentic-browser.conf
```

将模板里的 `agent.example.com` 全部换成自己的域名，证书路径和 upstream 端口与实际一致。核对 [Cloudflare IP 范围](https://www.cloudflare.com/ips/)，保留身份头清除、WebSocket、流式响应和禁用缓存设置。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

只在校验成功后重载，然后将此应用切为 Full (strict)。替换域名后验证：

```bash
curl --fail --silent --show-error -o /dev/null -w '%{http_code}\n' \
  https://agent.example.com/api/config
```

预期 200。登录地址必须与 settings 的 origin 一致。不要把 Compose 或数据库端口另行开放到公网。

## 7. 注册策略、邮件与功能验收

**自用 / 团队：保持 `registration: closed`。** 关闭公开注册，已有用户仍可登录。普通账号用 `ops user-create` 创建，见 [运维指南](OPERATIONS.md)。管理员与普通用户共用登录页，权限由角色决定。

**公开体验：** 在 Cloudflare Turnstile 创建 widget，将正式域名加入 hostname；Site key 填 turnstileSiteKey，Secret key 填 TURNSTILE_SECRET_KEY，然后将 registration 改为 public。按运维指南停写、重建使配置生效。项目已包含前后端验证，无需编写 Worker。[Turnstile 设置](https://developers.cloudflare.com/turnstile/get-started/)

邮件可选。Cloudflare Email Sending 的 SMTP 配置、测试收件与找回密码步骤见运维指南；没有邮件也可用服务器命令重置账号。

最后在自己的浏览器验收：

- 登录执行 Demo，确认远程画面、人工接管、点击 Done 后自动继续。
- 网站密码和验证码在远程浏览器输入，不放进聊天；核对最终结果。
- 开放注册时用普通账号核对初始 credits、真实调用扣费、聊天历史及管理权限隔离。
- 在管理员入口核对全站日预算；默认约 20 美元/天，记账依赖填写的费率。
- 启用邮件时确认实际收到邮件，并完成一次密码找回。

## 8. 启用备份

任务空闲时执行：

```bash
docker compose run --rm ops backup
docker compose --profile backups up -d backup
docker compose logs --tail 20 backup
```

默认每天 Asia/Shanghai 04:00 后空闲时备份，保留最近 7 份。修改计划、恢复和升级见 [运维指南](OPERATIONS.md)。备份在部署目录 backups/，业务数据在专属 Docker 命名卷。

**不要执行 `docker compose down -v` 或 `--volumes`，它会删除数据库和身份密钥。** 容器重建保留数据卷。失败先看 init 日志和 ops status，修正字段后重建；已有站点先保留数据和备份，不以删除卷来修复。
