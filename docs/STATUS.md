# 当前状态与剩余验收

更新：2026-10-31（北京时间）。项目采用 [MIT](../LICENSE)，日常开发使用 feature 分支，检查通过后通过 PR 合并到 main。历史实现过程保留在 Git，本页记录当前结果与验证边界。

## 已交付

聊天与浏览器同屏、本地账号、每用户一个会话、排队、人工接管归还后继续、credits、全站日预算、管理员入口、Turnstile 和可选 TLS SMTP 密码找回均已实现。GitHub 私有仓库数量/名称及实际邮件到达已由用户核对。

部署统一为 Docker Compose：用户填写 settings.json 和 secrets.env；容器生成身份密钥，数据使用项目专属命名卷，宿主无需 Node/npm。ops 提供账号管理、停写备份、校验、新项目恢复、升级保护与完整回退；backup 容器提供每日备份、保留份数和同日去重。

旧宿主安装器、离线安装包和重复文档/测试入口已从源码移除。新 clone 不依赖本站配置或 .deployment。MIT 已接入源码、npm 元数据和镜像/发行文件，第三方组件保留各自许可。

## 已发布与验收

[v0.1.0-preview.11](https://github.com/infrasika/agentic-browser/releases/tag/v0.1.0-preview.11) 已发布到 GitHub Release 和 GHCR，包含容器化运维工具。三种项目镜像均支持 Linux amd64 / arm64，不更新 latest。源码仓库目前仍私有，Release 下载需要仓库权限；镜像可匿名拉取。

[发布流水线](https://github.com/infrasika/agentic-browser/actions/runs/41151558451) 已全部通过：

| 范围 | 已验证结果 |
| --- | --- |
| 源码 | Linux amd64、Linux arm64、macOS 的 66 项单元/工具测试及 TypeScript 检查通过 |
| 原生构建 | 两种 Linux 架构的 Agent、Browser Service、Chrome Runtime 均构建成功；镜像源码 e0d0790，发行工具与指南源码 4ca69c8，镜像输入一致性已校验 |
| 镜像身份 | 六种镜像匿名拉取通过；项目镜像按索引、平台清单和配置摘要核对构建记录及本地镜像，拒绝错镜像、错架构和歧义清单 |
| 完整部署 | 两台全新原生 Linux runner 各 30 项 Docker-only 验收通过；测试容器、网络和数据卷剩余均为 0 |
| 业务 | 真实 Chrome、接管继续、双账号隔离、排队、credits 幂等、日预算拦截、登出清理、登录限流、邮件单次重置和旧登录失效 |
| 运维 | 配置与密钥持久化、账号命令、活跃任务拒绝备份、停写备份、独立项目恢复、损坏备份拒绝、故障升级完整回退、强杀恢复、每日轮转与去重、升级保留备份服务 |
| 交付 | 15 个发行附件已下载并核对 SHA256；包括 Compose、配置模板、指南、许可证及两平台验收证据 |
| 实际站点 | 已从本机候选升级为发布的 GHCR 镜像；65 个集合、身份密钥及用户配置核对通过，公网入口和备份服务正常 |

验收使用模拟模型和本地 TLS 邮件服务，没有付费模型调用或外部发信。macOS 源码测试不等于 Mac Docker 镜像构建验收。

本机证据：

- 发行附件：`output/releases/v0.1.0-preview.11/`，其中包含两平台的完整验收报告。
- 发行校验：`output/releases/preview11-progress/delivery-verification.json`。
- 实际站点升级：`output/deploy/site-preview11-20261031/report.json`。

这些是本机未跟踪报告，新 clone 不需要复制。实际数据核对只忽略权限初始化会刷新的 accessroles.updatedAt、aclentries.grantedAt / updatedAt、systemgrants.grantedAt / updatedAt，其余字段和标识一致。

## 当前测试站

https://agentic-browser.zkpass.org 运行 **v0.1.0-preview.11**，六种服务镜像均使用不可变摘要。运行目录为 `.deployment/agent-site-compose/`，项目名 agentic-browser-site，入口 127.0.0.1:3351。配置位于根目录 `config/local/`，只需 settings.json 和 secrets.env；业务数据及生成的密钥保存在命名卷。

服务健康、非维护状态，首页与 api/config 公网返回 200，mcp 返回 404。每天 Asia/Shanghai 04:00 后空闲时执行备份，保留 7 份；10 月 31 日的自动备份已实际完成并校验，旧 systemd timer 已停用。本次升级前备份为 `backups/20261031T005812Z-370ac37a`，升级后完整备份为 `backups/20261031T005854Z-5fedea33`，均位于当前运行目录，已校验。

每账号一个会话；实际容量仍为 5，硬上限 10。初始个人额度 200,000 credits，全站日预算初始值 20,000,000 credits，管理员保存值优先。现有源站 TLS 设置按此前决定保留。旧站目录和切换前有效备份仅作为本机回退材料，不是公开部署入口。

## 后续待完成

| 工作 | 完成条件 |
| --- | --- |
| Mac 实机构建 | 在 Mac Docker 环境完成镜像构建；源码测试已经通过 |
| 源码公开 | MIT 已完成；单独确定仓库公开范围和可见性 |
| 异地恢复与重启 | 确定受控异地存储并跨机恢复，在维护窗口验证整机重启 |
| 公网正式开放 | 核对源站 HTTPS、Turnstile、真实模型和邮件全链路 |

Agent 切换模型按当前要求暂不开发。本机副本不等于异地备份，进程强杀不等于整机断电；未执行的验证不标记为通过。
