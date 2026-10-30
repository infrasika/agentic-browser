# 当前状态与后续验收

更新：2026-10-30（北京时间）。此处只记录当前交付范围、已验证版本和未完成事项，历史实现过程由 Git 保存。

## 已发布 v0.1.0-preview.10：Docker-only 部署

[GitHub 预发布](https://github.com/infrasika/agentic-browser/releases/tag/v0.1.0-preview.10)已交付；[发布 Actions](https://github.com/infrasika/agentic-browser/actions/runs/41058616857)全部通过。用户下载同一版本的 `compose.yaml`、`settings.json`、`secrets.env`，填写配置后执行 `docker compose up -d`，宿主无需 Node.js、npm、Git 或源码。详见 [Compose 部署](COMPOSE.md)。容器内完成配置校验、随机密钥生成、网关渲染、数据卷及管理员初始化。现有安装器继续保留，两种持久化布局独立，尚不支持自动迁移或混用备份工具。

两个全新原生 Linux runner（amd64、arm64）均匿名拉取六种镜像，在源码目录外完成实际发行包 9 项验收及新 Compose 7 项验收。Compose 的部署子进程 PATH 仅包含 Docker，不含 Node/npm；覆盖未配置模板拒绝启动、管理员登录、浏览器进程降权、内部端口和密钥隔离、真实 Chrome 快照及接管继续、重复 up / down-up 保留密钥账号聊天额度、错误配置修复后恢复。两种部署在两个架构上的清理结果均通过，剩余资源为 0；双架构报告和 SHA256SUMS 随 Release 提供。

三个项目镜像 Agent、Browser Service、Chrome Runtime 均公开，每个版本索引包含 amd64 / arm64。通用 Compose 固定全部六种镜像的 digest，由 Docker 选择本机架构。源码仓库仍私有，Release 文件下载需要仓库访问权限。

应用镜像源码为 `eb5608040321b78168a65521ea7efab5eb349172`，LibreChat 为 `61892206974618971b9001d109485d994dac2816`；安装与验收工具、版本标签为 `3cffa3b5e8901265c4652e143785396a8d2a24d4`。镜像在原生双架构 [构建运行](https://github.com/infrasika/agentic-browser/actions/runs/41054406834)生成；该次 amd64 Compose 验收在启动阶段失败，未创建 Release。后续增加 HTTP 就绪等待与脱敏诊断，仅修改验收工具，核对镜像输入一致后复用相同镜像，双架构重新验收全部通过。

Linux 双架构和 macOS 源码检查通过。本机 81 项测试中 79 项通过、2 项 Linux flock 测试按平台跳过；类型检查通过。正式发布后重新下载全部 15 份文件，核对 14 份文件摘要、两个归档内部完整性、Compose 的固定镜像引用、版本标签及双架构报告，并匿名核对三个 GHCR 版本索引。独立复核记录：`output/releases/v0.1.0-preview.10/final-verification.json`（本机未跟踪产物）。

验收使用模拟模型，未调用付费模型；不代表真实模型、公网 HTTPS、真实 SMTP、Mac Docker 构建或旧 Controller 数据迁移已完成。此次发布没有升级现有测试站。preview.9 的早期失败告警对应旧运行；该版后来已成功发布，见下方历史记录。

## 已交付

聊天与浏览器同屏、本地账号、每用户一个会话、排队、人工接管归还后继续、credits、全站日预算、管理员入口、Turnstile 和可选 SMTP 找回已实现。完整 Compose 支持本机目录持久化、一次填写配置、账号管理、停写备份、定时轮转、新实例恢复及失败升级保护。GitHub 私有仓库数量/名称和邮件到达已由用户核对。

源码、构建、发布、打包和运维共用 Node.js 24+。安装包包含独立工具与依赖许可证，不需源码或 npm 安装。Mac / Ubuntu 使用同一源码和双架构构建入口，站点密钥仅在部署时填写。源码与新发行包均提供 `config/settings.example.json`、`config/secrets.env.example`；源码部署使用 `init --config-directory "$PWD/config/local"` 生成实际配置和独立密钥，运行目录保存在 `.deployment/`。构建、备份、恢复和定时器均支持独立配置位置。

## 已发布 v0.1.0-preview.9

[GitHub 预发布](https://github.com/infrasika/agentic-browser/releases/tag/v0.1.0-preview.9)已创建；[发布 Actions](https://github.com/infrasika/agentic-browser/actions/runs/41015832885)中 Linux amd64、Linux arm64 和 macOS 源码检查通过。三个 GHCR 项目镜像 Agent、Browser Service、Chrome Runtime 均公开，`v0.1.0-preview.9` 标签包含原生构建的 amd64 / arm64。源码仓库保持私有，Release 安装包下载仍需要仓库访问权限。

两个全新原生 Linux runner 均匿名拉取六个镜像，并在源码目录外解压实际交付归档。两平台各 9 项包验收通过，覆盖真实 Chrome 快照、接管继续、账号及额度、空闲备份、新实例恢复、同构建升级流程、备份中断恢复和失败升级保护；清理结果均为 `passed: true`、剩余资源为 0。报告、固定镜像清单和 SHA256SUMS 随 Release 提供。

应用镜像源码为 `7f8db885ff7401e4a3f5891531f3196887ea3388`，LibreChat 为 `61892206974618971b9001d109485d994dac2816`；安装工具与标签源码为 `bb4b6a7d1d4a4bd145159c5cae26f93c5825a3f6`。工具修复续用了相同应用镜像，流水线已比较全部镜像输入。MongoDB 固定为 8.0.34，使用 per-thread 缓存兼容当前 Ubuntu 内核；两平台都验证了实际缓存模式，见[部署说明](DEPLOYMENT.md)。

重构前 GHCR 中旧 Controller 包及 Runtime 共 44 个版本已删除；本次失败候选的 9 个版本也已清理。此次发布没有升级现有测试站。验收使用模拟模型，不代表真实模型、公网 HTTPS、真实 SMTP、Mac Docker 构建或旧 Controller 数据迁移已完成。

## 既有候选版本证据

`v0.2.0-rc.8` 已完成本机双架构构建、amd64 完整验收和当前测试站升级。以下证据仅对应指定的候选版，不表示未执行的平台和环境也已通过。

| 范围 | 结果 / 证据 |
| --- | --- |
| rc.8 镜像 | Ubuntu amd64 上生成两平台共六个应用镜像，ARM64 使用 QEMU；源码 `e11c84e`，`output/build/build-MeY0Ot/{amd64,arm64}/report.json` |
| 源码回归与 CI | 本机 Linux 73 项及 TypeScript 检查通过；Ubuntu / macOS 工作流通过 actionlint；`output/build/rc8-ci-verification.json`。集成分支已推送至 GitHub，远程运行结果尚待核对 |
| rc.8 业务 | 12 项通过：真实 Chrome、账号隔离、额度与日预算、排队、接管恢复、重启和登出清理 |
| rc.8 运维 | 10 项通过：独立配置、模拟模型、TLS SMTP、备份恢复和错误升级保护 |
| rc.8 独立包 | amd64 9 项通过，包含真实 Chrome、接管继续、定时备份、强杀恢复和错误升级保护；`output/tests/bundle-v0.2.0-rc.8-amd64/report.json` |
| rc.8 包与发布预检 | 工具来源 `bb44d66`，两架构安装包分别位于 `output/agent/releases/v0.2.0-rc.8-{amd64,arm64}/`；双架构发布预检通过，未读取发布凭据、未上传 GHCR |
| 实际数据升级演练 | 在本机隔离实例用测试站完整备份演练 rc.6 → rc.8，配置、业务数据和数据卷保持一致；`output/build/rc8-upgrade-rehearsal.json` |
| 当前站点升级 | 完整备份后就地升级 rc.6 → rc.8，数据、配置、数据卷和备份策略保持一致，公网入口及定时器正常；`output/build/rc8-site-upgrade.json` |

总记录为 `output/build/rc8-verification.json`，31 项业务、运维及独立包验收的明细索引为 `output/build/rc8-acceptance.json`。本轮使用模拟模型和邮件服务，没有调用付费模型或发送真实邮件。记录和候选包属于本机未跟踪产物，新 clone 不包含它们；按 [构建](BUILD.md)、[发布](RELEASING.md) 重新生成自己的证据。

干净源码副本已在没有 `.deployment/`、本站密钥或已有 `node_modules` 的情况下，完成 npm 安装及独立配置初始化，记录为 `output/build/config-directory-clean-checkout.json`。新 clone 的部署流程不依赖本站运行文件或归档。

发行 CI 已补齐原生 amd64 / arm64 选择及平台核对，源码 CI 覆盖 Linux 双架构和 macOS。两个工作流通过 actionlint；用实际 rc.8 双架构包完成 9 项本地流程检查，包括摘要、解压、完整性与错误架构拒绝，记录为 `output/build/native-ci-preflight.json`。这不代表 GitHub、Mac 或原生 ARM64 运行验收已经完成；既有候选包保持原样。

## 当前测试站

`https://agentic-browser.zkpass.org` 运行 rc.8 镜像，运行目录为 `.deployment/agent-site/`，真实配置位于仓库根目录 `config/local/`。数据和备份保存在运行目录的 `data/`、`backups/`。每用户一个浏览器，实际放行 5、硬上限 10；新用户 200,000 credits、默认全站日预算 20,000,000 credits，管理页面保存的预算优先。

本站使用安装包内的 Node 管理工具和备份定时器，在仓库根目录执行 `node .deployment/agent-site/agentctl.mjs --directory .deployment/agent-site` 管理。外层 Nginx 仍沿用 HTTP 源站入口，尚未应用新部署指南的 Full (strict) HTTPS 模板。当前配置、数据和有效完整备份不作为构建缓存清理。

有效的定时备份、配置搬迁前备份及 rc.8 升级前完整备份均保留，自动保留 7 份的规则不变。旧 Python 工具、迁移代码和无用归档已清理；本轮一次性演练脚本和临时构建器在验收后移除。

## 下一步

当前预发布、GitHub 三平台源码检查及原生 Linux 双架构安装验收已完成。已有 Agent 切换模型按当前需求暂不开发；配置限制保留在 [配置说明](CONFIGURATION.md)。后续仍需完成下列环境与运维验收。

| 工作 | 完成条件 |
| --- | --- |
| Mac 构建 | 在 Mac 实机执行源码构建；macOS 源码测试不代替 Mac Docker 构建 |
| 项目许可证 | 镜像已按维护者授权公开；第三方许可保留，项目主许可证仍待维护者明确 |
| 公网安装 | 当前测试站暂缓源站 TLS 变更，沿用现有入口；新用户公网部署指南仍使用 Full (strict)。正式开放前核对源站证书及公网全链路，已有覆盖该域名的 Origin CA 证书可复用 |
| 运维演练 | 配置受控异地备份并跨机恢复；在维护窗口验证整机重启；数据库升级时单独验证实际跨版本迁移 |

本机隔离验收不等于独立主机，目录副本不等于异地备份，进程强杀不等于整机断电。公开分发与运行范围应以对应版本的验收证据为准。
