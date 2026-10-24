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

每个账号最多一个未清理的 lease（排队也占该账号名额），系统硬上限 10。运行放行量由 `BROWSER_MAX_SESSIONS` 决定，当前保持 **5**。本机真实 1/5/10 Chrome 短时测试通过，后续混合页面持续测试仅 5 档通过；用户已要求暂不考虑扩容。超过 10 的配置会在部署渲染、服务启动和调度器构造时被拒绝。历史 20 档曾因内存保护终止，已退出当前计划和容量验收脚本。

session 默认 5 分钟、绝对上限 10 分钟；排队默认 10 分钟。未确认清理的容器继续占配额。已结束、事件已确认的 lease/操作记录默认保留 24 小时；未确认事件和未清理资源不清除。LC checkpoint 1 小时。`BROWSER_RECORD_RETENTION_HOURS` 可设 24–720。

## 启动与上线顺序

本机已于 2026-10-22 完成服务安装、备份和域名切换，2026-10-24 完成当前 5 并发配置的最终公网任务验收。真人挑战、真实普通账号/额度、合成任务与 GitHub 真人结果的证据范围见进度文档。以下是重建/升级步骤。

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

## GitHub Demo

聊天首页有两个入口：介绍 GitHub，以及统计当前个人账号拥有的私有仓库数量与名称。后者通过浏览器完成：Agent 打开 GitHub 登录页并交出控制权 → 用户在右侧浏览器完成登录和二次验证、离开登录表单 → 点击 `Done — continue task` → Agent 自动继续读取仓库列表。无需申请 GitHub OAuth App 或提供 PAT。

默认统计个人账号拥有的 private 仓库；组织仓库及仅有协作权限的仓库不计入，用户可在聊天里明确扩大范围。任务指引要求核对 owner/Private 筛选、遍历分页、按 `owner/name` 去重，返回账号、统计范围、数量和名称/链接；不打开仓库内容或修改 GitHub 状态。登录未完成时重新接管，遇到会话时限、额度或分页限制时报告已核实的部分结果，不能声称完整数量。列表元数据会进入 Agent 的模型上下文和当前聊天记录；密码和验证码由用户在人工控制阶段自行输入。

入口文案及任务指引统一放在 LibreChat 项目的 `config/browser-demo.json`。配置渲染器读取同一份 starters；bootstrap 只同步部署管理的 Agent 名称、描述、指引和 starters。仅配置管理员拥有的固定 Agent 可更新，内容未变时不创建新版本；账号、密码、余额、模型和工具配置保持原值。修改后重新渲染配置并重启 LibreChat，刷新页面、开启新聊天即可看到更新。

