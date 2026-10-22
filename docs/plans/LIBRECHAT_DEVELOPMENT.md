# LibreChat Browser Demo 开发计划

状态：开发与隔离验收已完成，已部署；P5 真人公网闭环验收待完成。关联 [设计](LIBRECHAT_INTEGRATION.md)、[进度](LIBRECHAT_PROGRESS.md)。

## 目标与工作目录

公开入口 `https://agentic-browser.zkpass.org` 提供本地账号注册、一次初始 credits、聊天与浏览器同屏、排队、人工接管和自动归还恢复。浏览器控制只接受 LibreChat 后端服务身份，每账号 1 个 session，全局最多 20；公共 MCP 退休。

| 项目 | 开发目录 | 分支 / 基线 |
| --- | --- | --- |
| Browser Service、部署、验收与计划 | `/home/ubuntu/Yu/agentic-browser` | `codex/librechat-integration` |
| LibreChat 定制 | `/home/ubuntu/Yu/librechat-agent` | `codex/browser-demo`；上游 `61892206974618971b9001d109485d994dac2816` |
| 一次性私密配置 | Browser 项目 `.deployment/librechat/private.env` | 已在 Git 忽略目录内，目录 0700、文件 0600 |
| 自动验收产物 | Browser 项目 `output/librechat/` | 不进 Git；不记录密钥、输入内容或浏览器隐私画面 |

上游基线不是自动跟随 latest。首次 clone 保持完整独立仓库；不复制到 Browser 源码中。新 LC 后端逻辑在 `packages/api/src/browser/`，共享 schema/config 在 `packages/data-provider`；`api/` 只做依赖注入与路由接线。

## 实施前审查结论

架构可实施，但以下事项是必须验证的门槛：

1. 使用 LibreChat 真正的 graph tool / checkpoint 路径。队列与接管必须暂停模型执行并从持久记录恢复，不能长轮询占着 LLM 请求，也不能用前端发“继续”替代。
2. 现有 Docker ledger 将 ownerId 限为 UUID；LibreChat 账号 ID 不一定是 UUID。改用受限 opaque userId，不做一套隐藏的 UUID 映射身份系统。
3. 配额由 Browser scheduler 持久事务统一裁决。现有 runtime 清理机制复用，已失败但未清理的容器继续占位。
4. 同一任务与工具调用的重入须可识别；未知结果的网页提交不能自动重放。
5. Qwen 费率、usage、图像和工具调用能力必须对选定模型实测。现已选定 qwen3.7-plus，初始 200,000 credits，不自动补充。
6. 单机 4 vCPU / 15 GiB 暂不认定能跑满 20 个 Chrome；逻辑容量验收与物理负载验收分开记录。

## 阶段与验收

| ID | 工作内容 | 完成证据 |
| --- | --- | --- |
| D0 | 设计审查、固定双项目、私密配置初始化、计划与进度文档 | 版本可追溯；初始化重跑不覆盖秘密；缺配置只输出字段名 |
| P0.1 | LC 原生工具与持久暂停/恢复技术验证 | 真实上游 Run + 持久 checkpointer；重建执行器后恢复；tool 重入无重复副作用 |
| P0.2 | 本地账号与 credits / Qwen 配置 | 双账号余额独立；初始赠额不重置；余额不足不能新建或恢复任务；真实 Qwen usage 核对 |
| P1 | 私有 Browser 控制 API、协议、双 listener、owner/task 校验 | 服务认证；伪造 header、跨账号/任务、错误 actor、公共控制路由全部拒绝 |
| P2 | SQLite FIFO、每账号 1 / 全局 20、取消、超时、清理、outbox | 21 人竞争只占 20；同账号并发只占 1；失败清理不早释放；重启后不复活旧 session |
| P3 | 原生 BrowserPanel、排队状态、只读帧与人工 noVNC | 双账号真实浏览器隔离；只读输入失败；human 状态模型不可观察/操作；刷新不重复创建 |
| P4 | LC BFF、原生 tools、Browser Skill、后台事件恢复 | 排队到号与归还无需发消息；网页关闭仍可恢复；迟到/重复事件不重复执行；停止不会被唤醒 |
| P5 | 自动验收、成本与负载、生产部署配置、Nginx 切换 | 1/5/10/20 分档报告；有效的真实模型任务；安全注册；备份/回滚；公网 MCP 关闭 |

P0、P1、P2 可交错开发，但 P0.1 未通过不得声称自动恢复已可交付。任何原型或模拟测试在进度里明确标记，不能记成端到端通过。

## 接口与所有权

Browser 内部接口使用版本化 JSON，身份字段由 LC 登录态派生并结合独立服务 token；不接受浏览器直接提供的 X-User-ID。包括申请 lease、读取/取消 lease、动作、观察、控制权切换、viewer grant 与事件补拉/ack。

Browser 是 lease、queue、session 和 outbox 的唯一所有者；LC 是账号、credits、聊天、generation、checkpoint 的唯一所有者。停止、预算不足或 session 过期走幂等清理，不依赖模型调用 close。

UI 仅通过 LC BFF 获取状态和短期授权；数据 listener 只传画面/输入，拒绝 MCP、内部 API 和旧匿名入口。输入授权绑定用户、session、revision，一次性使用，不进入 URL 或模型上下文。

## 密钥与外部依赖

`npm run setup:librechat` 创建一次私密配置。随机生成服务 token、JWT 与加密密钥；重复运行保留已有值。`npm run doctor:librechat` 只报告已设置/缺失，不打印值。

用户需一次填写：

- 阿里云 API Key、可用模型、对应地域的 API base URL。实际费率在模型明确后核实。
- Turnstile Site Key / Secret Key，绑定 `agentic-browser.zkpass.org`。
- 首个本地管理员的邮箱与密码。

开发与模拟验收不等待外部密钥；真实模型与公网注册验收必须等待有效配置。首次管理员通过受控 bootstrap 创建，再开放注册，不能让首位公开访问者成为管理员。

## 自动化与检查

Browser：`npm run check`、定向单元/接口测试、现有隔离/控制权回归、真实 Docker runtime 验收。测试使用独立数据目录和端口，禁止清理其他项目容器或生产卷。

LC：按其 AGENTS.md 运行修改 workspace 的 `tsc --noEmit`、定向 Jest、格式/lint；账号/配置/启动与加载相关变更运行 Lighthouse。真实恢复测试使用上游 Run 与 Mongo checkpoint，不只 mock 返回值。

跨服务：自动脚本启动隔离的 Mongo/Redis/Browser/LC，创建两个测试账号，核对并发、排队、接管、归还、取消、余额、重启和泄漏。每次阶段验收输出 JSON 报告，记录 commit、命令、时间、pass/fail/skipped 与阻塞原因。

每批改动后更新进度文档：已完成、下一步、验证证据、待用户配置。没有必要重复询问已授权的开发步骤；发现新的产品取舍时继续无依赖工作，再提出具体问题。

## 发布门槛

旧线上服务保持运行至新系统达到切换条件。生成的生产 Compose/Nginx 必须单独校验，控制口不得发布公网，服务通信使用私网地址。镜像固定版本；不把配置秘密放进构建上下文。

先完成新系统隔离验收和密钥检查，再排空旧会话、备份数据与配置、启动新 listener、`nginx -t`、切换并做公网双账号任务。失败回到维护页或上一集成版本，不以重新开放公共 MCP 兜底。

容量硬上限 20 与运行时放行容量分别配置；只发布压测证实的容量。超出机器承载力时保留排队并报告所需资源，不把限流改成无限制。
