# 文档导航

Agentic Browser 是包含聊天、远程浏览器、本地账号和额度管理的完整 Agent。浏览器能力通过 LibreChat 原生工具调用私有服务；部署者安装一套 Compose 即可。

## 按任务阅读

| 目标 | 文档 |
| --- | --- |
| 了解产品、GitHub 私有仓库示例与接管操作 | [Demo 使用](AGENT_DEMO.md) |
| 理解组件、数据、身份与隔离边界 | [架构](ARCHITECTURE.md) |
| 修改源码、LibreChat 补丁和运行测试 | [开发](DEVELOPMENT.md) |
| 在 Mac / Ubuntu 构建 amd64、arm64 镜像 | [构建](BUILD.md) |
| 发布 GHCR、制作和验收安装包 | [发布](RELEASING.md) |
| 从空白 Linux 服务器开始安装、自用关闭注册 | [部署](DEPLOYMENT.md) |
| 填写参数和密钥、理解 Compose `.env` | [配置](CONFIGURATION.md) |
| 管理用户、邮件、备份、恢复和升级 | [运维](OPERATIONS.md) |
| 查看已验收范围与待完成事项 | [当前状态](STATUS.md) |
| 查看随镜像和安装包分发的第三方声明 | [分发声明](DISTRIBUTION-NOTICES.md) |

构建、发布和部署是三个阶段：构建只读取源码和公共依赖；发布使用 Docker registry 授权；部署后才在安装目录填写模型、站点与邮件密钥。同一组镜像可以用于不同域名和账号配置。

## 目录约定

| 路径 | 内容 | 是否进入 Git |
| --- | --- | --- |
| `src/` | Browser Service、队列、画面、隔离运行时 | 是 |
| `integrations/librechat/` | 固定上游提交、定制补丁和上游许可证 | 是 |
| `runtime/` | Chrome Dockerfile、扩展安装器、资源锁、沙箱及许可证 | 是 |
| `deploy/agent/` | Compose / Nginx 模板、应用启动配置、Node 运维工具 | 是 |
| `scripts/build/` | 源码准备、下载、镜像构建、发布和打包 | 是 |
| `scripts/sync-browser-contract.mjs` | 同步两端浏览器 API 协议 | 是 |
| `test/` | 单元测试；`tooling/` 验证工具，`acceptance/` 执行完整验收 | 是 |
| `docs/` | 所有维护中的指南与状态说明 | 是 |
| `output/` | 下载缓存、构建日志、候选包及验收记录 | 否 |
| `.deployment/` | 本机安装、私密配置、站点数据和恢复归档 | 否 |

根目录 `README.md` 是仓库入口。许可原文保留在对应组件目录。安装包的 `README.md`、`CONFIGURATION.md` 和 `OPERATIONS.md` 由这里的部署、配置和运维文档生成，不另外维护副本。

`.deployment/` 不影响其他机器构建。已安装实例的 `data/` 和 `backups/` 需要保留；`output/` 中经过验收的发行包也可能用于恢复，清理时应按具体产物判断。浏览器调试工具生成的 `.playwright-cli/` 不是运行依赖。
