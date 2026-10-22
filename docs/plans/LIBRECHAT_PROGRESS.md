# LibreChat Browser Demo 开发进度

实施依据：[设计](LIBRECHAT_INTEGRATION.md) / [开发计划](LIBRECHAT_DEVELOPMENT.md) / [部署](../../deploy/librechat/README.md)。更新：2026-10-22 UTC。

## 当前状态

**公开入口已于 20:47 UTC 切换到 [Browser Demo](https://agentic-browser.zkpass.org)。** 使用用户选择的 `qwen3.7-plus`；Qwen、Turnstile、管理员和服务密钥已配置，无需重复填写。

原生浏览器工具、聊天同屏、排队、接管归还自动继续、后台恢复、账号隔离、credits 和注销回收已通过隔离真实验收。公网 HTTPS、路由封锁、WebSocket Upgrade 与无效授权拒绝、缺失/无效 Turnstile 拒绝均通过。**P5 尚未全部验收：自动化浏览器停在真实 Turnstile 人机挑战，已请用户用自己的浏览器注册/登录并运行 Demo；不能把它记为真实注册成功。**

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
| 真人公网挑战与任务 | 待用户验收 | 自动化浏览器显示 Verify you are human；没有绕过或关闭挑战 |

## 部署记录

- 两个 systemd unit 已 enable/active：`agentic-browser-service`、`librechat-browser-demo`。Node 固定 24.22.1，runtime 固定镜像 ID。
- 生产仅回环监听：LC 3080、Browser 控制 8081、画面 8082；Mongo 27019、Redis 6381；控制端口没有公网 Nginx 映射。
- 目标站点 `/etc/nginx/conf.d/agentic-browser.conf` 已安装 `deploy/librechat/nginx.conf`，全局 `nginx -t` 后 reload；其他站点未改。
- 切换前备份：`.deployment/librechat/backups/20261022T204507Z/`，含原 Nginx、生产 Mongo archive、Redis snapshot、停止状态下的 Browser ledger 及版本清单；目录 0700。
- 旧 `agentic-browser-demo-controller-1` 已停止且关闭自动重启；独立 `agentic-browser-ui-preview-controller-1` 保留。没有重新开放公共 MCP 的回滚路径。
- 隔离 LC 3091 和 Browser 18081/18082 已停止释放资源；验收数据与报告保留。验收 Nginx 3081 仅回环监听。
- 注册防护预检期间产生的唯一合成生产账号已清理；公开注册自动化因挑战未完成，没有创建测试账号。

## 剩余验收与限制

1. 用户在自己的浏览器完成真实 Turnstile 注册/登录，运行至少一个 Demo；随后检查新账号 USER 权限与 200,000 初始 credits，以及公网任务/WS/归还恢复。
2. 最终发布验收还需公网第二账号隔离与排队确认；隔离环境已自动通过相同后端流程。
3. 当前 4 vCPU / 15GiB，首次放行 5。扩容或调整并发前重新压测；不能把逻辑硬上限 20 写成机器已支持 20 并发。
4. codebase-memory-mcp 持续返回 Transport closed，已按项目规则回退到定位文件读取；不修改用户已有 `scripts/update-nginx.sh`。
5. 上游在 MCP 功能关闭时仍有图标目录查询、禁用标题生成时仍有标题轮询，控制台可出现预期 404；页面和原生工具流程不依赖这些响应。当前不为消除这些请求重新开放 MCP 路由。
