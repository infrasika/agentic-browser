# 当前状态与剩余验收

更新：2026-10-31（北京时间）。当前开发分支为 feature，项目许可证为 [MIT](../LICENSE)。历史实现过程保留在 Git，本页只记录当前事实与验证边界。

## 已完成

聊天与浏览器同屏、本地账号、每用户一个会话、排队、人工接管归还后继续、credits、全站日预算、管理员入口、Turnstile 和可选 TLS SMTP 密码找回均已实现。GitHub 私有仓库数量/名称和实际邮件到达已由用户核对。

部署统一为 Docker Compose：用户填写 settings.json 和 secrets.env；容器生成身份密钥，数据保存在项目专属命名卷。宿主无需 Node/npm。ops 提供账号管理、停写备份、摘要与归档校验、新项目恢复、升级失败保护与完整回退；backup 容器负责每日备份、保留份数和同日去重。旧宿主安装器、离线安装包及重复文档/测试入口已从源码移除，业务和邮件检查迁入唯一的 Compose 验收。

MIT 已接入根目录、npm 元数据和镜像/发行文件；组件和依赖保留各自许可。Mac / Ubuntu 共用源码构建和发布入口，站点密钥不参与构建。

## 本轮验证

- 源码 ca91288 的三个 amd64 镜像从已提交代码完整构建；16 项容器运维验收通过，剩余测试资源为 0。
- 真实站点备份的隔离迁移演练通过，65 个集合及身份密钥核对完成。
- 实际站点随后切换到同一组不可变本机镜像，数据及公网配置核对通过，并产生新格式的完整已校验备份。
- 清理旧安装器后，64 项现行单元测试及类型检查通过。扩展后的业务、邮件和运维验收正在本机执行，最终结果以本页后续记录为准。

本地报告位于 output/build/build-aiayDf/amd64/report.json、output/tests/compose-final-20261031/report.json、output/deploy/compose-migration-source-20261031/report.json 和 output/deploy/site-compose-cutover-20261031/report.json。它们是本机未跟踪证据，新 clone 不需要复制。

## 当前测试站

原域名 https://agentic-browser.zkpass.org 已切换到 `.deployment/agent-site-compose/`，项目名 agentic-browser-site，入口仍为 127.0.0.1:3351。用户配置位于仓库根目录 `config/local/`，只保留 settings.json 和 secrets.env。账号、聊天、credits、预算、身份密钥和邮件收据保留；65 个集合的差异仅为初始化刷新权限记录的时间戳，其余字段和标识一致。

服务健康，维护状态已解除。新格式完整备份为 `.deployment/agent-site-compose/backups/20261030T173821Z-15ab750f`。Docker backup 服务已启用，每天 Asia/Shanghai 04:00 后空闲时执行、保留 7 份。旧 systemd 备份 timer 已停用；旧站目录及切换前完整备份保留作为本机回退材料，不再是公开部署入口。

每账号一个会话；实际容量仍为 5，硬上限 10；初始个人额度 200,000 credits，初始全站每日 20,000,000 credits，管理员保存值优先。本次未调用付费模型或发送外部邮件。外层源站 TLS 变更按此前决定暂缓，未更改现有 Nginx TLS 设置。

运行候选名为 compose-operations-final，镜像源码 ca91288。它是本机候选，不是已发布的新版本。源码整理后的发布仍需新构建及原生双架构验收。

## 发布与待办

最近一次已确认发布为 [v0.1.0-preview.10](https://github.com/infrasika/agentic-browser/releases/tag/v0.1.0-preview.10)，该版支持容器初始化但不包含新 ops。新的发布流水线只交付 Compose、配置模板、指南、许可证及验收报告，不再制作宿主 Node 安装归档。当前 GitHub 凭据仍需 GPG 解锁，本轮尚未推送或发布新版。

| 项目 | 完成条件 |
| --- | --- |
| 本轮代码发布 | 完整验收通过后提交；GitHub 授权恢复后同步，原生 amd64/arm64 验收及 GHCR 发布 |
| Mac 实机构建 | 在 Mac Docker 环境构建；macOS 源码测试不代替镜像构建 |
| 源码公开 | MIT 已完成；仓库仍私有，公开范围需单独确定 |
| 异地恢复与重启 | 确定受控异地存储，跨机恢复，并在维护窗口验证整机重启 |
| 公网正式开放 | 核对源站 HTTPS、Turnstile、真实模型和邮件全链路 |

Agent 切换模型按当前要求暂不开发。本机副本不等于异地备份，进程强杀不等于整机断电；未执行的验证不会标记为通过。
