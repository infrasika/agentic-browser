# 当前状态与后续验收

更新：2026-10-30（北京时间）。此处只记录当前交付范围、已验证版本和未完成事项，历史实现过程由 Git 保存。

## 已交付

聊天与浏览器同屏、本地账号、每用户一个会话、排队、人工接管归还后继续、credits、全站日预算、管理员入口、Turnstile 和可选 SMTP 找回已实现。完整 Compose 支持本机目录持久化、一次填写配置、账号管理、停写备份、定时轮转、新实例恢复及失败升级保护。GitHub 私有仓库数量/名称和邮件到达已由用户核对。

源码、构建、发布、打包和运维共用 Node.js 24+。安装包包含独立工具与依赖许可证，不需源码或 npm 安装。Mac / Ubuntu 使用同一源码和双架构构建入口，站点密钥仅在部署时填写。源码与新发行包均提供 `config/settings.example.json`、`config/secrets.env.example`；源码部署使用 `init --config-directory "$PWD/config/local"` 生成实际配置和独立密钥，运行目录保存在 `.deployment/`。构建、备份、恢复和定时器均支持独立配置位置。

## 已验证的候选版本

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

当前功能和本机发行验证已完成。已有 Agent 切换模型按当前需求暂不开发，不作为本阶段交付条件；配置限制保留在 [配置说明](CONFIGURATION.md)。公开发行前主要剩余实机、外部服务和发行验证。

| 工作 | 完成条件 |
| --- | --- |
| 远程 CI | 核对 `main` / `feature` 上 GitHub Ubuntu amd64 / arm64、macOS 工作流的实际结果，不能以本地检查代替。源码测试不包含 Mac Docker 构建 |
| Mac / 原生 ARM64 | 在 Mac 实机执行源码构建；在原生 ARM64 Linux 完成安装和运行验收，QEMU 构建不能替代 |
| 独立主机 | 新 Linux 主机或干净 CI runner 完成候选包安装/恢复；`.github/workflows/accept-agent-bundle.yml` 已提供 amd64 / arm64 原生 runner 选择和平台核对，尚未远程执行 |
| 公开发行 | 维护者确认项目主许可证；按当前约定在 Mac 发布 GHCR 与安装包，验证匿名下载和拉取。组件的第三方许可保留，尚无项目主许可证 |
| 公网安装 | 当前测试站暂缓源站 TLS 变更，沿用现有入口；新用户公网部署指南仍使用 Full (strict)。正式开放前核对源站证书及公网全链路，已有覆盖该域名的 Origin CA 证书可复用 |
| 运维演练 | 配置受控异地备份并跨机恢复；在维护窗口验证整机重启；数据库升级时单独验证实际跨版本迁移 |

本机隔离验收不等于独立主机，目录副本不等于异地备份，进程强杀不等于整机断电。公开分发与运行范围应以对应版本的验收证据为准。
