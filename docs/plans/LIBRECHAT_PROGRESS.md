# LibreChat Browser Demo 开发进度

实施依据：[设计](LIBRECHAT_INTEGRATION.md) / [开发计划](LIBRECHAT_DEVELOPMENT.md) / [部署](../../deploy/librechat/README.md)。更新：2026-10-23（北京时间）。

## 当前状态

**公开入口已于 20:47 UTC 切换到 [Browser Demo](https://agentic-browser.zkpass.org)。** 使用用户选择的 `qwen3.7-plus`；Qwen、Turnstile、管理员和服务密钥已配置，无需重复填写。

原生浏览器工具、聊天同屏、排队、接管归还自动继续、后台恢复、账号隔离、credits 和注销回收已通过隔离真实验收。公网 HTTPS、路由封锁、WebSocket Upgrade 与无效授权拒绝、缺失/无效 Turnstile 拒绝均通过。**P5 尚未全部验收：用户已通过真实 Turnstile，注册/登录请求进入后续认证流程；本次 signup 使用的是预建管理员邮箱，重复注册不会覆盖原密码，随后登录因密码不匹配被拒绝。已核实私密配置中的管理员密码与数据库匹配。新账号创建及公网 Demo 闭环仍待完成。**

| 阶段 | 状态 | 证据 / 剩余事项 |
| --- | --- | --- |
| D0 开发准备 | 完成 | 双独立项目、固定上游、依赖、私密配置 doctor |
| P0.1 原生工具与持久恢复 | 通过 | 真实 Run + Mongo checkpoint；真实站点跨 LC 重启后继续原任务 |
| P0.2 账号、credits、Qwen | 通过隔离真实验收 | 双账号独立、登录不重置；零余额新任务和归还恢复均拒绝且不调用模型 |
| P1 私有 API | 通过 | 后端身份、owner/task/actor、单次 grant；公网控制路由不可达 |
| P2 配额与事件 | 通过 | SQLite FIFO/outbox；每账号 1/硬上限 20；清理失败继续占位；真实排队到号 |
| P3 同屏面板 | 通过隔离真实验收 | JPEG 只读 + noVNC 输入；human 期间模型不可观察/操作；390px 手机上下同屏无横向溢出 |
| P4 后台自动恢复 | 通过 | 真实接管归还、关闭网页后继续；取消/注销不会被恢复 worker 重开；预算不足释放资源 |
| P5 发布 | 已部署，待真人公网闭环 | 生产服务自启、备份、Nginx 切换与公网拒绝测试完成；真实 Turnstile 成功与公网双账号任务待验收 |

## 项目与实现

- Browser：`/home/ubuntu/Yu/agentic-browser`，分支 `codex/librechat-integration`；集成主提交 `fc6c824`。
- LibreChat：`/home/ubuntu/Yu/librechat-agent`，分支 `codex/browser-demo`；上游 `61892206974618971b9001d109485d994dac2816`，标识 `v0.8.9-rc1`；定制提交 `b79c128`。
- LC 新逻辑在 `packages/api/src/browser/`，共享协议在 data-provider，Turnstile 配置映射在 data-schemas；`api/` 负责依赖注入与路由接线；同屏 UI 在 `client/src/components/Chat/Browser/`。
- 执行链路：原生 graph tools + 固定 Browser Skill 指引 → 私有 HTTP Browser Service。新部署不安装、不运行 MCP。
- 内部恢复绑定原 generation/user/task，使用短期 JWT 与 HMAC，经过标准账户/权限/余额检查。已补齐上游 resume 路径缺少的原子余额预留。
- Turnstile 服务端验证 success/hostname/action；修复 AppService 投影丢失 verification 配置，增加真实 HTTP 拒绝验收。
- 注销先终止当前用户的原生浏览器任务，再撤销 viewer/lease；持久 cancelled 事件只终止任务，不触发模型续跑。封禁/删除账号也不恢复执行。
- 运行放行 **5** 个活跃 session；每账号 1，系统硬上限 20。初始 **200,000 credits**，不自动补充。终态历史默认保留 24 小时，未确认事件与未清理资源不删除。

## 验收证据

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| Browser check / tests | 通过，72 tests | 含 21 人竞争 20 名额、持久事件、幂等、清理失败与保留策略 |
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
| 真实 Chrome 容量 | 1/5/10 通过；20 未通过 | `browser-capacity.json`：10 档快照+帧 p95 680ms；20 档前触及 3GiB 内存保护，全部清理。短时合成负载，不代表任意网页持续压力 |
| 私密配置 doctor / 协议同步 | 通过 | 不输出密钥；setup 重跑保留原值；两项目生成协议一致 |
| 生产 Turnstile 拒绝路径 | 原站、公网均通过 | `turnstile-origin.json` / `turnstile-public.json`：登录和注册均拒绝缺失/无效 token |
| 公网 Nginx / WS | 通过 | `public-routing.json`：MCP/internal 404，旧匿名入口 410，伪造身份头不能登录，WSS 可 Upgrade 但错误 grant 被关闭；Cloudflare DYNAMIC，首页 no-store |
| 真人公网挑战 | 通过 | 2026-10-23 用户的真实注册/登录通过强制 Turnstile 中间件；重复邮箱和密码不匹配发生在后续认证阶段 |
| 真人公网登录与任务 | 待用户完成 | 使用配置文件中的预建管理员密码登录，或用未注册邮箱创建新账号后测试 Demo |

## 部署记录

- 两个 systemd unit 已 enable/active：`agentic-browser-service`、`librechat-browser-demo`。Node 固定 24.22.1，runtime 固定镜像 ID。
- 生产仅回环监听：LC 3080、Browser 控制 8081、画面 8082；Mongo 27019、Redis 6381；控制端口没有公网 Nginx 映射。
- 目标站点 `/etc/nginx/conf.d/agentic-browser.conf` 已安装 `deploy/librechat/nginx.conf`，全局 `nginx -t` 后 reload；其他站点未改。
- 切换前备份：`.deployment/librechat/backups/20261022T204507Z/`，含原 Nginx、生产 Mongo archive、Redis snapshot、停止状态下的 Browser ledger 及版本清单；目录 0700。
- 旧 `agentic-browser-demo-controller-1` 已停止且关闭自动重启；独立 `agentic-browser-ui-preview-controller-1` 保留。没有重新开放公共 MCP 的回滚路径。
- 隔离 LC 3091 和 Browser 18081/18082 已停止释放资源；验收数据与报告保留。验收 Nginx 3081 仅回环监听。
- 注册防护预检期间产生的唯一合成生产账号已清理；公开注册自动化因挑战未完成，没有创建测试账号。

## 剩余验收与限制

1. 用户使用私密配置中的管理员账号登录，或换未注册邮箱验证新账号创建，运行至少一个 Demo；随后检查新账号 USER 权限与 200,000 初始 credits，以及公网任务/WS/归还恢复。
2. 最终发布验收还需公网第二账号隔离与排队确认；隔离环境已自动通过相同后端流程。
3. 当前 4 vCPU / 15GiB，首次放行 5。扩容或调整并发前重新压测；不能把逻辑硬上限 20 写成机器已支持 20 并发。
4. 早期 codebase-memory-mcp 返回 Transport closed 时按项目规则回退读取；2026-10-23 GitHub Demo 开发时已恢复可用，索引未覆盖的新增模块按规则回退。不修改用户已有 `scripts/update-nginx.sh`。
5. 上游在 MCP 功能关闭时仍有图标目录查询，控制台可出现预期 404；页面和原生工具流程不依赖这些响应。标题生成已启用，不再按禁用路径运行。当前不为消除图标请求重新开放 MCP 路由。

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
- **真实私有仓库列表及跨页数量仍待用户登录后核验**；本次自动化没有登录用户的 GitHub，也没有读取其私有仓库。

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
