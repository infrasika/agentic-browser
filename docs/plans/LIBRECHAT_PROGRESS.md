# LibreChat Browser Demo 开发进度

实施依据：[设计](LIBRECHAT_INTEGRATION.md) / [开发计划](LIBRECHAT_DEVELOPMENT.md) / [部署](../../deploy/librechat/README.md)。更新：2026-10-25（北京时间）。

## 当前状态

**公开入口已于 20:47 UTC 切换到 [Browser Demo](https://agentic-browser.zkpass.org)。** 使用用户选择的 `qwen3.7-plus`；Qwen、Turnstile、管理员和服务密钥已配置，无需重复填写。

**D0–P5 已完成，发布验收按当前 5 个活跃 session 的配置通过。** 原生浏览器工具、聊天同屏、排队、接管归还自动继续、后台恢复、账号隔离、credits 和注销回收已通过隔离真实验收。2026-10-24 新增真实普通账号与初始额度只读核账、一次 6 个临时普通账号的公网 HTTPS/WSS/Qwen 任务验收，以及用户对 GitHub 私有仓库数量和名称的确认。公网合成测试通过后，清理脚本的取消竞争已修正并完成清理复核；全部临时账号、聊天和账本已删除，测试浏览器为 0。

公网脚本通过原生方法配置测试账号与短期 token，不自动完成注册/登录或 Turnstile；真实账号和挑战证据、合成任务证据、GitHub 真人结果分别记录。**系统硬上限已按用户要求从 20 降为 10；当前运行仍放行 5，提高放行量前需复测。**

后续 P6 持续容量验收已完成：5 会话通过 301 秒混合页面负载；10 会话触发 3 GiB 内存保护，未满足提升条件，生产保持 5。按用户最新要求，暂不推进扩容。P7 日常巡检与既有 Mongo 备份的隔离恢复演练已完成；P8 全站预算、管理员入口和邮件找回也已上线并完成验收。P9 自动备份已启用，隔离应用恢复演练也已通过；巡检 16 项全部正常。定时巡检/主动告警、异地副本及裸机环境重建仍为后续工作。新增报告和结果见本文末尾。

| 阶段 | 状态 | 证据 / 剩余事项 |
| --- | --- | --- |
| D0 开发准备 | 完成 | 双独立项目、固定上游、依赖、私密配置 doctor |
| P0.1 原生工具与持久恢复 | 通过 | 真实 Run + Mongo checkpoint；真实站点跨 LC 重启后继续原任务 |
| P0.2 账号、credits、Qwen | 通过隔离真实验收 | 双账号独立、登录不重置；零余额新任务和归还恢复均拒绝且不调用模型 |
| P1 私有 API | 通过 | 后端身份、owner/task/actor、单次 grant；公网控制路由不可达 |
| P2 配额与事件 | 通过 | SQLite FIFO/outbox；每账号 1/硬上限 10；清理失败继续占位；真实排队到号 |
| P3 同屏面板 | 通过隔离真实验收 | JPEG 只读 + noVNC 输入；human 期间模型不可观察/操作；390px 手机上下同屏无横向溢出 |
| P4 后台自动恢复 | 通过 | 真实接管归还、关闭网页后继续；取消/注销不会被恢复 worker 重开；预算不足释放资源 |
| P5 发布 | 完成，当前放行 5 并发 | 生产服务、备份、Nginx、真人挑战、普通账号/初始额度、公网 6 账号隔离与排队、归还恢复及 GitHub 真人结果均已留证 |
| P6 持续容量与放行 | 验收完成，10 未达放行条件 | 5 会话完整 301 秒通过；10 会话触发内存保护，保持生产 5；两轮测试资源均已清理 |
| P7 日常巡检与备份验证 | 完成限定范围 | 15 项正常，1 项备份超过 24 小时告警；既有 Mongo 归档恢复 60 个集合/64 条记录，索引与清理通过；不等同完整灾难恢复 |
| P8 全站预算、管理与邮件 | 已发布 | 20,000,000 credits/日，上海零点；管理员查看/调整预算、账号充值；Cloudflare 找回邮件；隔离完整链路、真实 Qwen、UI、性能与公网权限通过 |
| P9.1 自动备份 | 已启用 | 北京时间 04:00 起按小时空闲重试，每天一份、保留 7 份；真实备份、恢复与重复执行幂等通过 |
| P9.2 应用恢复 | 隔离演练通过 | 从完整备份启动两项应用，账号/聊天/credits/预算与权限保持；复用本机匹配依赖和固定镜像，尚非裸机重建 |

## 项目与实现

- Browser：`/home/ubuntu/Yu/agentic-browser`，分支 `codex/librechat-integration`；集成主提交 `fc6c824`。
- LibreChat：`/home/ubuntu/Yu/librechat-agent`，分支 `codex/browser-demo`；上游 `61892206974618971b9001d109485d994dac2816`，标识 `v0.8.9-rc1`；定制提交 `b79c128`。
- LC 新逻辑在 `packages/api/src/browser/`，共享协议在 data-provider，Turnstile 配置映射在 data-schemas；`api/` 负责依赖注入与路由接线；同屏 UI 在 `client/src/components/Chat/Browser/`。
- 执行链路：原生 graph tools + 固定 Browser Skill 指引 → 私有 HTTP Browser Service。新部署不安装、不运行 MCP。
- 内部恢复绑定原 generation/user/task，使用短期 JWT 与 HMAC，经过标准账户/权限/余额检查。已补齐上游 resume 路径缺少的原子余额预留。
- Turnstile 服务端验证 success/hostname/action；修复 AppService 投影丢失 verification 配置，增加真实 HTTP 拒绝验收。
- 注销先终止当前用户的原生浏览器任务，再撤销 viewer/lease；持久 cancelled 事件只终止任务，不触发模型续跑。封禁/删除账号也不恢复执行。
- 运行放行 **5** 个活跃 session；每账号 1，系统硬上限 10。初始 **200,000 credits**，不自动补充。终态历史默认保留 24 小时，未确认事件与未清理资源不删除。

## 验收证据

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| Browser check / tests | 既有 72 项通过；容量调整后定向 9 项通过 | 含 11 人竞争 10 名额、持久事件、幂等、清理失败与保留策略 |
| LC Browser/Redis/HITL Jest | 通过，165 tests | 含恢复余额与注销取消修复；最终注销分组额外 13 tests 通过 |
| Turnstile AppService 投影回归 | 通过，2 tests | verification.required/hostname/timeout 保留；未配置时不改变其它部署 |
| LC ChatRoute/ChatView | 通过，28 tests | 初始消息并行加载、路由切换、面板接入 |
| 类型、lint、生产构建 | 通过 | data-provider/API/client/data-schemas 类型检查；相关源码 lint；API/client/data-schemas 最终构建 |
| 提交静态检查 | 通过 | LibreChat 提交钩子通过 ESLint、格式、import、package.json、设计规则、CSS 与循环依赖检查；生成协议按目标格式同步 |
| Lighthouse | 通过 | 3 次冷加载中位 LCP 3379ms / TBT 360ms / CLS 0.018；预算 4500/500/0.1 未调整 |
| 真实 Browser Service | 通过，最终复验 20:50 UTC | `browser-service-real.json`：Example Domain 实际内容、JPEG、人工输入、归还保留页面、FIFO、全部清理 |
| 真实 Qwen + UI 闭环 | 通过 | example.com → handoff → 归还 → snapshot → 回复 → close；`output/playwright/librechat-handoff.png` |
| 双账号与后台恢复 | 通过 | `accounts-real.json`：聊天/画面/取消隔离，离开网页后继续，登录不重置 credits |
| 零余额新任务 | 通过 | `budget-real.json`：明确 token_balance 拒绝，无模型扣费与浏览器创建 |
| 排队、停止、零余额恢复 | 通过 | `recovery-real.json`：第二账号排队、停止后自动到号、原任务不复活、归还时零余额不调用模型 |
| 注销回收与不复活 | 通过，20:46 UTC | `logout-real.json`：已认证 input WS 关闭、原任务终止、无 live lease，10 秒多轮 worker 无重建或扣费 |
| 移动布局 | 通过 | 390×844 页面宽度与文档宽度均为 390；`output/playwright/librechat-mobile-handoff.png` |
| 历史真实 Chrome 容量 | 1/5/10 短时通过；旧 20 档未通过 | `browser-capacity.json`：10 档快照+帧 p95 680ms；20 档前触及 3GiB 内存保护，全部清理。短时合成负载，不代表任意网页持续压力 |
| 私密配置 doctor / 协议同步 | 通过 | 不输出密钥；setup 重跑保留原值；两项目生成协议一致 |
| 生产 Turnstile 拒绝路径 | 原站、公网均通过 | `turnstile-origin.json` / `turnstile-public.json`：登录和注册均拒绝缺失/无效 token |
| 公网 Nginx / WS | 通过 | `public-routing.json`：MCP/internal 404，旧匿名入口 410，伪造身份头不能登录，WSS 可 Upgrade 但错误 grant 被关闭；Cloudflare DYNAMIC，首页 no-store |
| 真人公网挑战 | 通过 | 2026-10-23 用户的真实注册/登录通过强制 Turnstile 中间件；重复邮箱和密码不匹配发生在后续认证阶段 |
| 真实普通账号与初始额度 | 通过只读核账 | `production-audit.json`：普通本地账号存在；余额减账本净变动精确对应 200,000 初始 credits；不自动补充，已有归还和完成记录 |
| 公网多账号任务 | 通过，一次生产测试 | `public-journey-final.json`：6 个临时 USER、5 满额 + 1 排队；跨账号聊天/状态/画面授权/控制/取消拒绝；有效 WSS、取消撤销、自动到号、Done 后真实 Qwen 完成 |
| 公网测试资源清理 | 复核通过 | 原清理报告遇到取消竞争；`journey-cleanup-d865cbca-5307-46f0-b826-57deb2adf326.json` 确认 6 账号及聊天/余额/用量已清除，已删除账号 token 被拒绝，live browser 为 0 |
| GitHub 私有仓库业务结果 | 用户确认通过 | `github-inventory-human.json`：用户核对当前个人账号的数量和名称一致；未记录仓库名称，不推断任意分页规模都已验证 |

## 部署记录

- 两个 systemd unit 已 enable/active：`agentic-browser-service`、`librechat-browser-demo`。Node 固定 24.22.1，runtime 固定镜像 ID。
- 生产仅回环监听：LC 3080、Browser 控制 8081、画面 8082；Mongo 27019、Redis 6381；控制端口没有公网 Nginx 映射。
- 目标站点 `/etc/nginx/conf.d/agentic-browser.conf` 已安装 `deploy/librechat/nginx.conf`，全局 `nginx -t` 后 reload；其他站点未改。
- 切换前备份：`.deployment/librechat/backups/20261022T204507Z/`，含原 Nginx、生产 Mongo archive、Redis snapshot、停止状态下的 Browser ledger 及版本清单；目录 0700。
- 旧 `agentic-browser-demo-controller-1` 已停止且关闭自动重启；独立 `agentic-browser-ui-preview-controller-1` 保留。没有重新开放公共 MCP 的回滚路径。
- 隔离 LC 3091 和 Browser 18081/18082 已停止释放资源；验收数据与报告保留。验收 Nginx 3081 仅回环监听。
- 注册防护预检期间产生的唯一合成生产账号已清理；公开注册自动化因挑战未完成，没有创建测试账号。

## 后续容量与维护限制

1. 当前 5 会话发布没有待用户填写的密钥或未完成的发布验收项。普通账号/credits 由生产只读证据确认，公网隔离与排队由专用账号验证，GitHub 列表由用户核对；合成脚本不替代真人 Turnstile 挑战。
2. 当前 4 vCPU / 15GiB，放行 5。P6 新增 5 分钟持续画面/滚动/快照测试，确认当前 5 会话配置通过；10 会话因内存余量不足未通过。按用户最新要求暂不考虑扩容，保持当前配置。更长时段和更大 GitHub 分页规模仍属后续覆盖范围。
3. codebase-memory-mcp 可用时优先使用；索引未覆盖或 Transport closed 时按项目规则回退。不修改用户已有 `scripts/update-nginx.sh`。
4. 上游在 MCP 功能关闭时仍有图标目录查询，控制台可出现预期 404；页面和原生工具流程不依赖这些响应。当前不为消除图标请求重新开放 MCP 路由。

## 2026-10-23 登录问题排查

用户报告 signup 跳转后登录失败。服务器两次注册记录均为 Email in use；数据库仍只有部署时创建的管理员，未产生新账号。随后登录记录为 Password does not match，未见封禁或限流记录。已在内存中使用 bcrypt 核验 DEMO_ADMIN_PASSWORD 与该账号密码散列匹配，不输出密码或散列。

LibreChat 为避免泄露邮箱是否已注册，对重复邮箱也返回统一的 HTTP 200 注册提示；该操作不会覆盖已有密码。直接使用 `.deployment/librechat/private.env` 中 DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD 登录。重复 signup 不是密码重置。

## 2026-10-23 GitHub Demo

- 将两个 example.com 聊天入口替换为 GitHub 公开介绍和私有仓库统计。默认统计当前个人账号拥有的 private 仓库，返回数量及 `owner/name`，不打开代码内容；任务指引包含登录核验、范围/可见性筛选、分页去重、部分结果与清理规则。
- LibreChat `config/browser-demo.json` 统一管理入口与任务指引，Browser 项目的部署渲染器复用。补齐已有 Agent 的受控配置更新，重启不重置账号/credits、不重复创建 Agent 版本；不新增 MCP、OAuth 或 GitHub API token。
- API 构建、workspace 类型检查、相关 lint 与 3 项 bootstrap 回归通过；覆盖已有 Agent 更新幂等、禁止改写其他 owner，以及更新失败不能报成功。
- 本次受影响的静态检查通过；Lighthouse 复验通过，三次冷加载中位 LCP 3213ms / TBT 349ms / CLS 0.018，预算未调整。
- 真实 Qwen + Chrome + UI 验收通过：点击私有仓库卡片 → 打开 GitHub 登录页 → 立即人工接管；未输入凭据就点击继续 → 自动恢复、读取新快照 → 再次请求登录，没有误报零仓库。退出后 lease 已回收。报告 `output/librechat/github-demo-real.json`，截图 `output/playwright/github-demo-starters.png`、`github-demo-handoff.png`。
- 已更新公开部署，2026-10-23 19:21（北京时间）复核通过：生产 Agent 与 modelSpecs 文案一致；账号、密码、角色、余额、模型和 owner 保持原值；服务重启及第二次 bootstrap 合计仅产生一个新 Agent 版本。公网及回环配置接口正常，隔离验收进程已停止。报告 `output/librechat/github-demo-production.json`；LibreChat 提交 `5271643`。
- **2026-10-24 用户已确认私有仓库数量和名称与实际列表一致**。这是用户当前账号的真人业务验收，报告 `output/librechat/github-inventory-human.json`；自动化没有登录用户的 GitHub，不将本次确认扩展为任意分页规模的验证。

## 2026-10-23 聊天历史标题

- 原因：部署配置关闭了 Qwen 的 `titleConvo`。启用上游即时标题生成，使用已有模型和凭据，根据首条用户请求生成简短名称；无新增 LibreChat 业务代码。
- 真实 Qwen 验收：英文卡片生成 `Count and List Private GitHub Repos`，人工接管期间已显示、刷新后保留；中文请求生成 `三句话介绍GitHub用途`。标题用量进入 credits 账本；零余额拒绝模型执行，无标题调用或额外扣费。
- 旧默认标题通过上游 `saveConvo` 的 generated 模式补名：限定用户和会话、不覆盖手动标题、不新增会话、保留消息与历史排序；先保存私密备份。隔离真实数据库已验证这些约束。
- 已于 2026-10-23 19:46（北京时间）通过上游 Redis 配置失效通知在线加载，无需重启；运行进程确认重新读取配置，正在人工接管的浏览器保持运行。19:48 完成旧默认标题补名，共 3 条，更新前创建的非手动默认标题剩余 0 条。
- 配置 schema、脚本语法和 diff 检查通过；Lighthouse 复验通过，中位 LCP 3416ms / TBT 422ms / CLS 0.018，预算未调整。
- 报告 `output/librechat/chat-titles-real.json`、`chat-titles-backfill.json`；截图 `output/playwright/chat-title-handoff.png`。

## 2026-10-23 浏览器交接显示

- 修复正常控制权切换被误报断线的问题：立即显示交接状态，保留上一帧，收到并解码新的只读画面后再切换。旧连接的关闭及迟到错误不会覆盖新连接状态；实际连接失败和超时仍显示重连入口。
- 保留后端 revision / viewer 撤销机制，同一 Chrome 与 lease 继续运行；冻结帧仅在当前页面内存中保留，恢复或离开会话后清除。新增 `browser.viewerConnectTimeoutMs` 配置，默认 30 秒。
- 前端 7 项交接/异常/清理回归、API 10 项回归通过；data-provider/API/client 类型检查、相关 lint、构建与受影响静态检查通过。Lighthouse 三次冷加载中位 LCP 3661ms / TBT 456ms / CLS 0.018，预算未调整。
- 隔离真实 Qwen + Chrome + UI 验收通过：将控制响应延迟 1.5 秒，确认旧输入连接撤销后仍显示冻结帧，随后显示只读画面，全程无断线提示，浏览器 session 不变；主动断开 viewer 后可重连；Done 后任务自动恢复并完成。390px 深色手机布局无横向溢出。
- 首次发布于 12:24 UTC 完成公网复核，页面及 44 个入口/样式/面板资源正常；发布前生产无活跃 lease，仅重启 LibreChat，Browser Service 未重启。旧前端与发布记录已备份，旧哈希资源保留。最终版本及复核时间以私密 `release.json` 和 `browser-display-production.json` 为准。
- 报告 `output/librechat/browser-display-real.json`、`browser-display-production.json`；截图 `output/playwright/browser-returning-control.png`、`browser-returning-mobile.png`、`browser-display-mobile.png`。隔离验收进程已停止，无需新增密钥配置。

## 2026-10-24 最终公网验收

- 用户确认 GitHub Demo 的私有仓库数量、名称与实际列表一致。生产只读核账确认真实普通本地账号、200,000 初始 credits、正常扣费与关闭自动补充；报告不含账号身份、消息或仓库内容。
- 隔离测试发现 Qwen 在一次排队到号、接管归还后误把 handoff 工具返回值理解为“刚交出控制”，再次提示点击 Done 并结束。LibreChat 工具现在仅在真正归还后给出明确 `control_returned` 事件与继续指引；过期返回 `session_ended`，不伪报成功。不是用前端消息触发续跑。
- LibreChat 修复提交 `7c76d9a`；真实 Run/Mongo checkpoint 回归 3 项、API `tsc --noEmit`、相关 lint、构建和提交静态检查通过。未改动页面和加载链路，沿用前次 UI/Lighthouse 验收。
- 修复后的隔离真实 Qwen 验收全部通过：容量 1、两个专用账号，排队/接管/归还/快照/关闭闭环，账号和会话全部清理。报告 `acceptance-journey.json`。
- 经用户明确批准，在生产无活跃会话时运行一次公网测试：6 个临时普通账号、5 个浏览器名额、9 项检查通过；任务完成时记账用量约 12,838 credits。测试使用 example.com，不接触用户的 GitHub 或私有仓库，也不关闭生产 Turnstile。
- 初始公网报告保留清理失败标记：后台 worker 取消任务与测试脚本的显式 abort 产生竞争，后者收到任务不存在。实际账号/聊天/余额已删除。脚本已改为在确认 generation 不活跃后接受该竞争，并支持对已删除账号继续复核清理。执行同一批次的 `--cleanup` 后通过；没有再运行第二轮付费公网任务。
- 最终结果汇总 `public-journey-final.json` 链接原始任务报告和清理报告，不改写失败记录。6 个专用账号、聊天、余额/用量均无残留，已删除身份的签名 token 被拒绝，活跃测试浏览器为 0；Browser 终态审计按正常 TTL 保留。隔离服务已停止，生产服务健康。

## 2026-10-24 容量上限调整

- 按用户要求将全局 session 硬上限从 20 降为 10，每账号仍为 1。当前生产运行放行量保持已验收的 5；额外用户继续排队。
- 同步调度器默认值/校验、Browser Service 配置边界、部署渲染器，以及 1/5/10 容量验收脚本。配置 11 会被拒绝；历史 20 档测试结果仅作为旧记录保留。
- 类型检查、服务相关 9 项回归通过，包含 10 个运行、第 11 个排队、清理确认前不释放名额。额外验证部署默认 5、接受 10、拒绝 11，及服务启动在运行时初始化前拒绝 11。报告 `output/librechat/capacity-limit-change.json`；本次没有创建真实浏览器或调用 Qwen。
- 在生产无活跃 lease 时重启 Browser Service，使新上限生效；内部健康检查和公网首页均正常，未重启 LibreChat。

## 2026-10-24 持续容量验收

- 用户授权“验收通过后提升到 10”；实际条件未满足，生产放行量保持 5，硬上限 10。本轮没有修改生产配置、重启服务、创建生产账号或调用 Qwen。
- 新增 `scripts/accept-browser-soak.ts`，独立 ledger / Docker instance / 回环画面服务，真实 JPEG viewer 按生产 750ms 定时器发送；约半数 GitHub 公开首页、其余 example.com，定期滚动和读取。检查生产空闲、3 GiB 内存保留、画面/操作延迟、排队、授权撤销、接管和最终资源回收。只读探测生产配置接口，不读取真实账号或私有页面。
- 10 会话：全部浏览器和 viewer 已启动，持续负载未完成即触发 `memory_reserve_3_gib`，最低可用内存 2,795 MiB。报告 `output/librechat/browser-soak-10.json` 为失败，`eligibleForTenSlots=false`，不能用历史轻页面短时通过代替。
- 5 会话：3 个示例页 + 2 个 GitHub 首页，持续 301 秒、57 轮滚动/快照；操作 p95 **437ms**，生产配置接口 p95 **24ms**，各路帧间隔 p95 **794–1,032ms**，最低可用内存 **6,515 MiB**。额外任务满额排队、释放后到号、旧 viewer 撤销、接管归还维持同一 session 均通过。报告 `output/librechat/browser-soak-5.json`。
- 两轮结束均确认测试容器 0、测试 live lease 0。5 会话期间的一次 Docker 资源抽样显示示例浏览器均约 655 MiB、GitHub 浏览器均约 1,004 MiB；仅是该时刻的 Docker 内存读数，不作为峰值或 10 会话外推证明。报告 `browser-soak-5-resources.json`。
- 新脚本独立 TypeScript 检查通过；默认不带 `--run` 不启动测试，非法容量及越界/零时长均在资源初始化前被拒绝。未改动应用行为和页面，无需重跑 Qwen 或 UI 发布验收。

## 2026-10-24 日常巡检与 Mongo 备份恢复演练

- 按用户要求转向运维，保持实际容量 5 / 硬上限 10，没有重启生产服务或调用 Qwen。原有 `workspace-backup.sh` 属于旧 Compose 安装，不套用到 LibreChat。
- 新增 `npm run health:librechat`，检查配置、systemd 实际运行容量、回环 HTTP、公网首页及 MCP/internal/旧入口封锁、Mongo/Redis、只读 SQLite、超时与清理、事件消费、主机资源和备份。使用独立只读 SQL 事务，不初始化会回收容器的运行时对象。历史事件正常过期不影响健康结论。
- 新增 `npm run verify:librechat-backup -- --run 20261022T204507Z`。已用部署固定的 Mongo 镜像，在无网络/端口/宿主目录挂载的临时容器中，将旧备份恢复到独立库名；限制 1 GiB 内存 / 0.5 CPU。关闭测试 Mongo 的 TTL 删除，避免验证期间自动删除归档记录；不启动应用或恢复任何任务。
- 首次演练因临时磁盘低于 Mongo 创建索引所需的剩余空间而失败，原失败报告保留，清理通过。调整测试 tmpfs 的容量上限后，于 **16:11（北京时间）** 成功恢复 **60 个集合、64 条记录**，集合/索引校验通过。内存限制仍为 1 GiB。最终临时容器为 0。
- 报告 `output/librechat/backup-restore-latest.json` 及按运行 UUID 保存的历史报告；通过证据绑定归档 SHA-256，归档变化后旧结论失效。报告不含账号、集合内容或原始恢复日志。
- 生产巡检 `output/librechat/health-latest.json`：**15 项正常、1 项 warning**；活跃/排队/待清理 lease、延迟事件均为 0。告警是完整数据库归档距今约 **35 小时**，超过新增的 24 小时时效标准。恢复成功不消除时效告警；近期前端资源/单 Agent 备份不能代替数据备份。
- `npm run check` 和新增 5 项回归通过，覆盖故障时继续巡检且不泄露异常内容、空历史、超时/清理/outbox、只读不改账本、旧数据与新资源备份区分、归档改变后证据失效、HTTP 假成功、危险路径/权限/符号链接拒绝。未改动应用加载或 UI，无需重复付费公网任务和 Lighthouse。
- 本轮没有安装定时器或完成整站灾难恢复。下一阶段是定期生成一致备份、保护配置密钥并演练完整恢复；当前仅证明该历史 Mongo 归档可恢复。


## 2026-10-25 全站预算、管理入口与邮件找回（已发布）

- 用户选定每日 **20,000,000 credits**（约 100 份初始赠额、当前费率约 $20），上海零点更新账期。每次 Qwen 请求先原子预留、再按 usage 结算；聊天、标题和工具恢复共用预算。个人初始 200,000 credits 不自动补充，生产保持实际容量 5 / 硬上限 10。
- 管理员登录后从设置 → 常规 → Admin Panel 或 `/demo-admin` 进入，查看预算与用户余额、调整每日预算、给普通本地账号增加 credits。普通用户管理 API 返回 403，匿名返回 401，只有管理员配置中提供入口；充值幂等，修改预算带版本校验和审计。
- 实际 Cloudflare SMTP 最初拒绝根域发信。用户确认开通 `mail.zkpass.ai`，改为 `replay@mail.zkpass.ai` 后，一封测试邮件已被 Cloudflare 接受；私密指纹收据允许启用生产找回入口。2026-10-25（北京时间）用户明确确认测试邮件已收到，实际送达验收完成，没有重复发送测试邮件。
- 找回复用原生流程与 SMTP 465 隐式 TLS。补齐过期时间即时检查，避免 Mongo TTL 延迟清理使旧链接继续有效；通过验证后原子消费 token，防并发重复使用。隔离邮件捕获验证完整链接、单次有效、过期拒绝、限流、旧登录失效和 credits 不变；没有修改真实用户密码。
- 隔离完整链路发现预算拒绝后上游兜底估算错误文字并扣个人额度，已修复。零总预算时没有模型请求、个人余额不变；恢复额度后聊天与标题都正确结算。报告 `output/librechat/controls-acceptance.json`。
- 真实 Mongo 并发/幂等/跨日/充值 5 项、预算/管理/custom endpoint/错误处理 132 项、用量 150 项、密码重置 21 项、CJS 认证接线 88 项、管理 UI 4 项及部署配置/邮件 3 项测试通过。修改 workspace 的类型检查、定向 lint、格式/import/静态检查通过；提交钩子未改变验收过的代码。
- Playwright CLI 验证管理员登录、保存/恢复预算、充值、设置入口，桌面和 390px 手机浅/深色布局；报告 `controls-ui.json`，截图 `output/playwright/demo-admin-*.png`。最终 Lighthouse 三次冷加载中位 LCP **3527ms** / TBT **356ms** / CLS **0.018**，原预算未调整。
- 一次真实 `qwen3.7-plus` 流式请求通过受保护 transport，使用独立 Mongo 库，记账 **6 credits**，预留与不确定成本均为 0；测试库清理完成。报告 `controls-qwen-smoke.json`。没有再次运行公网多账号付费任务。
- **2026-10-25 00:39（北京时间）已发布**，LibreChat 提交 `fbd717b`。发布前确认 Browser 占位/排队、Redis 运行/等待任务均为 0；备份后仅重启 LibreChat，Browser Service 与 Nginx 未变。保留旧前端哈希资源，运行制品与验收制品逐文件一致。
- 备份 `.deployment/librechat/backups/controls-20261024T163708Z/` 包含旧源码/制品、私密配置、Mongo archive、Redis snapshot、无活跃 lease 时的 SQLite 读备份。LC 停止后生成数据备份；首次全站预算计入本账期既有消费（本次为 0），不重置个人余额。
- 公网只读复核通过：账号/密码/角色/余额与发布前快照相同，管理员查询与普通/匿名拒绝正确，找回开关启用，43 个首页资源正常；`controls-production.json`。部署前后未创建生产测试账号、未调整真实账号额度。
- 附加历史核账脚本的个人账本部分通过，但 24 小时保留期外的 Browser 接管历史已过期，无法重新取得历史任务证据；该次报告保留为 `controls-ledger-audit.json`，不把它算作新的真人任务验收。此前 GitHub 真人确认与公网任务验收报告继续独立保留。
- 本次 Mongo 归档在无网络临时容器恢复 **64 个集合、182 条记录**，索引校验与清理通过；`backup-restore-latest.json` 绑定本次归档 SHA-256。最终 `health-latest.json` **16 项正常**，测试服务/测试库/恢复容器均无残留。
- P8 发布时的后续工作为 P9 定期备份与应用恢复，现已完成下述范围；本次 Mongo 恢复证据仍只对应该组件和归档。成本限制基于配置费率，不覆盖同一 Qwen key 在其他应用中的开销。测试邮件实际收件已由用户确认；密码重置完整业务链路仍以隔离验收为证据，没有对真实用户执行密码重置。


## 2026-10-25 自动备份与应用恢复（P9 完成当前范围）

- 新增 `backup:librechat`、备份策略和 systemd service/timer。北京时间每天 **04:00 起**尝试，忙时每小时重试至 23:00，带最多 5 分钟随机延迟，每天最多完成一份，保留最近 **7 份**自动备份；旧手动发布备份不参与自动清理。
- 先检查 Browser 占位/排队/待确认事件与 Redis 运行/人工等待任务；压缩静态制品后再次检查。Nginx 动态维护入口拒绝新请求，并排空已有 HTTP 请求，避免漏掉尚未登记为 generation 的请求。忙时延后，不为备份终止用户任务。
- 按 LC → Browser 顺序停止写入，确认正常退出，生成 Mongo、Redis RDB、SQLite、runtime ledger、私密配置、源码/构建制品和存在的上传资源备份；按相反顺序启动，三个回环入口健康后恢复公网。停止意图提前持久化，`finally` 和 `ExecStopPost` 均能恢复；救援不依赖备份策略文件或备份磁盘可用。
- 完整副本计算 SHA-256 后原子发布，`.pending` 不算成功备份。新副本通过隔离 Mongo 恢复后才轮转；保留策略只操作本工具带标记的完整自动副本。报告不含密钥、账号身份或聊天内容。
- **22:53（北京时间）首次真实备份完成**：`auto-20261025T145315Z-085c9f84`，维护 **12.76 秒**，两项服务自动恢复。9 个备份文件摘要校验通过，私密配置逐字节一致；Mongo 恢复 65 个集合、177 条记录，Redis RDB 格式和 SQLite 完整性通过。报告 `backup-automation-first.json`。
- 再次启动同一 unit 返回 `already_completed`，两项生产服务 PID 不变，没有维护窗口；报告 `backup-automation-repeat.json`。`librechat-browser-backup.timer` 已 enabled/active，首次小时调度同样幂等，下次有效备份进入下一天账期。
- 新增 `verify:librechat-recovery -- --run AUTO_BACKUP_NAME`：验证全份备份的摘要并安全解包，在无外网/发布端口/宿主数据挂载的专用 Mongo/Redis 网络空间内，恢复 RDB 后重建 AOF、重启 Redis，再启动恢复的 Browser Service 与 LibreChat。副本使用新 runtime ID，Docker 写操作被阻断，运行时模型/邮件凭据置为不可用。
- 首次完整演练发现旧 API workspace 的依赖映射缺失，已补齐；失败记录保留，专用容器清理成功，修复后删除含私密配置的诊断副本。最终 **23:28（北京时间）恢复验收通过**：恢复的构建模块/页面可用，2 个账号及密码散列/角色、个人余额、预算历史、聊天和消费账本保持一致；管理员/普通/匿名权限正确，没有旧任务重放或 Docker 写操作。Redis 从 RDB 转 AOF 后重启可加载；报告 `recovery-latest.json`。
- 演练期间生产进程保持不变，测试工作目录、应用进程和容器均已清理。最终生产巡检 **16 项正常**，容量保持运行 5 / 硬上限 10，没有 Qwen 调用、生产账号变更或新邮件。
- 备份/恢复定向测试 **13 项**（含真实独立 Nginx）、巡检相关 **5 项**、类型检查、脚本语法及 systemd unit/Nginx 配置校验通过。没有改动 LibreChat 应用代码或构建制品。
- 范围：备份仍在同一服务器；完整应用恢复复用了本机 lockfile 匹配的依赖与固定镜像。**异地副本、裸机依赖/镜像供应、定时巡检与主动告警尚未完成。** 恢复手册为 `deploy/librechat/RECOVERY.md`，不将本轮结论扩大为整台服务器丢失后的裸机重建已验收。
