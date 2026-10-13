# Ubuntu 公共 MCP 演示部署

此模式让访客自己的 Agent 通过一个远程 `/mcp` 地址操作服务器上的 Chrome，遇到人工步骤时打开网页镜像，完成后交还同一个浏览器。访客电脑无需安装本项目、Docker 或 Chrome 插件；需要支持 Streamable HTTP 的 MCP 客户端。

公共模式允许访问公网网页，只创建临时环境，不保存登录配置。真实个人或团队使用继续采用 [团队自部署](SELF_HOST.md)。原来的 [断网固定演示](PUBLIC_DEMO.md) 保留，两种演示不共用数据卷。

## 1. 准备 Ubuntu

建议独立 Ubuntu 24.04/22.04 amd64 主机，初始按 4 vCPU、8 GiB 内存、20 GiB 可用磁盘规划两个并发浏览器；这是资源预算，实际容量需按页面负载测量。当前 Chrome 镜像是 amd64，不建议把公共演示部署到 ARM 仿真环境。

安装 Git、Docker Engine 28+、Docker Compose 2.24.4+ 和 Buildx。Docker 安装与现有包迁移按 [官方 Ubuntu 指南](https://docs.docker.com/engine/install/ubuntu/) 执行。Compose 的 `!override` 用于替换端口列表，版本要求见 [官方合并规则](https://docs.docker.com/reference/compose-file/merge/#replace-value)。确认当前用户可执行：

```bash
docker version
docker compose version
docker context show
```

使用本机 Unix socket 的 Docker context。控制器需要挂载 Docker socket 来创建和清理临时浏览器，这是对整台 Docker daemon 的管理权限；浏览器和出网代理均不挂载 socket。建议此主机不承载其他敏感工作负载。

克隆自己的代码仓库后，在项目目录执行：

```bash
bash scripts/build-container-images.sh
cp .env.public.example .env.public
```

构建下载锁定版本的官方 Chrome、zkPass TransGate 与 Schema Validator 原始包，校验摘要并预装到浏览器镜像。没有打包任何用户登录数据。构建脚本在控制器容器内执行下载，部署主机不需要 Node；开发验收才需要 Node 24 和 npm。

## 2. 先用 IP 试运行

编辑 `.env.public`，把 `SERVER_IP` 换成 Ubuntu 的实际公网 IPv4：

```dotenv
AB_PROJECT_NAME=agentic-browser-demo
AB_PORT=3334
AB_BIND_ADDRESS=0.0.0.0
AB_PUBLIC_URL=http://SERVER_IP:3334
AB_MAX_SESSIONS=2
AB_MAX_SESSIONS_PER_IP=2
AB_TRUST_PROXY=false
```

只填写 origin，不加 `/mcp`、`/view` 或尾部路径。启动：

```bash
bash scripts/public-demo.sh config --quiet
bash scripts/public-demo.sh up -d --wait --wait-timeout 90
bash scripts/public-demo.sh ps
bash scripts/public-demo.sh exec controller node --import tsx src/doctor.ts
```

在云安全组中开放 TCP 3334，初期可仅允许测试者 IP。Docker 发布的端口可能绕过 UFW，不能只看 UFW 规则判断入口是否开放或受限，见 [Docker 防火墙说明](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations)。无需开放 VNC/CDP 内部端口，也不要开放 Docker daemon TCP 端口。

在自己的电脑访问 `http://SERVER_IP:3334/health`，应返回 `{"status":"ok"}`；首页 `http://SERVER_IP:3334/` 显示可复制的 MCP 配置。IP 模式不需要 localhost 转发。

HTTP 不加密页面、输入和会话密钥。此阶段使用内置虚构登录页；真实账号和公开推广前按下一节启用 HTTPS。某些 MCP 客户端可能拒绝远程 HTTP，遇到此情况直接使用 HTTPS。

脚本只读取 `.env.public`，不读取现有 `.env` 或 `.env.compose`。默认项目名 `agentic-browser-demo`、数据卷 `agentic-browser-demo-data`，容器内数据目录 `/data/public-browser`。不要改成团队部署的项目名或卷名；同一主机并行部署还需使用不同端口。

### 配置文件与变量名

| 启动方式 | 配置文件 | 对外入口变量 |
| --- | --- | --- |
| `npm start` / `npm run dev`，在宿主机直接运行 | `.env` | `PUBLIC_URL` |
| `bash scripts/public-demo.sh ...`，公共 Compose | `.env.public` | `AB_PUBLIC_URL` |
| `bash scripts/compose.sh ...`，团队 Compose | `.env.compose` | `AB_PUBLIC_URL` |

`AB_PUBLIC_URL` 是 Compose 的输入，Compose 将它映射成容器内的 `PUBLIC_URL`，再由应用读取；两者表达同一个对外 origin。环境变量区分大小写，`public_url` 不会被读取。入口地址用于 Host/Origin 校验及生成接管链接，不负责创建 DNS、TLS 证书或监听端口。

直接启动配置与 Compose 配置各自生效，修改 `.env` 不会改变已经部署的公共容器。公共配置修改后用 `bash scripts/public-demo.sh up -d --force-recreate --wait` 应用；维护前先结束活动会话。不要在 Compose 已占用的地址和端口上同时执行 `npm start`。

## 3. 访客连接 MCP

支持通用 MCP JSON 配置的客户端添加：

```json
{
  "mcpServers": {
    "agentic-browser": {
      "url": "http://SERVER_IP:3334/mcp"
    }
  }
}
```

Codex CLI 可执行：

```bash
codex mcp add agentic-browser --url http://SERVER_IP:3334/mcp
codex mcp list
```

也可编辑 Codex 的 `~/.codex/config.toml`：

```toml
[mcp_servers.agentic-browser]
url = "http://SERVER_IP:3334/mcp"
tool_timeout_sec = 60
```

只选其中一种 Codex 配置方式。配置后刷新客户端的 MCP 连接，确认列出 9 个工具。URL 与 Streamable HTTP 配置方式依据 [Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。本仓库自动验收使用官方 MCP TypeScript SDK 1.32.1，协商协议 `2025-11-25`；不提供旧版独立 `/sse` 地址，也未声明支持所有客户端或之后的协议修订。

此公共端点无需共享 API key、OAuth 或成员注册。`browser_create` 为每个浏览器返回独立的 `sessionId`、`sessionKey`；后续工具调用必须携带这两个值。`sessionKey` 是临时访问凭据，不是 `Mcp-Session-Id`。持有它的客户端才能继续操作；另一个客户端凭自己的密钥不能读取这个浏览器。

HTTPS 入口的首页提供 GitHub 任务示例，由用户在接管的浏览器中登录真实账号，交还后由 Agent 读取私有仓库列表。当前 IP/HTTP 入口仅展示流程说明，隐藏可执行的真实登录任务，并保留未加密提示。

> 用 agentic-browser 打开 https://github.com/login，把浏览器交给我登录。调用 browser_handoff 后，请先在当前对话中展示返回的实际 humanUrl，包含可点击链接和完整地址，再等待我操作。等我完成登录并交还后，统计我账号下的私有仓库总数，并列出所有私有仓库的名称，完成后关闭会话。

该示例创建会话时应传入 `url: "https://github.com/login"`。账号密码和验证码只在接管的浏览器内输入，不发给 Agent。内置虚构站点仍用于自动化验收，不作为 HTTPS 首页的用户示例。

流程：

1. Agent 调用 `browser_create`，保存 `sessionId` 和 `sessionKey`。默认进入容器内虚构站点，也支持指定公网 HTTP(S) URL。
2. `browser_handoff` 暂停 Agent 的观察和输入，返回 `humanUrl` 和可直接发送的 `userMessage`。Agent 必须先在当前对话中展示实际可点击链接及完整地址（保留 `#` 片段），再调用 `browser_wait`；不能只说“点击 Connect”。用户打开链接后点击“连接并接管”。
3. 用户在完整远程 Chrome 镜像中操作，完成后点击“完成，交还给 Agent”。
4. Agent 用 `browser_wait` 等待交还，之后通过 `browser_action` 继续同一会话。本模式没有服务端固定 Agent 代替访客执行步骤。
5. 完成任务调用 `browser_close`，等待容器回收后返回成功。

接管链接仅可领取一次，2 分钟过期。未领取链接可用 `browser_human_link` 重新签发，旧链接随即失效。领取后是临时 HttpOnly Cookie，刷新镜像页面可重连。MCP 连接重建不关闭浏览器，只要 Agent 仍保有密钥即可继续；丢失密钥不能列出和找回匿名会话，等待到期或从人工页面结束。

如果客户端只回复“点击链接”而没有展示地址，告诉 Agent：“请调用 `browser_human_link` 获取当前会话的新链接，把返回的 `userMessage` 完整发给我，包含实际可点击的 `humanUrl` 和完整地址，然后再等待。”会话已结束时需重新创建。交接和重新签发工具保留首个 JSON 文本块，同时返回 `structuredContent` 与独立文本消息，兼容不同客户端的结果读取方式。只向当前用户展示接管链接，`sessionKey` 不应出现在用户回复中。

等待最多 25 秒。HTTP 请求真正断开会停止等待；创建中的请求若断开，启动完成后回收未交付浏览器。部分客户端的“取消”只发送另一个取消通知而不关闭原请求，本无状态端点不按匿名请求 ID 跨连接取消任务：服务端等待仍可能持续到超时，创建仍可能完成并等待到期回收。客户端取消不等于关闭浏览器；结束已知会话使用 `browser_close`，不确定是否创建成功时不要盲目重试。

同一个浏览器 Cookie 空间只对应一个访客身份，接管第二个 Session 会切换身份；同时测试两个访客请使用不同浏览器配置或无痕窗口。

## 4. 换域名和 HTTPS

将域名 DNS A 记录指向 Ubuntu 公网 IP，并准备有效 TLS 证书。仓库提供 [Nginx 模板](../deploy/nginx-public.conf)，适用于 Ubuntu 的 `http {}` 内加载，例如 `sites-enabled`。

1. 安装 Nginx，使用自己的证书流程取得域名证书。模板的默认路径为 `/etc/letsencrypt/live/demo.example.com/`；尚无证书时不要加载启用 TLS 的模板。
2. 将模板复制为自己的配置文件，把全部 `demo.example.com` 替换为实际域名，核对证书路径。如果后端端口不是 3334，同步修改 `proxy_pass`。
3. 修改 `.env.public`：

```dotenv
AB_BIND_ADDRESS=127.0.0.1
AB_PUBLIC_URL=https://demo.example.com
AB_TRUST_PROXY=true
```

4. 等待演示会话结束后重建控制器并加载代理。重建会结束临时会话：

```bash
bash scripts/public-demo.sh up -d --force-recreate --wait --wait-timeout 90
sudo nginx -t
sudo systemctl reload nginx
```

5. 安全组开放 443，以及 HTTP 重定向/证书验证需要的 80，关闭对公网的 3334。验证 `https://demo.example.com/health`，把访客 MCP URL 换成 `https://demo.example.com/mcp`，跑一次完整人工接管。

若域名由 Cloudflare 代理，应用的公开入口仍配置为 `.env.public` 的 `AB_PUBLIC_URL=https://实际域名`，修改 `.env` 的 `PUBLIC_URL` 不影响公共 Compose 实例。Nginx 的 `Host` 应保留该域名，不应伪装成旧 IP 来绕过校验。Cloudflare 边缘提供 HTTPS、源站仅监听 80 时，回源仍是明文；完整配置需源站证书及 443，再使用 [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)。恢复访客 IP 时，只信任 Cloudflare 官方网段提供的 `CF-Connecting-IP`，不要无条件转发客户端自报的地址。

模板覆盖 `X-Real-IP`，应用只在 `AB_TRUST_PROXY=true` 时采用该值计配额，不读取客户端提供的 `X-Forwarded-For` 链。**仅在后端绑定回环地址、前方为这个可信代理时启用**；直接开放后端时必须为 false。若增加 CDN、多级代理或负载均衡，先正确配置受信代理地址，不能原样相信访客的 IP 请求头。

Nginx 同时转发 MCP HTTP 和镜像 WebSocket；保留 `Upgrade`、`Connection`、关闭响应缓冲及 75 秒读超时，参见 [Nginx WebSocket 文档](https://nginx.org/en/docs/http/websocket.html)。`Host` 必须是 `PUBLIC_URL` 的主机和端口，应用会拒绝错误 Host/Origin。模板假定标准 HTTPS 443，非标准端口需同步修改 Host、监听和跳转地址。

## 5. 限额与数据边界

| 项目 | 当前行为 |
| --- | --- |
| 全站浏览器并发 | 默认 2，`.env.public` 的 `AB_MAX_SESSIONS` 可配置 1–32，包含创建中的浏览器。 |
| 每来源 IP 并发 | 默认 2，`AB_MAX_SESSIONS_PER_IP` 可配置 1–8，包含创建中与尚未完成清理的浏览器。 |
| 创建速率 | 每来源 IP 每分钟最多 6 次访客身份创建尝试。 |
| MCP 请求 | 每来源 IP 每分钟 120 次；同时最多 8 个请求，全站 64 个；请求体最多 64 KiB。 |
| 浏览器操作 | 每 Session 同时最多 4 个公共 MCP 操作；控制权队列另外串行执行网页动作。 |
| 临时期限 | 初始 5 分钟，手动续期最长到创建后 10 分钟；等待和重连不会自动续期。 |
| 容器资源 | 每浏览器上限 2 GiB、2 CPU、512 PID；代理上限 128 MiB、0.5 CPU、64 PID；控制器上限 1 GiB、1 CPU、256 PID。 |
| Nginx 入口 | 模板每来源 10 请求/秒、突发 40、24 个连接，超限拒绝。 |
| Profile | 禁止保存、复用或列举真实登录配置；没有成员/Agent 凭据签发入口。 |
| 出网 | 通过独立代理访问公网 HTTP(S) 的 80/443；阻止私网、回环、云元数据及配置的管理地址，Chrome 容器本身 `network=none`。 |

同一公司/家庭 NAT 出口可能共享 IP 配额，这不是实名“每用户”配额。当前没有账户日额度、出口流量计费或分布式反滥用；先小范围邀请验证容量，再考虑扩大开放。

`PUBLIC_URL` 的 hostname 会自动加入浏览器出网拒绝名单。主机其他公网管理 IP/域名应通过 `AB_EGRESS_DENY_HOSTS=management.example.com,203.0.113.10` 补充；它不能替代安全组、主机权限和独立部署。公网网站访问与访客间隔离是两件事，不应因为独立容器就允许访问服务器内网。

每 Session 复用只读软件镜像，但使用独立 Chrome 进程、临时用户目录和代理子目录。普通 TLS CONNECT 不解密目标网站 HTTPS。人工控制期间公共 MCP 拒绝 Agent 的页面读取、截图和输入，交还后 Agent 可读页面及登录后的内容。

这不是对运营者不可见的机密计算环境：运营者管理 Ubuntu/Docker，也会接触远程浏览器；自己的 Agent 能签发接管链接，因此匿名演示的接管链接是持有者授权，不是独立实名身份验证。不要公开链接、密钥或要求 Agent 代填真实密码；公共体验优先使用测试账号，真实数据用自己的团队实例。

临时 Cookie、缓存和扩展状态随浏览器回收，不在后台保存 Profile。少量访客身份哈希/到期信息用于会话校验和清理，不承诺磁盘取证级抹除。关闭接管页不会立刻关闭会话；到期后台回收，控制器重启不恢复旧浏览器、密钥或任务。服务启动会按本实例记录清理异常残留，不扫描删除其他项目。

Google、X 等站点可能仍拒绝数据中心 IP、自动化会话或要求额外验证。此部署不修改 UA、绕过验证码，也不保证任何特定第三方账号能登录。

## 6. 验收和日常管理

开发环境先安装 Node 24、`npm ci` 和 Playwright Chromium，再构建上述镜像：

```bash
npm run check
npm test
npm run test:public-mcp
```

`test:public-mcp` 使用独立随机 Compose 项目、数据卷、端口和虚构账号，验证公网 IP 配置的健康检查、两个 SDK 客户端、两套 Chrome/代理、跨访客拒绝访问、原生镜像输入、等待交还、外部 Agent 继续、公网访问、元数据拒绝、重启失效与清理。自动测试不等于公网 DNS/TLS 或每款桌面客户端已验收。

```bash
bash scripts/public-demo.sh logs --tail 100 controller
bash scripts/public-demo.sh exec controller node --import tsx src/doctor.ts
bash scripts/public-demo.sh stop --timeout 60
bash scripts/public-demo.sh up -d --wait
```

发布更新时先结束演示会话，再重新构建镜像并 `up -d --force-recreate --wait`。停止控制器会回收本实例浏览器和代理，专属卷仍保留运行元数据；如决定完全删除这套演示，再执行 `bash scripts/public-demo.sh down --volumes`。不要对团队部署执行删除卷命令。

排错顺序：

- 无法连接：检查 `ps` 健康状态、实际监听地址、云安全组、IP/端口；访客 URL 必须是服务器 IP/域名，而非访客的 localhost。
- 403 Host/Origin：统一 `.env.public`、访问地址和 Nginx Host；更新后重建控制器。
- 429：达到来源或全站配额，结束闲置会话，或等待到期；不要连续重试创建。
- 接管链接：领取前保留 `#` 片段，刷新 `/connect` 不会丢失票据；领取成功才替换为镜像页地址。链接不完整时复制 Agent 给出的完整地址；已使用或过期时让 Agent 获取新 `browser_human_link`。同一标签页打开新链接会重新启用接管按钮。
- Cloudflare 脚本优化：接管页和镜像页的入口脚本带 `data-cfasync="false"`，按 [Cloudflare 官方说明](https://developers.cloudflare.com/speed/optimization/content/rocket-loader/ignore-javascripts/)排除 Rocket Loader 改写，保留原生模块加载顺序。
- 页面能开但镜像断开：检查 WebSocket 代理、用户是否仍持有该访客 Cookie、控制权和会话期限。
- 操作超时/取消：先查询 `browser_status`，再观察页面确认结果；不要重放可能已提交的网页表单。

运维日志不要记录请求正文、Cookie、Authorization、MCP 返回正文或带票据的接管链接。当前模板关闭访问日志；下游日志、Agent 对话记录和监控系统也应遵守这一边界。
