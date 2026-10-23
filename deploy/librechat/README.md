# LibreChat Browser Demo 部署

本目录管理宿主机部署、Nginx 与验收；LibreChat 源码在独立项目 `/home/ubuntu/Yu/librechat-agent`。新运行链路是 **LibreChat 原生 graph tools + Browser Skill 指引 + 私有 HTTP Browser Service**，不安装或调用 MCP。设计与进度见 [设计](../../docs/plans/LIBRECHAT_INTEGRATION.md)、[计划](../../docs/plans/LIBRECHAT_DEVELOPMENT.md)、[进度](../../docs/plans/LIBRECHAT_PROGRESS.md)。

## 目录与端口

| 组件 | 生产 | 隔离验收 |
| --- | --- | --- |
| LibreChat HTTP | `127.0.0.1:3080` | `127.0.0.1:3091` |
| Nginx | 现有域名端口 80 | `127.0.0.1:3081` |
| Browser 控制 API | `127.0.0.1:8081` | `127.0.0.1:18081` |
| Browser 画面/输入 WS | `127.0.0.1:8082` | `127.0.0.1:18082` |
| MongoDB | `127.0.0.1:27019/LibreChatBrowserDemo` | 独立 DB `LibreChatBrowserAcceptance` |
| Redis | `127.0.0.1:6381`，前缀 `browser-production` | 前缀 `browser-acceptance` |

应用作为 ubuntu 用户的宿主机进程运行，直接通过回环 IP:port 通信；Mongo/Redis 和每个 Chrome 运行在 Docker 中。Docker socket 仅由 Browser Service 使用。浏览器 runtime 与 egress proxy 使用隔离网络，不加入应用/数据库网络。

- `compose.infrastructure.yaml`：固定 digest 的 Mongo 8、Redis 7.4，持久卷和健康检查。
- `nginx.conf`：生产域名 `/` 转发 LibreChat；仅两个精确 WS 路径转发数据 listener；控制 listener 无公网映射；MCP/internal 返回 404，旧匿名入口 410。保留 SSE、Upgrade，并清除访客伪造的身份头。
- `nginx.acceptance.conf`：独立本地验收代理，不能直接用作公网站点。
- Browser `src/service.ts`：新服务入口；旧 `src/main.ts`/`src/mcp.ts` 不在新部署的执行路径中。
- LC `packages/api/src/browser/`：原生工具、恢复 worker、BFF、Turnstile 服务端校验和管理员 bootstrap；`client/src/components/Chat/Browser/`：同屏 UI。
- 两端协议定义在 Browser `src/api/protocol.ts`，通过 `scripts/sync-browser-contract.mjs` 生成到 LC 的 data-provider，禁止手改生成文件。

## 一次性配置与构建

Node 固定使用已验收的 24.22.1；LibreChat 上游基线为 `61892206974618971b9001d109485d994dac2816`。首次操作：

```bash
cd /home/ubuntu/Yu/agentic-browser
npm ci
npm run setup:librechat
# 在服务器编辑 .deployment/librechat/private.env；不把密钥写进命令参数、聊天或 Git。
npm run doctor:librechat
node scripts/sync-browser-contract.mjs /home/ubuntu/Yu/librechat-agent --check
```

私密目录 0700、文件 0600。setup 重跑不覆盖现有值。`QWEN_API_KEY`、`TURNSTILE_SECRET_KEY`、管理员密码和服务/JWT/加密密钥仅从此文件加载。用户现已配置，无需再次申请或填写 OAuth。

```bash
cd /home/ubuntu/Yu/librechat-agent
npm ci
npm run frontend
cd /home/ubuntu/Yu/agentic-browser
node scripts/render-librechat-config.mjs
node scripts/render-librechat-services.mjs
```

渲染产物在 `.deployment/librechat/`，包含 production/acceptance YAML、非敏感运行参数和两个 systemd unit。安装前 `systemd-analyze verify`；渲染不安装、不切换服务。`BROWSER_RUNTIME_IMAGE` 必须固定为本机已验收的 `sha256:...` 镜像 ID，跨机器部署需先导入相同镜像或使用对应 registry digest。

