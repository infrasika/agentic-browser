# 在自己的服务器上部署 Agentic Browser

本指南面向部署者：从一台 Linux 服务器开始，安装完整聊天 Agent、远程浏览器、本地账号、credits 和全站预算。管理工具使用 Node.js 24+，发行包自带依赖，无需额外安装 LibreChat 或 npm 依赖。

**分发状态：当前仍是安装候选版本，完整 Agent 镜像和安装包尚未公开发布。** 以下使用已取得的可信发行包；`vX.Y.Z`、`agent.example.com` 和邮箱必须换成自己的值。不要直接拉取未发布的 GHCR 地址。自行构建见源码仓库的 `docs/BUILD.md`，Mac 和 Ubuntu 共用同一套构建命令，部署不依赖构建机密钥。目前完整流程已在 Linux amd64 验收，原生 arm64 和独立新服务器验收待完成。

## 1. 准备服务器、域名与账号

官方公网安装路径统一为：

```text
用户浏览器 → Cloudflare（HTTPS）→ 服务器 Nginx（HTTPS）
                                  → 127.0.0.1:3333 → Agent / Browser Service
                                                       └ 私有 MongoDB / Redis
```

| 准备项 | 要求 |
| --- | --- |
| Linux 服务器 | 与安装包匹配的 amd64 或 arm64；建议从 4 vCPU、8 GiB 内存、30 GiB 可用磁盘、1 个浏览器开始，另外留出备份空间 |
| CPU | amd64 需 AVX；arm64 需 ARMv8.2-A 或更高，见 [MongoDB 要求](https://www.mongodb.com/docs/manual/administration/production-notes/#platform-support) |
| 宿主软件 | Node.js 24+、flock（util-linux）、Docker Engine 26+、Compose v2/v5、Nginx；Docker 使用系统 `/var/run/docker.sock`，不使用 rootless 或远程 daemon |
| 系统用户 | 固定一个有 Docker 权限的普通用户管理安装目录；之后的 `agentctl` 也用这个用户运行 |
| 域名和 Cloudflare | 官方公网流程要求 Cloudflare 账号、已接入其 DNS 的域名、代理记录及 Turnstile widget |
| 模型账号 | Qwen 可用 API key、对应区域的模型 ID、兼容 API base URL、输入/输出费率 |
| 网络 | 可下载镜像、访问模型 API、Cloudflare 验证端点和目标网站；启用邮件时还需访问 SMTP |

Cloudflare 是官方公网流程的前置条件，不参与构建。Turnstile 有免费方案，也可独立于 Cloudflare DNS 使用；本指南统一入口是为了减少部署组合，并非 Turnstile 的技术限制。[Turnstile 方案](https://developers.cloudflare.com/turnstile/plans/)

先按 [Node.js 官方安装说明](https://nodejs.org/en/download) 安装 Node.js 24 或更新的受支持版本（使用稳定安装路径，供 systemd 定时器调用）。Ubuntu 按 [Docker 官方步骤](https://docs.docker.com/engine/install/ubuntu/) 安装 Engine 和 Compose plugin，再安装宿主工具：

```bash
sudo apt update
sudo apt install -y util-linux nginx ca-certificates curl nano
node --version
docker --host unix:///var/run/docker.sock version
docker --host unix:///var/run/docker.sock compose version
```

Docker 权限不足时按 [官方后续设置](https://docs.docker.com/engine/install/linux-postinstall/) 配置用户组并重新登录。Docker 组相当于宿主管理权限，只授予部署者；不要交替使用普通用户和 `sudo agentctl`。

云安全组和主机防火墙允许管理员 SSH、入口 TCP 80/443。3333 仅绑定本机；数据库、控制 API、CDP/VNC 均不需对外开端口。建议将源站 80/443 的来源限制为 [Cloudflare IP 段](https://www.cloudflare.com/ips/)，保留自己的 SSH 通道。

## 2. 在 Cloudflare 准备入口和 Turnstile

1. 将域名接入 Cloudflare，等待 zone 激活。添加 `agent.example.com` 的 A 记录指向服务器公网 IPv4，并启用 **Proxied（橙云）**；仅在服务器配置 IPv6 时添加 AAAA。[DNS 设置](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)
2. 在 SSL/TLS → Origin Server 创建覆盖 `agent.example.com` 的 Origin CA 证书，选择 PEM，保存证书和私钥。第 6 步装到服务器后，再启用 **Full (strict)**，不要用 Flexible。[Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)、[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)
3. 创建 Managed Turnstile widget，hostname 填 `agent.example.com`，不带协议或路径。记录 **Site key** 和 **Secret key**，后面分别填入两个文件。上线使用正式 key。[创建 widget](https://developers.cloudflare.com/turnstile/get-started/)、[hostname 规则](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)
4. 在 Cache Rules 为 `Hostname equals agent.example.com` 设置 **Bypass cache**，确保没有后续规则覆盖它。整个应用域名不缓存，避免缓存登录状态和聊天响应。[缓存规则](https://developers.cloudflare.com/cache/how-to/cache-rules/create-dashboard/)
5. 确认 Network 中 WebSockets 已启用，浏览器画面和人工输入需要它。[WebSocket 设置](https://developers.cloudflare.com/network/websockets/)

无需把 Cloudflare Global API Key、DNS 管理 token 或账号 ID 交给应用。源站证书私钥归宿主 Nginx 管理；应用只接收 Turnstile 私钥，以及启用发信时的有限权限 token。

## 3. 校验安装包并初始化

从可信发布渠道取得对应架构的 `.tar.gz` 和同目录 `SHA256SUMS`。公开发布前，由维护者提供候选包或按构建文档生成。摘要校验完整性，不替代对下载渠道的信任。

```bash
# 换成实际取得的版本，在下载目录执行
AGENT_VERSION='vX.Y.Z'
sha256sum -c SHA256SUMS
tar -xzf "agentic-browser-agent-${AGENT_VERSION}.tar.gz"
cd "agentic-browser-agent-${AGENT_VERSION}"
node bundle.mjs verify
```

`BUILD.json` 记录架构、源码和镜像身份，`release.json` 固定六个镜像。不要修改包内文件或放入个人配置，校验器会拒绝多余文件。安装数据单独放置：

```bash
AGENT_DIR="$HOME/my-agent"
node agentctl.mjs --directory "$AGENT_DIR" init --release release.json --port 3333
```

上述适用于 registry digest 包，会拉取固定镜像。公开 GHCR 镜像不需登录；私有镜像需部署用户先配置 Docker 登录。

**若收到含 `images.tar.gz` 的离线候选包**，先执行 `node bundle.mjs load-images`，再在上述 `init` 命令末尾加 `--development`，允许本机 image ID。不要先普通 `init` 再重复初始化。离线导入不表示模型和网站能离线工作；按发行说明匹配镜像存储格式。

`AGENT_DIR` 必须是不存在的新目录，安装器拒绝覆盖。初始化不需模型密钥，启动前必须配置完整。初始化后，日常使用安装目录内的工具：

```text
~/my-agent/
├── agentctl.mjs          # 管理入口
├── config/
│   ├── settings.json   # 站点、模型、额度、邮件等普通参数
│   ├── secrets.env     # 模型和登录等私密值
│   └── browser-token   # 自动生成的内部服务密钥
├── data/               # 数据库、聊天、浏览器状态、上传文件等
├── backups/            # 首次备份时创建
└── .env                # 启动时生成，供 Compose 插值；不要编辑
```

重新登录 SSH 后重新设置 `AGENT_DIR="$HOME/my-agent"`。不要删除安装目录来“重装”，数据和密钥需要保留。

## 4. 填写参数与密钥

在服务器编辑文件，不把密钥放入命令行、源码、镜像或聊天：

```bash
nano "$AGENT_DIR/config/settings.json"
nano "$AGENT_DIR/config/secrets.env"
```

**保留生成的结构和密钥，只修改对应字段。**

| 文件 | 字段 | 填什么 |
| --- | --- | --- |
| `settings.json` | `name` / `origin` | 站点名 / `https://agent.example.com`，不带路径，与 Nginx 和 Turnstile 一致 |
| `settings.json` | `adminEmail` | 管理员邮箱；管理员与普通用户共用登录页面 |
| `settings.json` | `registration` | 首次保留 `closed`，第 8 步验收后再改 `public` |
| `settings.json` | `turnstileSiteKey` | 第 2 步的 Site key |
| `secrets.env` | `TURNSTILE_SECRET_KEY` | 同一个 widget 的 Secret key，两者必须成对 |
| `settings.json` | `model.name` / `model.baseURL` | 实际可用的模型 ID / 兼容 API 根地址，通常以 `/v1` 结尾，不加 `/chat/completions` |
| `secrets.env` | `QWEN_API_KEY` | 与上述区域和接口匹配的模型密钥 |
| `settings.json` | `model.promptRate` / `model.completionRate` | 输入 / 输出的 **美元每百万 tokens** 价格，填 JSON 数字，不能保留 `null` |
| `settings.json` | `credits.initial` | 新账号一次性初始额度，默认 `200000`，约 0.20 美元；不是每天重置 |
| `settings.json` | `credits.daily` / `credits.timeZone` | 全站日预算，默认 `20000000`，约 20 美元；账期时区例如 `Asia/Shanghai` |
| `settings.json` | `browser.maximum` | 首次保留 `1`，容量验收后调整；每人 1 个，全局硬上限 10 |

计费换算是 **1,000,000 credits = 1 美元**。供应商输入价为 0.5 美元/百万 tokens 时，`promptRate` 填 `0.5`；这是单位示例，不是 Qwen 报价。人民币等币种报价先换算。预算依赖正确费率；若有未覆盖的计费项或供应商改价，应用账本不等于供应商账单，应同时设置供应商侧费用限制。

`DEMO_ADMIN_PASSWORD` 已生成随机管理员密码，可在首次启动前改为至少 12 字符的密码。`JWT_SECRET`、`JWT_REFRESH_SECRET`、`CREDS_KEY`、`CREDS_IV` 和 `browser-token` 自动生成，保留即可。以后用 `user-reset` 改密码；编辑初始密码不会重置已有账号。

私密目录 0700、配置文件 0600，编辑后保持权限。不要 `source secrets.env`，不要递归改 `data/` 权限。字段、特殊字符引用、Compose 插值和挂载关系见 [CONFIGURATION.md](CONFIGURATION.md)。

## 5. 首次启动并设置代理信任

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" up
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" doctor
curl --fail --silent --show-error -o /dev/null -w '%{http_code}\n' \
  -H 'Host: agent.example.com' http://127.0.0.1:3333/api/config
```

预期 `healthy: true` 和 HTTP `200`。这只证明内部服务可用，不代表真实模型、外部 HTTPS、Turnstile 或邮件已验收。改过 `init --port` 时，后续命令和 Nginx 同步使用该端口。

Cloudflare 到宿主 Nginx 的客户端地址由模板处理。宿主 Nginx 到 gateway 还需信任本机 Docker 网桥地址，否则限流可能把访客都识别为一个代理。在标准 Linux bridge 部署中查询：

```bash
AGENT_PROJECT=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).project' "$AGENT_DIR/installation.json")
docker --host unix:///var/run/docker.sock network inspect "${AGENT_PROJECT}_front" \
  --format '{{range .IPAM.Config}}{{.Gateway}}{{"\n"}}{{end}}'
```

在 `settings.json` 顶层添加 `"trustedProxyIPs": ["实际返回的IP"]`，注意 JSON 逗号。这里信任宿主代理进入 gateway 的地址，不填 Cloudflare 网段或访客 IP。自定义 Docker 网络需核实实际来源，重建网络后重新检查。

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" apply
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" doctor
```

`apply` 先备份，再加载新配置；有任务时需等空闲。以后改配置也用它，不编辑生成的 `.env` 或 gateway 配置。

## 6. 配置域名 HTTPS

在解压后的发行包目录操作。保存第 2 步的证书和私钥：

```bash
sudo install -d -m 700 /etc/nginx/agentic-browser
sudo touch /etc/nginx/agentic-browser/origin.pem /etc/nginx/agentic-browser/origin.key
sudo chmod 600 /etc/nginx/agentic-browser/origin.pem /etc/nginx/agentic-browser/origin.key
sudoedit /etc/nginx/agentic-browser/origin.pem
sudoedit /etc/nginx/agentic-browser/origin.key
```

分别填入完整 PEM 证书和私钥。安装包内通用模板；已有同名配置的主机先备份，避免覆盖其他站点：

```bash
sudo install -m 644 nginx.host.conf /etc/nginx/conf.d/agentic-browser.conf
sudoedit /etc/nginx/conf.d/agentic-browser.conf
sudo nginx -t
sudo systemctl reload nginx
```

把模板中**所有** `agent.example.com` 换为自己的域名，核对证书路径、回环端口及官方 Cloudflare IP 段；保留身份头清除、WebSocket、流式响应和禁用缓存设置。Nginx 校验成功后，在 Cloudflare 设置 **Full (strict)**，确认边缘证书生效：

```bash
curl --fail --silent --show-error -o /dev/null -w '%{http_code}\n' \
  https://agent.example.com/api/config
```

预期 `200`。浏览器打开该 HTTPS 地址，通过 Turnstile，使用 `adminEmail` 和初始密码登录。Origin CA 证书供 Cloudflare 连接源站，浏览器直接访问源站不信任它是正常的；通过橙云域名访问，不关闭 TLS 校验。

## 7. 启用邮件找回密码（可选）

官方示例使用 Cloudflare Email Sending，经现有 SMTP 接口接入。**Email Routing 不等于向任意用户发信。** 当前向任意收件人发送需 Workers Paid 和 Email Sending 开通，因此邮件不是首次启动的硬依赖。[Email Service 说明](https://developers.cloudflare.com/email-service/)

在 Email Service → Email Sending 验证发信域名，例如 `mail.example.com`，完成 DNS 验证。创建覆盖该账号的 **Email Sending: Edit** API token。`settings.json` 顶层增加：

```json
"smtp": {
  "host": "smtp.mx.cloudflare.net",
  "port": 465,
  "encryption": "tls",
  "from": "noreply@mail.example.com",
  "username": "api_token"
}
```

这是对象中的字段片段，注意与前一个字段间的逗号。`from` 必须使用已验证的发信域名。将 token 填到 `secrets.env` 的 `SMTP_PASSWORD`；`api_token` 是固定用户名。Cloudflare SMTP 用 465 隐式 TLS，不用 587/STARTTLS。[SMTP 参数](https://developers.cloudflare.com/email-service/api/send-emails/smtp/)

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" mail-test --to your-address@example.com
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" apply
```

先确认 `accepted: true`，再确认邮箱收到邮件。收据绑定 SMTP 配置、凭据和 origin，`apply` 后才启用 Forgot Password；改配置后需重新测试。不配置邮件时管理员仍可用 `user-reset` 恢复账号。

邮件只维护一套 SMTP 实现，已有其他邮件服务也可填其 TLS 参数，见 [运维手册](OPERATIONS.md)。不增加 Cloudflare 专用 REST 发信后端。

## 8. 验收并开放注册

先用管理员执行一个简单浏览器任务，确认真实模型能回复、Chrome 有画面、人工接管后点击 Done 能自动继续。网站密码和验证码只在远程浏览器输入。

准备开放注册时，将 `registration` 改为 `public`，空闲时执行 `apply`；缺 HTTPS 或完整 Turnstile key 会被拒绝。用另一浏览器会话注册普通账号，核对：

- 注册、登录、历史聊天正常；管理员能打开管理入口，普通账号不能访问管理功能。
- 新账号获得初始 credits，模型任务扣减额度，全站预算设置正确。
- 浏览器显示、接管和归还继续正常；并发 1 时第二个账号排队，首个任务结束后获得名额。
- 配了邮件时，普通用户收到找回链接并重置密码，旧密码不再可用。

只供自己或团队使用时保持 `closed`，交互创建用户、恢复密码。这是同一套应用的注册策略，不是另一套部署。仅本地 SSH 隧道测试可用 loopback HTTP、两把 Turnstile key 同时留空，无需 Cloudflare。

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" user-create
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" user-reset
```

## 9. 备份与后续维护

账号、聊天、额度和文件在安装目录 `data/` 中，重建容器不会清空它们；不要删除安装目录或批量清理这些卷。

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" backup
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" schedule \
  --timezone Asia/Shanghai --hour 4 --keep 7 --retry-minutes 60
```

`schedule` 生成 systemd service/timer，**还需要**按输出路径 `sudo systemctl link` 和 `sudo systemctl enable --now` 才会自动运行。轮转、异地副本、新实例恢复与升级步骤集中在 [OPERATIONS.md](OPERATIONS.md)。备份含密钥和用户数据；外层 Nginx、TLS 私钥及镜像不在数据备份内，另行保管。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| `Configuration rejected` / 启动失败 | 模型名、API 地址、费率是否仍为 `null`、管理员邮箱、密钥配对、文件权限 |
| `configuration_changed` | 空闲时用 `apply` 加载修改，不重复 `init` |
| HTTP `421` | Host 与 `settings.origin` 是否一致；本机 curl 也需正式 Host |
| Cloudflare `521` / `522` | Nginx、443 监听、安全组、Cloudflare IP 放行和 DNS |
| Cloudflare `525` / `526` | 源站证书/私钥、域名/有效期、TLS 握手和 Full (strict) |
| 登录 / Turnstile 失败 | 正式 HTTPS 域名、widget hostname、两把 key 配对、服务器验证网络；账号是否创建成功 |
| 画面断开 / 回复不流式显示 | WebSocket、代理 Upgrade/Connection、缓存和 buffering，使用附带模板 |
| 模型 `401` / 不存在 | key、区域、模型 ID、base URL 和余额；`doctor` 不付费调用模型验证 |
| 访客一起触发 IP 限流 | 两层代理信任地址，尤其是 Docker front 网桥是否重建 |
| 找回入口不显示 / 邮件未到 | token 权限、发信域名、`mail-test` 收据及 `apply`、投递日志和垃圾邮件箱 |
| `busy` / `maintenance_pending` | 等任务结束；按运维手册恢复，不删除状态文件绕过保护 |

查看容器状态和日志：

```bash
docker --host unix:///var/run/docker.sock compose --project-directory "$AGENT_DIR" \
  --env-file "$AGENT_DIR/.env" -f "$AGENT_DIR/compose.yaml" ps
docker --host unix:///var/run/docker.sock compose --project-directory "$AGENT_DIR" \
  --env-file "$AGENT_DIR/.env" -f "$AGENT_DIR/compose.yaml" logs --tail 100 agent gateway
```

日志、配置和备份可能包含私密信息，提交 issue 只提供脱敏错误和版本。

## 可选：空闲测试机安装包验收

在包目录运行 `node acceptance/verify.mjs --work "$HOME/agent-bundle-acceptance"`。仅依赖 Node.js 24+、Docker 和 flock，创建三个临时实例，使用模拟模型，真实 Chrome 访问 httpbin.org HTTP 测试页；不调用真实 LLM 或发邮件。默认占回环端口 3340/3341/3342 及约 4–6 GiB 内存，成功后清理测试容器、卷和数据，只保留报告。

覆盖初始化保护、普通账号和 credits、Chrome 接管恢复、备份与新实例恢复、升级流程、强杀备份恢复和错误镜像保护。它不替代你的 Cloudflare、真实模型、邮箱、原生架构或独立新主机验收。失败诊断可能含测试凭据，不公开上传。分发许可见包内 `LICENSES/` 及镜像。
