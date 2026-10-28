# 当前进度

更新时间：2026-10-29（北京时间）。架构见 [ARCHITECTURE.md](../ARCHITECTURE.md)，下一步见 [开发计划](DEVELOPMENT.md)，站点操作见 [DEPLOYMENT.md](../DEPLOYMENT.md)。

## 正在运行

<https://agentic-browser.zkpass.org> 已运行完整 Compose Agent `v0.2.0-rc.6`，安装目录 `.deployment/agent-site`、回环端口 3351，全部六类数据持久化到安装目录的 `data/`。每用户一个浏览器、实际并发 5、硬上限 10；扩容暂停。个人初始额度 200,000 credits，全站日预算默认 20,000,000 credits，管理页面保存的设置优先。

聊天/浏览器同屏、排队、接管归还自动继续、本地账号、管理员入口、Turnstile、SMTP 找回及每日空闲备份已交付。GitHub 私有仓库名称和数量、邮件到达均由用户核对过。

## 已验收版本

发行镜像由 Browser 仓库 `a17ea73`、LibreChat 仓库 `0d7ee88` 完整重建；安装器与包内文档来自 `ad65b08`。离线候选包位于 `output/agent/releases/v0.2.0-rc.6/`，包含六镜像、内外层校验清单、安装/运维工具、Nginx 示例及验收脚本；文件校验与镜像导入均通过，尚未公开发布。

| 验收 | 结果与证据 |
| --- | --- |
| 类型、单元与文档 | TypeScript、24 项 Node、26 项 Python、协议同步和 10 份 Markdown 的相对链接通过 |
| 最终镜像业务流程 | 12 项通过，含预算阻断、幂等加额度、跨账号隔离、排队、接管恢复、退出清理；`output/agent/compose-latest.json` |
| 运维流程 | 10 项通过，含测试 TLS 邮件、找回密码、备份恢复、模板更新和错误升级保护；`output/agent/operations-latest.json` |
| 最终离线包 | 9 项通过，PATH 只含 Python/Docker，含强杀备份后恢复及错误镜像回退；`output/agent/bundle-rc6.json` |
| 独立浏览器脚本 | 1 浏览器持续 30 秒通过，页面操作 P95 30ms、画面间隔 P95 765ms；`output/agent/browser-soak-1.json`。未调整站点容量 |
| 原域名实际升级 | rc.5 → rc.6 通过，六类核心集合、凭据及持久化目录摘要一致；`output/agent/rc6-site-upgrade.json` |

最终包各组验收均使用模拟模型，临时容器与测试数据已清理。原域名升级前备份 `20261028T141742Z-4e045fa5` 已校验；入口、注册、Turnstile、邮件功能标志及定时器正常，MCP 和内部控制路径继续返回 404。

## 配置与代码清理

当前配置目录为 `/home/ubuntu/Yu/agentic-browser/.deployment/agent-site/config/`。旧 `.deployment/librechat/private.env`、生成配置、一次性迁移脚本、临时镜像修补目录及重复验收报告已删除。精简了服务器运维和进度文档，配置说明补充了 `.env` 占位符替换示例。

删除重复的 `accept-browser-service.ts`；完整 Agent 验收与 `accept-browser-soak.ts` 继续覆盖导航、画面、排队、接管和清理。保留当前单元测试、隔离测试及备份恢复测试。发行说明已修正移除 MCP SDK 后的依赖清单，以及 noVNC 现在属于 LibreChat 前端的路径。

本地清理删除 1,603 个旧文件，包含被 rc.6 替代的四版软件安装包及解压副本，释放约 9.7 GiB。历史数据库及配置备份保留，不参与运行；当前配置、数据、定时备份和 rc.6 候选包保留。已有 rc.6 镜像包保持原校验值。

清理后 TypeScript、24 项 Node、38 项 Python、协议同步和 42 个文档链接检查通过；当前 10 份配置/安装文件摘要和所有运行容器 ID 不变，站点健康，未重启或发布。

目录进一步按职责整理：构建发布工具在 `scripts/build/`，验收脚本和夹具在 `test/acceptance/`，构建记录移到 `output/build/`，以后临时验收安装只写入 `output/tests/`。删除 178 份 `.playwright-cli/` 旧测试记录、过期 Python 字节码和空目录；历史备份、迁移快照及退役部署集中到 `.deployment/archive/`，1,506 个归档文件摘要一致。按维护者只保留当前站点数据卷的要求，共移除 10 个退役容器和 12 个已确认归属的旧卷，当前站点 7 个卷保留。旧 UI 预览已停止，根目录旧 MCP `.env` 已删除。当前安装路径及密钥不变；`runtime/` 保留 Chrome 镜像的必要构建输入。

