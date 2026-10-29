# 当前状态与后续验收

更新：2026-10-29。此处只记录当前交付范围、已验证版本和未完成事项，历史实现过程由 Git 保存。

## 已交付

聊天与浏览器同屏、本地账号、每用户一个会话、排队、人工接管归还后继续、credits、全站日预算、管理员入口、Turnstile 和可选 SMTP 找回已实现。完整 Compose 支持本机目录持久化、一次填写配置、账号管理、停写备份、定时轮转、新实例恢复及失败升级保护。GitHub 私有仓库数量/名称和邮件到达已由用户核对。

源码、构建、发布、打包和运维共用 Node.js 24+。安装包包含独立工具与依赖许可证，不需源码或 npm 安装。Mac / Ubuntu 使用同一源码和双架构构建入口，站点密钥仅在部署时填写。源码与新发行包均提供 `config/settings.example.json`、`config/secrets.env.example`；实际配置和独立密钥由 `init` 生成。

## 已验证的候选版本

以下是已完成的版本证据，不表示每次修改源码后已重新构建或验收。

| 范围 | 结果 / 证据 |
| --- | --- |
| rc.7 镜像 | Ubuntu amd64 上生成两平台共六个镜像，ARM64 使用 QEMU；源码 `2e74e62`，`output/build/build-KkQwb1/{amd64,arm64}/report.json` |
| rc.7 工具与业务单元测试 | 69 项及 TypeScript 检查通过 |
| rc.7 运维 | 10 项通过，模拟模型、TLS SMTP、备份恢复及错误升级保护；`output/build/node-operations-verification.json` |
| rc.7 独立包 | 9 项通过，包含真实 Chrome、接管继续、备份、强杀恢复和错误升级保护；仅 Node/Docker/flock；`output/build/node-bundle-verification.json` |
| rc.7 包与发布预检 | 工具来源 `db5ad7f`，候选包 `output/agent/releases/v0.2.0-rc.7-amd64/`；双架构发布预检通过，未上传 GHCR |

总记录为 `output/build/node-toolchain-verification.json`。记录和候选包属于本机未跟踪产物，新 clone 不包含它们；按 [构建](BUILD.md)、[发布](RELEASING.md) 重新生成自己的证据。

当前源码已通过 69 项回归和 TypeScript 检查。12 份文档的 57 个源码相对链接、6 个包内链接和 35 个 Bash 代码块检查通过；公开示例与初始化字段一致、密钥独立生成、私密文件忽略和安装包示例校验均通过，记录为 `output/build/config-examples-verification.json`。此前 Docker amd64 / arm64 最小构建验证了分发声明的新路径和原始内容，记录为 `output/build/docs-cleanup-verification.json`。这些检查不等于重新构建完整应用或生成新发行包。

## 当前测试站

`https://agentic-browser.zkpass.org` 运行 rc.6，安装位于 `.deployment/agent-site/`，配置为该目录的 `config/`，数据为 `data/`，备份为 `backups/`。每用户一个浏览器，实际放行 5、硬上限 10；新用户 200,000 credits、默认全站日预算 20,000,000 credits，管理页面保存的预算优先。

源码整理不会升级正在运行的实例。rc.6 保留已安装的旧管理工具和备份定时器；对它操作应使用相应版本的安装包说明，不能直接替换入口文件。其外层 Nginx 仍沿用 HTTP 源站入口，尚未应用新部署指南的 Full (strict) HTTPS 模板。升级前需备份，升级后重建定时器并验证恢复。恢复包、配置和数据不作为构建缓存清理。

## 下一步

| 工作 | 完成条件 |
| --- | --- |
| 当前源码重新发行 | 分发声明的 Docker COPY 路径及少量源码清理已变化；新版本重新构建、打包并验收，不改写已验收 rc.7 包 |
| Mac / 原生 ARM64 | 在 Mac 实机执行源码构建；在原生 ARM64 Linux 完成安装和运行验收，QEMU 构建不能替代 |
| 独立主机 | 新 Linux amd64 主机或干净 CI runner 完成候选包安装/恢复；已提供 `.github/workflows/accept-agent-bundle.yml`，尚未执行 |
| 公开发行 | 维护者确认项目主许可证和发布渠道，发布 GHCR 与安装包，验证匿名下载和拉取；仓库目前保留第三方许可，尚无项目主许可证 |
| 公网安装 | 按指南完成源站证书、Cloudflare Full (strict)、Turnstile、真实模型和邮件全链路验收 |
| 运维演练 | 配置受控异地备份并跨机恢复；在维护窗口验证整机重启；数据库升级时单独验证实际跨版本迁移 |

本机隔离验收不等于独立主机，目录副本不等于异地备份，进程强杀不等于整机断电。公开分发与运行范围应以对应版本的验收证据为准。
