# 完整 Agent 私有部署

部署单位是 LibreChat Agent、Browser Service、隔离 Chrome runtime、入口代理、MongoDB 和 Redis。最终用户只需要 Python 与 Docker；开发使用两个独立源码仓库。公共架构见 [ARCHITECTURE.md](../ARCHITECTURE.md)。

## 产品边界

- 默认关闭注册、本地账号、并发 1、每账号一个会话；不要求 OAuth 或 Cloudflare。
- 部署者一次填写 Qwen API key、模型、地址和费率；生成管理员密码、JWT/加密与服务密钥。
- 配置分为 `settings.json`、`secrets.env` 和 `browser-token`，目录 0700、文件 0600；生成的 `.env` 不手改。
- 开放注册需要 HTTPS 和 Turnstile；可选 TLS/STARTTLS SMTP 提供密码找回，无邮件时使用服务器 CLI 重置。
- 只有 gateway 发布 loopback HTTP；远程通过 SSH 隧道或已有 HTTPS 代理访问。内部数据库和控制 API 不发布端口。
- 运行时使用一次性登录上下文；每次会话清理后删除，不保存长期浏览器档案。
- 固定六镜像清单；不接受缺数据库镜像的预览格式，不支持旧产品迁移。

## 运维与分发

安装器负责配置校验、健康检查、账号管理、空闲停写备份、新实例恢复和升级维护；失败时保持维护状态，避免把不一致数据开放给用户。备份含账号、聊天及密钥，必须私密存放。

`schedule` 生成实例专属的系统级定时器，由管理员启用，执行进程仍使用安装目录所属用户，每日空闲备份、忙时重试和轮转。`maintain` 共用实例锁，只自动恢复中断的普通备份，失败升级与未完成 restore 需要人工处理。可向受控目录复制并校验归档；远程存储、加密、挂载由部署者配置。

候选包包括安装工具、运维手册、完整性清单、源码/镜像身份、许可和独立验收脚本。离线包携带六个固定 image ID；registry 包必须使用不可变 registry digest。应用、运行时或配置工厂变化后必须重建对应镜像。

当前支持范围为 Linux amd64。用户已授权把当前服务器用于测试，先完成同机实装和故障恢复。独立主机验证、实际跨版本数据库升级、公开发布及真实异地存储验收仍待完成；状态见 [进度](LIBRECHAT_PROGRESS.md)。

操作说明：[安装](../../deploy/agent/INSTALL.md) · [运维](../../deploy/agent/OPERATIONS.md) · [构建](../../deploy/agent/README.md) · [发行](../../deploy/agent/RELEASING.md)。