当前模型 `qwen3.7-plus`，北京 endpoint。费率采用官方美元标价每百万输入 0.276、输出 1.101；不计临时折扣，context 上限 64K。初始 200,000 credits，自动补充关闭；百万 credits 对应 1 美元的记账权重。费率来源：[阿里云 Model Studio 定价](https://www.alibabacloud.com/help/en/model-studio/model-pricing)。它用于 Demo 成本控制，最终账单仍以云平台用量为准。

Turnstile 在生产登录/注册均校验成功状态、hostname 和 action；缺失、过期、重复 token 或服务异常不能进入认证/发放额度。隔离验收仅在回环地址关闭挑战和公开注册，禁止复制此配置到公网。参见 [Cloudflare 服务端验证](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)。

## 容量与保留

每个账号最多一个未清理的 lease（排队也占该账号名额），系统硬上限 20。运行放行量由 `BROWSER_MAX_SESSIONS` 决定，首次部署设置 **5**。本机真实 1/5/10 Chrome 短时测试通过，20 档因保留 3 GiB 内存的保护条件提前终止；不能宣称已支持 20 个任意网站并发。需要更多并发时先扩容并压测。

session 默认 5 分钟、绝对上限 10 分钟；排队默认 10 分钟。未确认清理的容器继续占配额。已结束、事件已确认的 lease/操作记录默认保留 24 小时；未确认事件和未清理资源不清除。LC checkpoint 1 小时。`BROWSER_RECORD_RETENTION_HOURS` 可设 24–720。

## 启动与上线顺序

本机已于 2026-10-22 完成服务安装、备份和域名切换；真人 Turnstile 成功与公网任务闭环仍待验收，详见进度文档。以下是重建/升级步骤。

```bash
cd /home/ubuntu/Yu/agentic-browser
docker compose -f deploy/librechat/compose.infrastructure.yaml up -d
node scripts/run-librechat.mjs bootstrap
sudo install -m 0644 .deployment/librechat/agentic-browser-service.service /etc/systemd/system/
sudo install -m 0644 .deployment/librechat/librechat-browser-demo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentic-browser-service librechat-browser-demo
```

bootstrap 在 HTTP listener 开放前创建受控首个管理员与只读 Demo Agent 权限。重跑不重置密码或 credits；已有非管理员占据配置邮箱时拒绝启动。

管理员已存在，直接在登录页使用私密配置中的 `DEMO_ADMIN_EMAIL` / `DEMO_ADMIN_PASSWORD`。不要通过 signup 修改管理员密码：LibreChat 对重复邮箱返回统一注册提示，但保留原密码。验收新用户注册时使用尚未注册的邮箱。

Nginx 切换前备份 `/etc/nginx/conf.d/agentic-browser.conf` 到不在 `conf.d` 下的私密备份目录。排空旧 Demo 会话，确认 3080/8081/8082 监听健康，单独校验新文件。只替换这一站点，`sudo nginx -t` 成功后 reload。保留其它站点，勿调用旧 `scripts/update-nginx.sh`（它仍管理旧站点）。

当前拓扑是 Cloudflare HTTPS → origin HTTP:80；此配置不新增 origin TLS。切换时核实 Cloudflare IP 段、HTTPS 和缓存策略，认证 HTML、API、SSE 和 WS 不应被共享缓存。公网验收必须检查真实 Turnstile、新注册 credits、Qwen 任务、同屏输入、归还恢复、MCP/internal 不可访问。

## 验收命令

```bash
npm run check
npm test
BROWSER_RUNTIME_IMAGE=sha256:YOUR_VERIFIED_IMAGE_ID npx tsx scripts/accept-browser-service.ts
BROWSER_RUNTIME_IMAGE=sha256:YOUR_VERIFIED_IMAGE_ID npx tsx scripts/accept-browser-capacity.ts
```

真实容量脚本创建独立 ledger/容器，按 1/5/10/20 档运行快照与帧任务，保留内存余量并在 finally 清理。报告在 `output/librechat/`，不提交 Git。它是短时合成负载，不替代持续压测。

LC 另需修改 workspace 的 `tsc --noEmit`、Browser/Redis/恢复策略 Jest、前端路由测试和 `E2E_CHROMIUM_CHANNEL=chrome LIGHTHOUSE_CHROME_FLAGS=--no-sandbox npm run lighthouse:run`。Lighthouse 使用一次性 DB/服务，不指向线上，且不与容量测试/构建并行运行。

`accept-librechat-accounts.mjs CONVERSATION_ID` 只访问回环验收站与 `accept-*@example.invalid` 测试账号，验证真实接管任务的账号隔离和后台归还恢复；`accept-librechat-budget.mjs` 临时将第二个测试账号余额置零，验证 SSE 拒绝与无扣费，并在 finally 恢复。不得改为生产账号执行。`accept-librechat-recovery.mjs` 验证真实 FIFO、停止和归还时零余额拒绝；`accept-librechat-logout.mjs` 验证 WS 撤销、任务取消及后台不重开。

`accept-librechat-turnstile.mjs [https://agentic-browser.zkpass.org]` 检查真实挑战拒绝路径；`accept-librechat-public.mjs` 检查公网封锁、缓存和无授权 WS 拒绝。它们不能代替真人挑战成功验收。

## 备份、日志和回滚

- Mongo 用 `mongodump` 备份生产 DB；Redis 保存 AOF 卷；Browser SQLite 与 runtime ledger 在停止 Browser Service、确认清理完成后一起备份。备份目录 0700，私密配置单独保管，不放代码或构建上下文。
- 记录两项目 git commit、工作区变更、Node 版本、runtime image ID、配置摘要和备份时间；JWT/加密密钥不可随升级重生成。
- 原始服务日志可能含账号或站点内容，仅在服务器保存。查看 LC 验收日志可用 `node scripts/read-librechat-log.mjs /tmp/lc-browser-server.log` 脱敏，报告不要包含密码、token、完整请求或私密页面截图。
- 应用升级失败时停止新会话、保留数据库/ledger，回到上一已验收的集成版本；没有可用版本则启用维护页。**不能通过重新开放公共 MCP 作为回滚方式。**
- 控制 API 不可用时注销返回可重试错误，不宣称远程浏览器授权已撤销；服务恢复后重试注销会关闭该账号连接与 lease。会话绝对 TTL 提供最终回收边界。
