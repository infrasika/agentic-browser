# Browser Demo 恢复流程

本流程对应 `librechat-scheduled-backup-v1` 自动备份。备份前没有活跃/排队浏览器或运行/等待人工处理的 generation，并已排空 HTTP 请求、停止应用写入。恢复目标是账号、聊天、credits、预算和应用配置；不恢复正在运行的 Chrome。

## 先进行隔离演练

```bash
cd /home/ubuntu/Yu/agentic-browser
npm run verify:librechat-recovery -- --run auto-TIMESTAMP-ID
```

命令只接受 `.deployment/librechat/backups/` 下完整、带 SHA-256 的自动备份。先校验全部文件，再安全解包源码、构建制品、配置和账本。缺文件、摘要不符、未完成备份、归档路径/链接越界都会拒绝。

演练使用两只专用 Mongo/Redis 容器，无发布端口、宿主数据挂载或外部网络路由。两个恢复应用通过独立网络命名空间访问这些数据库，端口与生产相同但网络空间不同。应用运行时的模型/邮件凭据置为不可用；Docker 命令只放行本地镜像只读检查。控制器使用新 instance ID，并要求快照没有遗留 runtime 记录。

验证内容：

- Mongo 归档载入，Redis RDB 载入、转为 AOF、重启后加载。
- 恢复的 Browser SQLite 完整、无活跃任务，运行时身份与生产分离。
- 从恢复目录加载 LC 构建模块和静态页面，两项应用服务启动成功。
- 账号、密码散列、角色、个人余额、充值记录与预算历史保持一致。
- 管理员可查询预算/用户，普通用户和匿名用户被拒绝。
- 聊天与消费账本保持一致，启动没有恢复旧任务或创建 Chrome。
- 生产服务进程保持不变，专用进程、容器和成功演练工作目录清理。

报告位于 `output/librechat/recovery-latest.json` 及按 UUID 保存的历史报告。失败日志可能含私密数据，只保存在 `.deployment/librechat/recovery-drills/UUID/`，不复制到公开报告。只有本次专用容器会被清理；发生清理失败时，按报告 UUID 和 `dev.agentic-browser.recovery-drill` 标签核对资源后处理。

当前演练复用本机已安装、lockfile 匹配的 Node 依赖以及固定镜像，并检查 Node 版本。它证明应用和数据能够从这份备份冷启动，**不证明一台裸机可以仅凭这些备份重建环境**。依赖安装、镜像供应和异地副本仍是单独的运维范围。

## 在替代环境实际恢复

以下步骤是恢复顺序，不是覆盖当前生产库的自动命令。使用独立目标主机或完全隔离的空数据库/卷；已存在业务数据时停止，先保留该目标的数据，不能直接覆盖。

1. **隔离目标入口并准备运行环境。** 准备备份中记录的 Node 版本、两个仓库的 lockfile 对应依赖、Compose 中固定的 Mongo/Redis 镜像，以及 `private.env` 记录的 Chrome runtime 镜像。保持目标入口维护状态，暂不启动 LibreChat 和 Browser Service。
2. **验证和展开。** 核对 manifest 中所有 SHA-256、文件大小和 `complete: true`。分别展开两项目源码和 LC build，恢复配置及存在的上传资源。备份目录、配置、账本均保持 0700/0600，并归运行服务的用户所有。不要将 `private.env`、数据库或聊天导出到公开目录。
3. **恢复 Mongo。** 确认目标 `LibreChatBrowserDemo` 是空库，用 `mongorestore --archive --gzip --stopOnError --nsInclude=LibreChatBrowserDemo.*` 导入归档。不要添加 `--drop` 去覆盖未知已有数据。先不启动应用、定时任务或事件消费者。
4. **恢复 Redis。** 在空目标目录中放入 `production-redis.rdb`，先以 `appendonly no` 载入 RDB；确认成功后开启 `appendonly yes`，等待 AOF rewrite 完成且状态为 `ok`。再以 AOF 模式重启并检查加载成功。避免空 AOF 抢先于已恢复的 RDB 被读取。最终配置继续使用生产的 `appendfsync everysec`。
5. **恢复 Browser 账本。** 将 SQLite 放入目标数据目录，执行完整性检查，确认没有 queued/starting/active/closing/cleanup_pending 记录。恢复必要的 runtime 目录，但为目标控制器分配新的 UUID，避免沿用源主机容器身份。若有活跃记录或 runtime JSON，停止自动恢复并调查；不要尝试重放网页提交。
6. **保留身份与计费配置。** 复用原 JWT、加密密钥和服务密钥，保留 Mongo 中的账号、余额、充值审计和全站预算；不重新赠送 credits。根据目标安装路径重新生成 unit 和配置文件中的绝对路径，不盲目安装旧路径的 unit。
7. **依次启动并验证。** 先 Browser Service，再 LibreChat。检查三个回环入口、管理员/普通用户权限、余额和预算、聊天与消费账本及恢复后的静态资源。确认没有意外运行任务，完成 `health:librechat` 后再解除目标入口维护状态。
8. **恢复日常运维。** 验证备份定时器的路径与权限，启用日常备份，并记录恢复使用的备份时间。切换前保持源环境和目标环境的职责明确，避免同时消费同一队列或操作同一浏览器资源。

本机备份不能覆盖源服务器整机丢失；异地、加密且可恢复的备份副本仍需另行接入。
