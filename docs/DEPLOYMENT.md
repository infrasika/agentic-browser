# 在自己的服务器上部署 Agentic Browser

本指南从一台 Linux 服务器开始，安装完整的聊天 Agent、同屏远程浏览器、本地账号、credits 和全站预算。应用、MongoDB、Redis 等都运行在 Docker 中；安装包自带 Node 管理工具，无需另装 LibreChat，也无需下载源码或执行 `npm install`。

**当前仍处于安装候选阶段，完整 Agent 镜像和安装包尚未公开发行。** 先取得维护者提供的可信候选包，或按源码仓库的 `docs/BUILD.md`、`docs/RELEASING.md` 自行构建和打包；不要把文档示例当成已经存在的下载地址。支持和验收范围以具体版本说明为准。

本文主流程使用 Linux + Cloudflare + 宿主 Nginx，先关闭注册完成验收，再决定是否公开。只供自己使用可以始终关闭注册；仅通过 SSH 隧道测试的简化方式见文末。

## 1. 准备服务器和外部服务

```text
用户浏览器 → Cloudflare HTTPS → 宿主 Nginx HTTPS → 127.0.0.1:3333
                                                   └ Compose gateway
                                                      ├ LibreChat Agent
                                                      ├ Browser Service / Chrome
                                                      └ MongoDB / Redis
```

