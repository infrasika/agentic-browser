# 开发进度

更新时间：2026-10-26。本文只记录当前产品状态；设计见 [架构](../ARCHITECTURE.md)，工作项见 [开发计划](LIBRECHAT_DEVELOPMENT.md)。

## 公网 Agent

已上线聊天与远程浏览器同屏、排队、接管归还自动继续、本地账号、credits、日预算、管理员入口、Turnstile、邮件找回和每日空闲备份。GitHub 私有仓库 Demo 的名称和数量已由用户登录核对。邮件已由用户确认收到。

公网每用户一个会话、实际并发 5、硬上限 10；扩容暂停。初始个人额度 200,000 credits、每日全站额度 20,000,000 credits；管理页面保存的设置为运行依据。

## 完整 Agent 私有部署

已有 Compose 安装、六镜像构建/打包、配置校验、普通用户创建/密码重置、SMTP、停写备份、新实例恢复与升级维护流程。此前候选包完成同机隔离安装、真实 Chrome、排队/接管继续及恢复验收，使用模拟模型，无真实 LLM 费用。

源码清理已完成：删除 114 个旧文件、独立 MCP SDK、旧网页、成员/持久档案系统和旧发行流程；接管状态机移入 `src/scheduling/session.ts`，不保留旧安装清单兼容。新 runtime 不含这些旧入口或网页。

新版 `v0.2.0-rc.3` 六镜像候选包已完成同机隔离验收：宿主 PATH 无 Node，普通账号/初始额度、真实正文快照、接管自动继续、忙时拒绝备份、新实例恢复和同构建升级程序均通过。镜像源码为 Browser `2e0f86e` / LibreChat `0d7ee88`，包内工具提交为 `42a9d96`。这仍不是独立新服务器或实际跨版本升级验收。

本次验证：32 项 Node、28 项 Python 单元测试及 TypeScript 检查通过；5 项真实 runtime、2 项 zkPass 扩展验收、6 项真实 Browser Service 检查、9 项双账号 Compose 检查和完整候选包验收通过。顺带修复了验收依赖过时网页文案及测试目录所有权的问题；页面验收读取真实工具正文，不用模拟回答或 URL 充当页面证据。

公网已在空闲维护窗口应用新 runtime 和代理配置，耗时 3.35 秒；16 项健康检查通过，实际并发保持 5，密钥和账号数据保持不变。匿名入口继续拒绝访问，状态统一为 404。

本机报告：`output/agent/cleanup-bundle-acceptance.json`、`output/agent/compose-latest.json`、`output/librechat/browser-service-real.json`、`output/agent/cleanup-rollout.json`。候选包位于 `output/agent/releases/v0.2.0-rc.3/`，未公开发布。

尚未完成：独立干净服务器安装/恢复、实际跨版本数据库升级、公开镜像与可匿名下载发行包。CI 新 runner 验收工作流已编写，但尚未运行。Compose 定时轮转、异地备份和宿主中断 watchdog 尚未交付；公网现有 systemd 备份不作为 Compose 的替代。

## 配置审计

`private.env` 已移除重复的 `DOMAIN_SERVER`，其余 21 项仍有实际消费者。两种环境的生成配置及邮件验证凭据在清理前后字节一致；有效配置值未变、权限保持 0600，配置检查通过。`DOMAIN_SERVER` 作为 LibreChat 内部参数由 `DOMAIN_CLIENT` 自动生成，不再要求用户填写。

`BROWSER_RUNTIME_IMAGE` 在真实验收通过后更新为新构建的固定镜像 ID；这是部署版本更新，其余保留配置值不变。
