# 当前进度

更新时间：2026-10-28（北京时间）。架构见 [ARCHITECTURE.md](../ARCHITECTURE.md)，下一步见 [开发计划](DEVELOPMENT.md)，站点操作见 [DEPLOYMENT.md](../DEPLOYMENT.md)。

## 正在运行

<https://agentic-browser.zkpass.org> 已运行完整 Compose Agent `v0.2.0-rc.6`，安装目录 `.deployment/agent-site`、回环端口 3351，全部六类数据持久化到安装目录的 `data/`。每用户一个浏览器、实际并发 5、硬上限 10；扩容暂停。个人初始额度 200,000 credits，全站日预算默认 20,000,000 credits，管理页面保存的设置优先。

聊天/浏览器同屏、排队、接管归还自动继续、本地账号、管理员入口、Turnstile、SMTP 找回及每日空闲备份已交付。GitHub 私有仓库名称和数量、邮件到达均由用户核对过。

原域名迁移的 65 个 Mongo 集合、183 条记录摘要一致；应用启动后账号、聊天、余额、交易、预算和凭据再次核对通过。实际备份恢复到独立目录后，原管理员密码登录成功，真实 Qwen 完成网页读取和关闭任务；临时实例已清理。证据：`output/agent/in-place-deployment.json`。

## 本轮清理与发行

退役宿主 systemd 配置、旧 `private.env` 工具链及对应验收已删除；服务只读取明确配置的环境变量和密钥文件，测试不再依赖旧站点数据库或端口。旧历史阶段记录已从当前文档移除，完整历史可在 Git 查阅；迁移回退数据继续保存在私密目录。

清理及后续修正已完成。发行镜像由 Browser 仓库 `a17ea73`、LibreChat 仓库 `0d7ee88` 完整重建；安装器与包内文档来自 `ad65b08`。离线候选包位于 `output/agent/releases/v0.2.0-rc.6/`，包含六镜像、内外层校验清单、安装/运维工具、Nginx 示例及验收脚本；文件校验与镜像导入均通过，尚未公开发布。

迁移核心验收时发现并修复了流式响应结束后的上游连接复用 400，以及配置接口过早被当成聊天就绪信号的问题。普通 HTTP 请求清空 `Connection` 头，WebSocket 保持 Upgrade；容器健康检查改为 LibreChat `/readyz`。版本升级在备份后同步新包的 Compose 模板，日常配置应用使用已安装的管理工具。

| 验收 | 结果与证据 |
| --- | --- |
| 类型、单元与文档 | TypeScript、24 项 Node、26 项 Python、协议同步和 10 份 Markdown 的相对链接通过 |
| 最终镜像业务流程 | 12 项通过，含预算阻断、幂等加额度、跨账号隔离、排队、接管恢复、退出清理；`output/agent/compose-latest.json` |
| 运维流程 | 10 项通过，含测试 TLS 邮件、找回密码、备份恢复、模板更新和错误升级保护；`output/agent/operations-latest.json` |
| 最终离线包 | 9 项通过，PATH 只含 Python/Docker，含强杀备份后恢复及错误镜像回退；`output/agent/bundle-rc6.json` |
| 独立浏览器脚本 | 1 浏览器持续 30 秒通过，页面操作 P95 30ms、画面间隔 P95 765ms；`output/agent/browser-soak-1.json`。未调整站点容量 |
| 原域名实际升级 | rc.5 → rc.6 通过，六类核心集合、凭据及持久化目录摘要一致；`output/agent/rc6-site-upgrade.json` |

最终包各组验收均使用模拟模型，临时容器与测试数据已清理。原域名升级前备份 `20261028T141742Z-4e045fa5` 已校验；入口、注册、Turnstile、邮件功能标志及定时器正常，MCP 和内部控制路径继续返回 404。

## Mac 移交准备

按维护者最新决定，GHCR 上传留待 Mac 执行，Ubuntu 不发布、不 push、不升级站点。新增发布工具默认只做本地预检，显式 `--run` 才使用 Docker 已有凭据助手上传三个自有镜像；官方基础服务只保留 digest 引用。拒绝覆盖不同内容的同版本标签，上传后拉回核对，另有匿名拉取验证。当前只完成模拟保护测试与本地 dry-run，未执行真实上传或 Mac 实机验证。

构建/打包使用当前 Docker context；浏览器资源元数据改为 Python 读取，不再要求 Mac 安装 `dpkg-deb`。构建、GHCR、配置传递与部署文档已补充。定制 LibreChat 的 origin 仍是上游，所需定制提交未推送，因此准备包含两个 Git bundle 与锁定资源的私密源码移交包；它不包含部署密钥或用户数据，不是公开安装包。

38 项 Python 测试、本机三镜像发布 dry-run、锁定资源校验与 DEB 元数据对照通过。预检报告位于 `output/agent/mac-preparation/publish-plan.json`，明确记录 `published: false`、`credentialsRead: false`。发布命令留在文档供 Mac 操作，当前完整 Agent 的 GHCR 上传仍未执行。

## 尚未完成

独立新主机验证、数据库实际跨大版本迁移、真实异地备份、整机断电/重启演练及公开分发。CI 工作流已提供，尚未运行；本机隔离实例和目录副本不代替独立主机或异地证据。