| 项目 | 要求 |
| --- | --- |
| 服务器 | Linux amd64 或 arm64，与安装包匹配；建议从 4 vCPU、8 GiB 内存、至少 30 GiB 可用磁盘、1 个浏览器开始，另留镜像和备份空间 |
| CPU | amd64 需 AVX；arm64 需 ARMv8.2-A 或更高，见 [MongoDB 平台要求](https://www.mongodb.com/docs/manual/administration/production-notes/#platform-support) |
| 宿主软件 | Node.js 24+、Docker Engine 26+、Compose plugin v2/v5、`flock`、Nginx；新主机建议安装当前受支持的 Docker 版本 |
| Docker 运行方式 | 本机系统 daemon，socket 为 `/var/run/docker.sock`；不使用 rootless 或远程 daemon |
| 部署用户 | 一个固定的普通 Linux 用户，拥有 Docker 访问权限；系统软件和 Nginx 设置另用 sudo |
| 域名 | 接入 Cloudflare DNS 的域名，例如 `agent.example.com`，以及服务器公网 IP |
| 模型 | Qwen API key、可用的模型 ID、同一区域的兼容 API base URL、输入和输出费率 |
| Turnstile | 开放注册时必填；关闭注册可将公私钥同时留空 |
| 邮件 | 可选；未配置时由部署者通过服务器命令恢复账号密码 |

Mac 可以构建和发布镜像，**安装器仅在 Linux 上运行**。服务器需要访问镜像仓库、模型 API、目标网站；使用 Turnstile 或 SMTP 时还需访问相应服务。

以下以 Ubuntu 为例。先按 [Node.js 安装说明](https://nodejs.org/en/download) 安装 Node.js 24+，按 [Docker Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) 安装 Engine 和 Compose plugin。Node 使用稳定的安装路径，后续定时备份会记录该路径。再安装宿主工具并检查：

```bash
sudo apt update
sudo apt install -y util-linux nginx ca-certificates curl nano
node --version
command -v node
command -v flock
uname -m
docker --host unix:///var/run/docker.sock version
docker --host unix:///var/run/docker.sock compose version
```

`x86_64` 选择 amd64 包，`aarch64` 选择 arm64 包。Docker 检查应能显示 Server；普通用户权限不足时按 [Docker 用户组设置](https://docs.docker.com/engine/install/linux-postinstall/) 操作并重新登录。Docker 组具有宿主管理权限，只给部署者使用。之后不要交替用普通用户与 `sudo` 运行 `agentctl`。

云安全组和主机防火墙放行管理员 SSH、站点 TCP 80/443。入口 3333 只绑定回环；MongoDB、Redis、浏览器控制、CDP/VNC 不需公网端口。使用 Cloudflare 代理时，可把源站 80/443 限制为 [Cloudflare IP 段](https://www.cloudflare.com/ips/)，保留自己的 SSH 通道。

## 2. 准备 Cloudflare 配置

1. 在已激活的 zone 内新增站点 A 记录，指向服务器公网 IPv4，启用 **Proxied（橙云）**。只有服务器支持 IPv6 时才添加 AAAA。
2. 准备覆盖该站点域名的**源站证书和私钥**。已有有效证书可复用；否则在 SSL/TLS → Origin Server → Create Certificate 创建 Origin CA 证书，保存 PEM 证书和私钥。第 6 步装好 Nginx 后再设置 **Full (strict)**。[Origin CA 配置](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/)
3. 若计划开放注册，创建 Managed Turnstile widget，hostname 填站点域名，不带协议或路径。保存 Site key 与 Secret key；正式站点使用正式 key。Turnstile 提供免费方案。[创建 widget](https://developers.cloudflare.com/turnstile/get-started/)、[方案](https://developers.cloudflare.com/turnstile/plans/)
4. 为该 hostname 创建 **Bypass cache** 缓存规则，确保没有后续规则覆盖；检查 WebSockets 已启用，聊天流与远程浏览器需要持续连接。[缓存规则](https://developers.cloudflare.com/cache/how-to/cache-rules/create-dashboard/)、[WebSockets](https://developers.cloudflare.com/network/websockets/)

Cloudflare 控制台的边缘证书用于浏览器到 Cloudflare；源站证书用于 Cloudflare 到服务器。已有覆盖当前域名且能取得配套私钥的源站证书，无需重新申请。若同一个 zone 还有未准备好源站 HTTPS 的其他站点，仅对本应用设置 Full (strict)，不要直接改变所有站点的模式。具体设置见 [Origin CA 的 SSL 模式步骤](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/#3-change-ssltls-mode)。

应用不需要 Cloudflare Global API Key、DNS 管理 token 或账号 ID。证书私钥由宿主 Nginx 保管；应用只接收 Turnstile 密钥和可选发信凭据。

## 3. 校验安装包并初始化

从可信渠道取得**对应架构**的归档与 `SHA256SUMS`，放到服务器同一个下载目录，例如 `~/agent-downloads/`。可以直接下载，也可从构建机用 `scp` 传入；校验文件必须对应实际下载的归档名。每个架构单独存放，避免同名覆盖。

```bash
cd "$HOME/agent-downloads"
AGENT_VERSION='vX.Y.Z'   # 换成实际版本
AGENT_ARCHIVE="agentic-browser-agent-${AGENT_VERSION}.tar.gz"
sha256sum -c SHA256SUMS
tar -xzf "$AGENT_ARCHIVE"
cd "agentic-browser-agent-${AGENT_VERSION}"
AGENT_BUNDLE="$PWD"
node bundle.mjs verify
```

如果发布渠道为文件名增加了架构后缀，修改 `AGENT_ARCHIVE`，解压后的目录名仍以包内结构为准。校验应显示归档 `OK`、包验证 `verified: true`；摘要校验不能代替对下载渠道的信任。包内 `BUILD.json` 记录平台和源码，`release.json` 固定六个镜像。不要修改包内文件或把个人配置放进去。

在同一终端选择安装位置和访问域名：

```bash
AGENT_DIR="$HOME/my-agent"
AGENT_CONFIG="$AGENT_DIR/config"
AGENT_HOST='agent.example.com'   # 换成自己的域名
```

**运行目录和配置目录都必须尚不存在**，让 `init` 创建它们；不要先复制空配置示例。需要分开存放配置时，只在这里把 `AGENT_CONFIG` 改成另一个绝对路径，例如源码部署的 `/home/ubuntu/agentic-browser/config/local`。工具会记住该路径，后续无需重复传入。

查看 `bundle.mjs verify` 输出的 `distribution`，**只执行对应的一组初始化命令**：

### Registry 包：`registry-candidate`

```bash
node "$AGENT_BUNDLE/agentctl.mjs" --directory "$AGENT_DIR" init \
  --config-directory "$AGENT_CONFIG" \
  --release "$AGENT_BUNDLE/release.json" --port 3333
```

会拉取固定 digest 的镜像。公开镜像不需登录；私有镜像先由同一部署用户完成 Docker registry 登录。

### 离线包：`offline-candidate`

```bash
node "$AGENT_BUNDLE/bundle.mjs" load-images
node "$AGENT_BUNDLE/agentctl.mjs" --directory "$AGENT_DIR" init \
  --config-directory "$AGENT_CONFIG" \
  --release "$AGENT_BUNDLE/release.json" --port 3333 --development
```

`--development` 在这里允许使用离线包记录的本机 image ID，不会关闭账号或额度控制。离线包只省去拉取镜像，模型和目标网站仍需网络。

成功后返回 `status: initialized`。以下是默认位置；独立配置目录则以选定路径为准：

```text
~/my-agent/
├── agentctl.mjs         # 安装后的管理入口
├── installation.json   # 实例与配置目录信息
├── release.json        # 固定镜像清单
├── compose.yaml
├── config/
│   ├── settings.json   # 站点、模型、额度等普通参数
│   ├── secrets.env     # 私密值，含自动生成的应用密钥
│   └── browser-token   # 自动生成的内部服务密钥
├── data/               # 数据库、上传、浏览器状态、日志
└── state/              # 维护状态；不要手动删除
```

首次启动还会生成 `.env`；首次备份会生成 `backups/`。重新登录 SSH 后，重新设置本节的路径变量即可。不要通过删除安装目录来“重装”。

## 4. 填写站点参数和密钥

在服务器上编辑生成的文件：

```bash
nano "$AGENT_CONFIG/settings.json"
nano "$AGENT_CONFIG/secrets.env"
```

保留生成的结构和随机密钥，只修改对应字段。JSON 不支持注释或尾随逗号。

| 文件 / 字段 | 填写内容 |
| --- | --- |
| `settings.json` → `name`、`origin` | 站点名称、`https://你的域名`；不带路径，与 `AGENT_HOST` 和 Turnstile hostname 一致 |
| `adminEmail` | 管理员邮箱；普通用户与管理员共用登录页 |
| `registration` | 首次保持 `closed`，验收后可改为 `public` |
| `turnstileSiteKey` | Turnstile Site key；未使用时保持空字符串 |
| `model.name`、`model.baseURL` | 可用的 Qwen 模型 ID、同一区域的兼容 API 根地址，通常以 `/v1` 结尾，不加 `/chat/completions` |
| `model.promptRate`、`model.completionRate` | 输入、输出的美元每百万 tokens 价格，填 JSON 数字，不能留为 `null` |
| `credits.initial` | 新账号一次性初始额度，默认 `200000`；不是每日刷新 |
| `credits.daily`、`credits.timeZone` | 初始全站每日预算 `20000000`，账期时区默认 `Asia/Shanghai` |
| `browser.maximum` | 首次保留 `1`；每账号最多一个会话，全局可设 1–10 |
| `secrets.env` → `QWEN_API_KEY` | 与模型、区域和接口相匹配的模型密钥 |
| `TURNSTILE_SECRET_KEY` | 同一 widget 的 Secret key；与 Site key 同时填写或同时留空 |
| `DEMO_ADMIN_PASSWORD` | 已生成随机密码，可在首次启动前改为至少 12 字符，保存到密码管理器 |

Qwen 的模型可用性、地域、base URL 和价格按自己的供应商账号确认。**已有实例暂不支持直接修改 `model.name` 来切换 Agent 模型**，首次启动前确定型号；更换同一模型的 API key 不需重建镜像。

计费换算为 **1,000,000 credits = 1 美元**。例如输入价为 0.5 美元/百万 tokens，则 `promptRate` 填 `0.5`；这只是单位示例。默认每人额度约 0.20 美元，全站预算约 20 美元/天。供应商以人民币报价时需先换算；应用预算按所填费率记账，不能代替供应商账单。管理员在管理页面保存的日预算优先于此处的初始值。

`JWT_SECRET`、`JWT_REFRESH_SECRET`、`CREDS_KEY`、`CREDS_IV` 和 `browser-token` 保留自动生成的值。以后重置账号使用 `user-reset`；修改初始密码不会重置已有账号。

配置目录应为 0700、私密文件为 0600。不要 `source secrets.env`，也不要递归改 `data/` 权限。工具生成的 `.env` 仅用于把镜像、端口、目录等填入 Compose YAML；模型密钥通过配置文件挂载传入容器，不放进该文件或镜像。完整字段及对应关系见 [配置指南](CONFIGURATION.md)。

## 5. 启动并配置代理信任

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" up
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" doctor
curl --fail --silent --show-error -o /dev/null -w '%{http_code}\n' \
  -H "Host: $AGENT_HOST" http://127.0.0.1:3333/api/config
```

预期 `healthy: true`、HTTP `200`。`doctor` 检查内部服务，不会付费调用模型或验证外部 Turnstile、邮件。改过 `--port` 时，后面的 curl 和 Nginx 模板也要使用新端口。

还需让内层 gateway 信任宿主 Nginx 的来源地址，才能正确区分访客 IP。标准 Linux Docker bridge 部署查询：

```bash
AGENT_PROJECT=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).project' "$AGENT_DIR/installation.json")
docker --host unix:///var/run/docker.sock network inspect "${AGENT_PROJECT}_front" \
  --format '{{range .IPAM.Config}}{{.Gateway}}{{"\n"}}{{end}}'
```

将返回的网桥 IP 加到 `settings.json` 顶层的 `trustedProxyIPs` 数组，例如 `"trustedProxyIPs": ["172.20.0.1"]`，**以实际结果为准**。这里不是 Cloudflare 网段或访客 IP。添加字段时注意逗号，然后应用：

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" apply
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" doctor
```

`apply` 要求站点空闲，先备份再加载配置；有任务时返回 `busy`，结束后重试。日后修改配置也使用这个入口，不能重复 `init`。自定义网络或重建网桥后重新核对代理来源。

## 6. 配置 Nginx 与公网 HTTPS

把第 2 步准备的证书和私钥保存到服务器。下面用于新站点；已有文件时保留原件、直接使用有效证书路径，不覆盖其他应用配置。

```bash
sudo install -d -m 700 /etc/nginx/agentic-browser
sudo touch /etc/nginx/agentic-browser/origin.pem /etc/nginx/agentic-browser/origin.key
sudo chmod 600 /etc/nginx/agentic-browser/origin.pem /etc/nginx/agentic-browser/origin.key
sudoedit /etc/nginx/agentic-browser/origin.pem
sudoedit /etc/nginx/agentic-browser/origin.key
```

分别填入完整 PEM 证书与配套私钥。复制发行包提供的通用模板：

```bash
sudo install -m 644 "$AGENT_BUNDLE/nginx.host.conf" /etc/nginx/conf.d/agentic-browser.conf
sudoedit /etc/nginx/conf.d/agentic-browser.conf
```

在文件中完成三项替换：所有 `agent.example.com` 改为自己的域名；证书路径与实际文件一致；`127.0.0.1:3333` 与初始化端口一致。核对模板中的 Cloudflare IP 范围仍有效，保留身份头清除、WebSocket、流式响应和禁用缓存设置。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

仅在 `nginx -t` 成功后重载。随后在 Cloudflare 将此应用设为 **Full (strict)**，保持橙云代理，确认边缘证书已生效；不要使用 Flexible。验证：

```bash
curl --fail --silent --show-error -o /dev/null -w '%{http_code}\n' \
  "https://$AGENT_HOST/api/config"
```

预期 `200`。浏览器打开正式 HTTPS 地址，用 `adminEmail` 和初始密码登录；配置了 Turnstile 时完成验证。Origin CA 证书用于 Cloudflare 到源站，直接用浏览器访问源站出现不受信任提示并不代表正式域名证书错误。[Full (strict) 要求](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

## 7. 可选：启用邮件找回密码

不需要邮件可跳到第 8 步。官方示例使用 Cloudflare Email Sending 的 SMTP 接口；Email Routing 的收信转发不等于向任意用户发信。当前面向任意收件人的发信需 Workers Paid 与 Email Sending 开通，具体条件以 [Email Service 说明](https://developers.cloudflare.com/email-service/) 为准。

在 Email Service → Email Sending 验证发信域名，例如 `mail.example.com`，按控制台完成 DNS 验证。创建覆盖该账号的 **Email Sending: Edit** API token。将以下 `smtp` 字段合并到现有 `settings.json` 顶层，不要用此片段覆盖整个文件：

```json
{
  "smtp": {
    "host": "smtp.mx.cloudflare.net",
    "port": 465,
    "encryption": "tls",
    "from": "noreply@mail.example.com",
    "username": "api_token"
  }
}
```

`from` 使用已验证的发信域名，`api_token` 是固定用户名；token 填入 `secrets.env` 的 `SMTP_PASSWORD`。[Cloudflare SMTP 参数](https://developers.cloudflare.com/email-service/api/send-emails/smtp/)

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" mail-test --to your-address@example.com
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" apply
```

将收件地址换成自己的邮箱。测试返回 `accepted: true` 后核对邮件实际到达；SMTP 接受不等于投递成功。`apply` 后启用 Forgot Password。修改 origin、发信配置或凭据后需重新 `mail-test`，否则旧验证收据失效。其他 SMTP 供应商复用同一接口，见 [运维指南](OPERATIONS.md)。

## 8. 验收并选择注册策略

管理员登录后完成一次真实 Demo：Agent 打开网页 → 人工接管 → 在远程浏览器完成登录或操作 → 点击 Done → Agent 自动继续并返回结果。网站密码和验证码在接管时输入浏览器，不写入聊天。

**自用 / 团队模式：保持 `registration: closed`。** 这样关闭公开注册，但已有账号仍可登录。管理员和普通账号共用登录页面；管理员可使用管理入口，普通账号不能访问管理功能。按需在服务器交互创建普通账号或恢复密码：

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" user-create
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" user-reset
```

**公开体验模式：** 确认 HTTPS、两把正式 Turnstile key 均已配置，将 `registration` 改为 `public`，空闲时执行 `apply`。用独立浏览器会话注册普通账号并核对：

- 注册、登录、历史聊天正常；新账号只领取一次初始 credits，真实模型调用会扣减额度。
- 管理员能查看和设置全站预算，普通用户无法访问管理操作。
- 远程画面、人工接管、归还后继续正常；容量为 1 时另一账号排队，前一个会话结束后获得名额。
- 配置邮件时，找回链接能完成密码重置，旧密码无法再登录。

完成后再对外分享地址；增加 `browser.maximum` 前先验证主机容量。

## 9. 启用备份

在站点空闲时先做一次完整备份，再生成定时策略：

```bash
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" backup
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" schedule \
  --timezone Asia/Shanghai --hour 4 --keep 7 --retry-minutes 60
```

`schedule` 只生成策略和 systemd unit，**还需要启用定时器**。使用第 5 步读取的 `AGENT_PROJECT`：

```bash
AGENT_BACKUP_UNIT="agentic-backup-${AGENT_PROJECT}"
sudo systemctl link "$AGENT_DIR/state/systemd/${AGENT_BACKUP_UNIT}.service" \
  "$AGENT_DIR/state/systemd/${AGENT_BACKUP_UNIT}.timer"
sudo systemctl daemon-reload
sudo systemctl enable --now "${AGENT_BACKUP_UNIT}.timer"
systemctl list-timers "${AGENT_BACKUP_UNIT}.timer" --all
node "$AGENT_DIR/agentctl.mjs" --directory "$AGENT_DIR" maintenance-status
```

应能看到 timer 的下次检查时间。它每分钟检查维护状态，每天按所选时区从 4 点开始尝试备份；有任务时按设定间隔重试。保留最近 7 份调度器生成的完整备份，手工和升级前备份不自动删除。

用户、聊天、额度等数据持久化到 `data/`，重建容器不会清空它们。备份包含配置与密钥，应受控保存；镜像、宿主 Nginx 和 TLS 私钥不在数据备份内，需要另行保管。异地副本、恢复到新目录、版本升级及中断处理集中在 [运维指南](OPERATIONS.md)。

## 仅用 SSH 隧道测试

没有公网域名时，仍在 Linux 上按第 1、3、4 步安装，跳过 Cloudflare/Nginx 设置：`origin` 保持 `http://127.0.0.1:3333`，`registration` 为 `closed`，两把 Turnstile key 同时留空。填写模型和管理员配置后执行 `up`、`doctor`。

在自己的电脑执行并保持终端连接：

```bash
ssh -N -L 3333:127.0.0.1:3333 YOUR_USER@YOUR_SERVER
```

浏览器打开 `http://127.0.0.1:3333` 登录。这里不能开放注册；转为公网部署时再设置 HTTPS origin、代理和 Turnstile，并用 `apply` 生效。这是同一套应用的访问方式，配置与数据无需迁移。

## 常见问题

| 现象 | 检查和处理 |
| --- | --- |
| `Configuration rejected` | JSON 格式、模型名/base URL、费率是否仍为 `null`、管理员邮箱、密钥配对和文件权限 |
| `configuration_changed` | 修改配置后用 `apply`，不重复 `init` |
| HTTP `421` | Host 与 `settings.origin` 是否一致；本机 curl 也要带正式 Host |
| Cloudflare `521` / `522` | Nginx、443 监听、安全组、Cloudflare IP 放行和 DNS |
| Cloudflare `525` / `526` | 源站证书与私钥、域名覆盖、有效期、TLS 握手和 SSL 模式 |
| Turnstile / 登录失败 | HTTPS 域名、widget hostname、公私钥配对、服务端验证网络和实际账号密码 |
| 画面断开 / 回复不流式显示 | 使用附带代理模板，检查 WebSocket、缓存和 buffering |
| 模型 `401` / 模型不存在 | API key、区域、模型 ID、base URL 和供应商余额；`doctor` 不测试真实模型 |
| 多个访客一起被 IP 限流 | 两层代理信任配置，尤其是 Docker front 网桥是否重建 |
| 找回入口不显示 / 邮件未到 | 发信权限、域名、`mail-test` 收据及 `apply`，再查投递记录和垃圾邮件箱 |
| `busy` / `maintenance_pending` | 等任务结束或按运维指南恢复，不删除维护状态文件 |

容器状态与本机日志：

```bash
docker --host unix:///var/run/docker.sock compose --project-directory "$AGENT_DIR" \
  --env-file "$AGENT_DIR/.env" -f "$AGENT_DIR/compose.yaml" ps
docker --host unix:///var/run/docker.sock compose --project-directory "$AGENT_DIR" \
  --env-file "$AGENT_DIR/.env" -f "$AGENT_DIR/compose.yaml" logs --tail 100 agent gateway
```

报告问题时提供版本、架构和脱敏错误。不要公开配置、日志原件、备份或登录后的浏览器数据。