## 单仓库与双架构构建

按维护者要求，构建改为 Mac / Ubuntu 共用同一份 Git 源码，不再使用移交包或要求相邻 LibreChat 仓库。`integrations/librechat/` 保存公开上游 `6189220`、定制补丁 SHA-256、最终源码树与许可证；已经从公网重新获取上游、应用补丁，完整源码树与原定制版一致。构建和部署配置分离，不读取 `.deployment/` 或根目录 `.env`。

基础镜像和三个官方服务的固定 digest 均已确认包含 amd64 / arm64。Chrome 改用版本化的官方 URL；两种 Chrome 与扩展均已从空缓存实际下载并通过锁定摘要校验。在 Ubuntu amd64 上，基于源码 `53fb6fa` 完整构建了两种架构的 Agent、Browser Service、Chrome runtime，共六个镜像，ARM64 使用 Buildx 自带 QEMU。构建报告在 `output/build/build-6cbaz1s4/{amd64,arm64}/report.json`；两份报告的合并发布预检通过，未读取发布凭据。总验收记录：`output/build/portability-verification.json`。

构建输出每个架构独立报告，发布工具将六个自有镜像合并为三个多平台 GHCR 标签，检查来源一致、平台完整、版本冲突和拉回身份。临时本地 Registry 已实际完成双架构夹具上传、三个 index、拉回校验及幂等重试；未访问 GHCR。证据：`output/build/local-publication-verification.json`。

新 amd64 六镜像离线包校验、导入与 9 项完整验收通过，安装工具来自 `a1c5e25`，包含真实 Chrome、接管继续、普通账号、备份/恢复、强杀备份和错误升级回退。测试 PATH 只有 Python/Docker，未调用付费模型，临时实例及数据已清理。修复了 containerd 按平台 inspect 得到的子镜像 ID 尚不可独立导出的问题，打包前显式拉取子 manifest。证据：`output/build/packaging-verification.json`、`output/build/native-amd64-acceptance.json`。

TypeScript、24 项 Node、47 项 Python 测试和 45 个文档链接已通过。真实 GHCR 上传、匿名拉取、Mac 实机与原生 ARM64 全流程尚未执行。本轮只有本地 Git 提交，尚未 push；Mac clone 之前需要将当前分支同步到远端。已删除失去用途的 Mac 移交包、专用准备材料、临时源码副本、重复下载和一次性验收驱动。当前站点仍为 rc.6，容器持续健康，入口 HTTP 200，未升级或重启。

## 开源用户部署指南

`deploy/agent/INSTALL.md` 已整理为从空白 Linux 服务器开始的完整指南：依赖与发行包校验、Cloudflare DNS/代理与 Turnstile、初始化、每个必填参数和密钥的位置、首次启动、代理信任、Full (strict) 源站 TLS、可选 Cloudflare SMTP、管理员/普通用户和浏览器验收、备份及故障排查。该文件继续作为发行包的 `README.md`，没有新增另一份重复安装手册；运维手册移除重复初始化步骤。修正配置文档指向未随包分发的构建文档的失效链接。

官方公网流程统一使用 Cloudflare，关闭注册仍是同一套账号系统的开关。邮件继续共用 TLS SMTP，不增加 Cloudflare REST 发信代码；Cloudflare Email Sending 对任意收件人的发信有独立开通及 Workers Paid 要求，故保留可选。构建和发布不依赖 Cloudflare 或模型密钥。

通用 `nginx.host.conf` 改为示例域名、3333 端口、HTTP 跳转和 HTTPS 源站，保留身份头隔离、流式聊天和 WebSocket。临时 Nginx/证书/模拟上游的 8 项检查、现有 7 项部署配置测试通过；文档 Bash 语法、实际 CLI 选项及发行包内部链接核对通过，记录在 `output/build/public-install-guide-verification.json`。测试进程已清理，没有调用模型、发送邮件、发布镜像或更改现网配置。当前站点仍是原 HTTP 源站入口；Full (strict) 切换和外部 Cloudflare 全链路验收尚未执行。

## 尚未完成

独立新主机验证、数据库实际跨大版本迁移、真实异地备份、整机断电/重启演练及公开分发。CI 工作流已提供，尚未运行；本机隔离实例和目录副本不代替独立主机或异地证据。