自动验收已覆盖真实 Qwen 打开 GitHub、交出控制权，以及未登录就归还后再次要求登录。2026-10-24 用户已确认自己账号下的私有仓库数量和名称与实际列表一致；这是当前账号的真人业务验收，不扩展为任意分页规模的验证。报告：`output/librechat/github-demo-real.json`、`github-inventory-human.json`。仓库筛选依据：[GitHub 仓库列表文档](https://docs.github.com/en/repositories/creating-and-managing-repositories/viewing-all-your-repositories)。

聊天历史使用 LibreChat 原生自动标题：Qwen 在首条请求发出后生成简短任务名称，语言跟随请求，等待人工接管时也会显示。部署渲染器设置 `titleConvo: true`、`titleTiming: immediate` 和当前模型；`titlePromptTemplate: '{input}'` 仅使用用户请求，自定义 `titlePrompt` 必须保留 `{convo}` 占位符。标题用量走原有 credits 记账；手动改名由上游所有权机制保护。验收报告：`output/librechat/chat-titles-real.json`。

## 验收命令

### 浏览器交接显示

点击 `Done — continue task` 或 `Take control` 时，面板保留上一帧并显示控制权切换状态。后端仍立即撤销旧 viewer 授权；前端识别 `Browser access changed` 关闭事件并刷新状态，等新的只读 JPEG 解码完成后移除过渡画面。冻结帧只在当前页面内存中存在，恢复显示或离开会话后清除。

真实断线保留 `Reconnect`；等待连接或交接超时也进入重试状态。LibreChat 的 `browser.viewerConnectTimeoutMs` 默认 30,000ms，可配置范围 1,000–120,000ms，仅控制显示等待时间，不改变 Browser session 生命周期。相关实现位于 LibreChat 的 `client/src/components/Chat/Browser/Screen.tsx`，回归测试位于同目录 `__tests__/Screen.spec.tsx`。

前端升级先构建到独立输出目录并验收，再发布资源和入口文件；保留旧的哈希资源供已打开的页面使用。不要直接在正在提供服务的 `client/dist` 上运行会清空目录的构建。

### 服务与端到端验收

```bash
npm run check
npm test
BROWSER_RUNTIME_IMAGE=sha256:YOUR_VERIFIED_IMAGE_ID npx tsx scripts/accept-browser-service.ts
BROWSER_RUNTIME_IMAGE=sha256:YOUR_VERIFIED_IMAGE_ID npx tsx scripts/accept-browser-capacity.ts
```

真实容量脚本创建独立 ledger/容器，按 1/5/10 档运行快照与帧任务，保留内存余量并在 finally 清理。报告在 `output/librechat/`，不提交 Git。它是短时合成负载，不替代持续压测。

新增持续容量脚本使用独立 ledger、Docker instance 标签、回环数据 listener 和真实已授权 JPEG 连接：

```bash
BROWSER_RUNTIME_IMAGE=sha256:YOUR_VERIFIED_IMAGE_ID node --import tsx scripts/accept-browser-soak.ts --run
# 对照当前 5 会话配置：
BROWSER_RUNTIME_IMAGE=sha256:YOUR_VERIFIED_IMAGE_ID node --import tsx scripts/accept-browser-soak.ts --run --capacity=5
```

默认容量 10、持续负载 300 秒；仅允许容量 5 或 10。`--hold-seconds=30` 可用于短检查，少于 300 秒的结果不能作为提升至 10 的依据。约半数浏览器访问 GitHub 公开首页，其余访问 example.com；画面按生产数据 listener 的真实节奏推送，同时定期执行滚动和快照。没有 Qwen 调用、生产测试账号或私有仓库访问。

开始要求生产无活跃 lease、至少 8 GiB 可用内存；每秒观察生产 lease 和可用内存，出现真实用户、低于 3 GiB 或达到总期限时退出并清理。门槛为操作 p95 < 3 秒、每路帧间隔 p95 < 3 秒且平均至少每 3 秒一帧、生产回环配置接口 p95 < 1 秒；另检查排队到号、授权撤销和接管后原 session 可继续。

报告分别保存在 `output/librechat/browser-soak-10.json`、`browser-soak-5.json`，包含页面范围、持续时间、延迟、最低可用内存及清理结果。只有容量 10、完整 300 秒、所有检查及清理均通过，`eligibleForTenSlots` 才为 true。失败保持原生产容量，不降低门槛；不能用 5 会话通过或旧的轻页面短时测试替代。脚本结束时还按测试 instance 标签检查残留容器，并只读复核测试 ledger 无活跃记录。

2026-10-24 实测：10 会话触发内存保护，5 会话完整 301 秒通过，因此生产仍为 5。此次资源抽样和持续负载结果见进度文档；按用户最新要求暂不推进扩容。

LC 另需修改 workspace 的 `tsc --noEmit`、Browser/Redis/恢复策略 Jest、前端路由测试和 `E2E_CHROMIUM_CHANNEL=chrome LIGHTHOUSE_CHROME_FLAGS=--no-sandbox npm run lighthouse:run`。Lighthouse 使用一次性 DB/服务，不指向线上，且不与容量测试/构建并行运行。

`accept-librechat-accounts.mjs CONVERSATION_ID` 只访问回环验收站与 `accept-*@example.invalid` 测试账号，验证真实接管任务的账号隔离和后台归还恢复；`accept-librechat-budget.mjs` 临时将第二个测试账号余额置零，验证 SSE 拒绝与无扣费，并在 finally 恢复。不得改为生产账号执行。`accept-librechat-recovery.mjs` 验证真实 FIFO、停止和归还时零余额拒绝；`accept-librechat-logout.mjs` 验证 WS 撤销、任务取消及后台不重开。

`accept-librechat-turnstile.mjs [https://agentic-browser.zkpass.org]` 检查真实挑战拒绝路径；`accept-librechat-public.mjs` 检查公网封锁、缓存和无授权 WS 拒绝。它们不能代替真人挑战成功验收。

### 最终公网任务验收

`node scripts/audit-librechat-production.mjs` 只读核对真实普通账号、初始额度与消费账本、关闭自动补充，以及接管归还和任务完成记录。输出只有汇总结果，不含账号身份、聊天或仓库内容。仅对空闲、没有余额预留的账号核账；运行中的账号需等任务结束后再核对。

```bash
# 先启动隔离 LC / Browser（容量 1），使用独立 DB、Redis 前缀和 ledger。
node scripts/accept-librechat-public-journey.mjs --run --acceptance

# 隔离通过，明确获准占用生产容量且生产空闲后，运行一次。
node scripts/accept-librechat-public-journey.mjs --run
```

脚本使用 LibreChat 原生方法创建专用普通账号和内存中的短期登录 token，不自动完成注册、登录或 Turnstile 挑战，不改变生产挑战配置。公网模式通过真实 HTTPS/WSS 路径验证 Qwen 接管、跨账号拒绝、满额排队、取消撤销连接、自动到号与归还后完成。当前 5 个名额创建 6 个临时账号，使用 example.com 合成任务，不访问真实用户的 GitHub。

运行前要求无活跃 lease 且有足够内存；等待时检查真实用户到来、3 GiB 内存保留和 6 分钟期限，遇到这些条件退出并释放测试资源。测试会短暂占满名额并消耗 Qwen 额度。默认不带参数只显示用法。`finally` 取消专用任务，通过原生聊天删除接口清除 checkpoint/消息，再删除专用账号、余额和用量记录，并验证旧 token 已不能认证；Browser 终态审计记录仍按正常保留期限清理。

报告在 `output/librechat/acceptance-journey.json`、`public-journey.json`、`production-audit.json`。2026-10-24 最终汇总为 `public-journey-final.json`，保留原报告的清理告警，并关联同批次清理复核的通过证据。私密恢复清单保存在 `.deployment/librechat/journey-acceptance/` 或 `public-acceptance/`，权限 0700/0600，不保存密码和 token。失败诊断仅包含专用合成任务。清理失败时按报告的 `recoveryRunId` 执行：

```bash
node scripts/accept-librechat-public-journey.mjs --cleanup RUN_UUID
# 隔离环境需再加 --acceptance。
```

同一环境的 `running.lock` 防止并行验收；若进程被强制杀死，先核对确无验收进程，再移走该环境的遗留锁并执行对应清理。不要删除其他账号或清空整个数据库。人工挑战成功与 GitHub 业务结果的确认分别记录，不能用合成账号脚本代替。

## 日常巡检与已有备份验证

```bash
cd /home/ubuntu/Yu/agentic-browser
npm run health:librechat
npm run verify:librechat-backup -- --run 20261022T204507Z
```

`health:librechat` 是只读巡检，每项独立报告；退出码 **0 正常、1 告警、2 故障**。输出在 `output/librechat/health-latest.json`，每次原子替换。不会创建账号或浏览器、修改额度、调用模型或修复生产状态。它不依赖曾有真人任务或未过期的历史记录，适合正常空闲期间使用；`audit-librechat-production.mjs` 则用于特定发布的账号/额度/真人任务证据，不宜替代日常巡检。

巡检覆盖 systemd 及运行容量与配置一致、回环三个 HTTP listener、公网首页和 MCP/internal/旧入口封锁、Mongo/Redis ping、SQLite `quick_check` 与配额/回收/outbox、可用内存及磁盘、私密配置权限与 Turnstile/credits 防护，以及数据备份时效/恢复证据。单次结果只是当时状态，不证明模型或完整用户流程可用。

| 检查异常 | 处理方向 |
| --- | --- |
| `private_configuration` 或 systemd/HTTP/数据库 error | 在服务器检查对应组件；不将原始日志或密钥复制到报告 |
| `browser_ledger` error | 检查超时 lease、超过 2 分钟未确认的事件和清理；不要手工删除占位记录来释放名额 |
| `browser_ledger` warning | 存在 `cleanup_pending`，资源仍占配额；检查 Browser Service 的清理原因 |
| `host_resources` warning/error | 内存少于 3 GiB 或磁盘少于 5 GiB 时告警，少于 1 GiB 时故障；不自动扩容/删数据 |
| `data_backup` warning | 缺少数据库备份或最新一份已超过 24 小时；前端/单 Agent 备份不计入 |
| `backup_restore` warning | 最新 Mongo 归档尚无匹配 SHA-256 且清理成功的恢复证据，需运行隔离验证 |

`verify:librechat-backup` 默认不带参数只显示用法，只接受 `.deployment/librechat/backups/` 下的一层目录名，读取其中的 `manifest.json` 和 `production-mongo.archive.gz`。拒绝符号链接、非私密文件、超过 64 MiB 的压缩归档或内存余量不足。使用 Compose 中已在本机存在的固定 Mongo 镜像，无自动拉取。

恢复容器无外网、发布端口、宿主目录/生产数据挂载，限制 1 GiB 内存和 0.5 CPU；数据写入临时 tmpfs，2 GiB 是文件系统上限而非预分配内存，实际仍受容器内存上限约束。将 `LibreChatBrowserDemo.*` 映射至 `restore_verification.*`，恢复集合与索引，并逐集合运行完整校验；仅在测试容器关闭 TTL 删除。不启动 LibreChat，不调用 Qwen，不恢复或重放任务。

每次演练有独立 UUID 和容器标签，结束时按标签清理，验证零残留。报告存入 `output/librechat/backup-restore-UUID.json` 和 `backup-restore-latest.json`，只含时间、SHA-256、数量、阶段和清理结果。失败不会输出原始 `mongorestore` 日志。若进程被强制杀死或 Docker 不可用，按名称 `librechat-restore-UUID` 和标签 `dev.agentic-browser.restore-check=UUID` 确认测试实例后清理；不要批量删除其他 Mongo 容器。

2026-10-24 已验证切换前归档能恢复 60 个集合和 64 条记录，索引与清理通过。这证明该 Mongo 归档可恢复，**不证明备份足够新、跨集合/服务一致、配置密钥已备份，或整站恢复成功**。当前尚未配置定期备份/巡检任务，下一阶段补齐一致备份生成与完整恢复流程。

## 备份、日志和回滚

- Mongo 用 `mongodump` 备份生产 DB；Redis 保存 AOF 卷；Browser SQLite 与 runtime ledger 在停止 Browser Service、确认清理完成后一起备份。备份目录 0700，私密配置单独保管，不放代码或构建上下文。
- 记录两项目 git commit、工作区变更、Node 版本、runtime image ID、配置摘要和备份时间；JWT/加密密钥不可随升级重生成。
- 原始服务日志可能含账号或站点内容，仅在服务器保存。查看 LC 验收日志可用 `node scripts/read-librechat-log.mjs /tmp/lc-browser-server.log` 脱敏，报告不要包含密码、token、完整请求或私密页面截图。
- 应用升级失败时停止新会话、保留数据库/ledger，回到上一已验收的集成版本；没有可用版本则启用维护页。**不能通过重新开放公共 MCP 作为回滚方式。**
- 控制 API 不可用时注销返回可重试错误，不宣称远程浏览器授权已撤销；服务恢复后重试注销会关闭该账号连接与 lease。会话绝对 TTL 提供最终回收边界。
