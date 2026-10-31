# 当前状态与剩余验收

更新：2026-10-31（北京时间）。开发分支为 feature，项目许可证为 [MIT](../LICENSE)。历史实现过程保留在 Git，本页记录当前结果与验证边界。

## 已完成

聊天与浏览器同屏、本地账号、每用户一个会话、排队、人工接管归还后继续、credits、全站日预算、管理员入口、Turnstile 和可选 TLS SMTP 密码找回均已实现。GitHub 私有仓库数量/名称及实际邮件到达已由用户核对。

部署统一为 Docker Compose：用户填写 settings.json 和 secrets.env；容器生成身份密钥，数据使用项目专属命名卷，宿主无需 Node/npm。ops 提供账号管理、停写备份、校验、新项目恢复、升级保护与完整回退；backup 容器提供每日备份、保留份数和同日去重。

旧宿主安装器、离线安装包和重复文档/测试入口已从源码移除。业务与邮件检查迁入唯一的 Compose 验收。构建、发布、部署、配置及运维指南已统一；新 clone 不依赖本站配置或 .deployment。MIT 已接入根目录、npm 元数据和镜像/发行文件，组件与依赖保留各自许可。

## 本轮验收

| 范围 | 已验证结果 |
| --- | --- |
| 源码 | 64 项单元测试及 TypeScript 检查通过；发行收集拒绝不匹配的版本、源码、架构和失败验收记录 |
| 构建 | 提交 6bd8667 的 Agent、Browser Service、Chrome Runtime 三个 amd64 镜像构建通过；旧初始化器已从镜像移除，非默认 UID 读取和 MIT 文件检查通过 |
| 完整 Compose | 最终镜像 30 项验收通过，测试容器、网络和数据卷剩余 0；模拟模型和本地 TLS 邮件服务，无付费模型或外部发信 |
| 业务 | 真实 Chrome、接管继续、双账号隔离、排队、credits 幂等、日预算拦截、登出清理、登录限流、邮件单次重置和旧登录失效 |
| 运维 | 配置与密钥持久化、账号命令、活跃任务拒绝备份、停写备份、独立项目恢复、损坏备份拒绝、故障升级完整回退、强杀恢复、每日轮转与去重、升级保留备份服务 |
| 实际站点 | 完成旧布局迁移和最终镜像升级；65 个集合、身份密钥及用户配置核对通过，公网入口与备份服务正常 |

本机证据：

- 构建：`output/build/build-H6Obog/amd64/report.json`。
- 最终验收：`output/tests/compose-unified-final-20261031/report.json`。
- 布局迁移：`output/deploy/site-compose-cutover-20261031/report.json`。
- 最终站点升级：`output/deploy/site-compose-unified-20261031/report.json`。

这些是本机未跟踪报告，新 clone 不需要复制。合并流程前后的隔离验收均已清理，临时 Buildx 构建器与一次性迁移脚本已移除。实际数据核对仅忽略权限初始化会刷新的 grantedAt / updatedAt 字段，其余字段和标识一致。

## 当前测试站

原域名 https://agentic-browser.zkpass.org 当前运行本机候选 **compose-unified**，镜像源码 **6bd8667**。运行目录为 `.deployment/agent-site-compose/`，项目名 agentic-browser-site，入口 127.0.0.1:3351。配置位于根目录 `config/local/`，只需 settings.json 和 secrets.env；业务数据及生成的密钥保存在命名卷。

服务健康、非维护状态，首页与 api/config 公网返回 200，mcp 返回 404。每天 Asia/Shanghai 04:00 后空闲时执行备份，保留 7 份；Docker backup 服务运行，旧 systemd timer 已停用。升级前备份为 `backups/20261030T182440Z-c823797a`，升级后新版本完整备份为 `backups/20261030T182629Z-f1087758`，均位于当前运行目录，已校验。

每账号一个会话；实际容量仍为 5，硬上限 10。初始个人额度 200,000 credits，全站日预算初始值 20,000,000 credits，管理员保存值优先。本轮未调用付费模型或发送真实邮件，现有源站 TLS 设置按此前决定保留。旧站目录和切换前有效备份仅作为本机回退材料，不是公开部署入口。

## 发布与剩余工作

最近一次已确认发布为 [v0.1.0-preview.10](https://github.com/infrasika/agentic-browser/releases/tag/v0.1.0-preview.10)，支持容器初始化，但不包含新 ops。本轮代码已推送到 feature，正在准备 **v0.1.0-preview.11** 的 PR、原生双架构构建与验收；新版尚未发布。新的流水线只交付 Compose、配置模板、指南、许可证及验收报告，原生双架构通过后才发布。

| 工作 | 完成条件 |
| --- | --- |
| GitHub 同步与发布 | 本地提交已同步；通过 PR 检查后完成原生 amd64/arm64 验收及新版 GHCR/Release 发布 |
| Mac 实机构建 | 在 Mac Docker 环境构建；macOS 源码测试不代替镜像构建 |
| 源码公开 | MIT 已完成；仓库仍私有，公开范围单独确定 |
| 异地恢复与重启 | 确定受控异地存储并跨机恢复，在维护窗口验证整机重启 |
| 公网正式开放 | 核对源站 HTTPS、Turnstile、真实模型和邮件全链路 |

Agent 切换模型按当前要求暂不开发。本机副本不等于异地备份，进程强杀不等于整机断电；未执行的验证不标记为通过。
