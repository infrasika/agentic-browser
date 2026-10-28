# 当前进度

更新时间：2026-10-28（北京时间）。架构见 [ARCHITECTURE.md](../ARCHITECTURE.md)，下一步见 [开发计划](DEVELOPMENT.md)，站点操作见 [DEPLOYMENT.md](../DEPLOYMENT.md)。

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

本地清理删除 1,603 个旧文件，包含被 rc.6 替代的四版软件安装包及解压副本，释放约 9.7 GiB。历史数据库及配置备份保留，不参与运行；当前配置、数据、定时备份和 rc.6 候选包保留。Mac 源码移交包同步本轮清理，精确提交记录在包内 `HANDOFF.json`；已有 rc.6 镜像包保持原校验值。

清理后 TypeScript、24 项 Node、38 项 Python、协议同步和 42 个文档链接检查通过；当前 10 份配置/安装文件摘要和所有运行容器 ID 不变，站点健康，未重启或发布。

目录进一步按职责整理：构建发布工具在 `scripts/build/`，验收脚本和夹具在 `test/acceptance/`，构建记录移到 `output/build/`，以后临时验收安装只写入 `output/tests/`。删除 178 份 `.playwright-cli/` 旧测试记录、过期 Python 字节码和空目录；历史备份、迁移快照及退役部署集中到 `.deployment/archive/`，1,506 个归档文件摘要一致。按维护者只保留当前站点数据卷的要求，共移除 10 个退役容器和 12 个已确认归属的旧卷，当前站点 7 个卷保留。旧 UI 预览已停止，根目录旧 MCP `.env` 已删除。当前安装路径及密钥不变；`runtime/` 保留 Chrome 镜像的必要构建输入。

## Mac 移交准备

按维护者最新决定，GHCR 上传留待 Mac 执行，Ubuntu 不发布、不 push、不升级站点。新增发布工具默认只做本地预检，显式 `--run` 才使用 Docker 已有凭据助手上传三个自有镜像；官方基础服务只保留 digest 引用。拒绝覆盖不同内容的同版本标签，上传后拉回核对，另有匿名拉取验证。当前只完成模拟保护测试与本地 dry-run，未执行真实上传或 Mac 实机验证。

构建/打包使用当前 Docker context；浏览器资源元数据改为 Python 读取，不再要求 Mac 安装 `dpkg-deb`。构建、GHCR、配置传递与部署文档已补充。定制 LibreChat 的 origin 仍是上游，所需定制提交未推送，因此准备包含Browser Git bundle、保留 shallow 边界的 LibreChat 裸仓库与锁定资源的私密源码移交包；它不包含部署密钥或用户数据，不是公开安装包。

38 项 Python 测试、锁定资源校验与 DEB 元数据对照通过。清理后的源码需要在 Mac 重新构建，移交包已移除旧服务器构建报告，且实际验证了发布工具拒绝混用旧镜像。`output/agent/mac-preparation/publish-plan.json` 记录 `rebuild_required`、`published: false`、`credentialsRead: false`。发布命令留在文档供 Mac 操作，当前完整 Agent 的 GHCR 上传仍未执行。

从移交包重新克隆两个仓库，不复制根目录 `.env` 或 `.deployment/`，使用实际构建函数成功准备三个镜像上下文并校验锁定资源。证据：`output/agent/mac-preparation/config-independent-build.json`。这验证构建输入独立于运行配置，未执行新的镜像编译或 Mac 实机构建。

## 尚未完成

独立新主机验证、数据库实际跨大版本迁移、真实异地备份、整机断电/重启演练及公开分发。CI 工作流已提供，尚未运行；本机隔离实例和目录副本不代替独立主机或异地证据。
