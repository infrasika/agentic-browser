# 当前服务器的私有部署测试实例

2026-10-28，用户确认当前项目用于测试，允许同机部署及服务故障恢复演练。实例由完整候选包安装，使用独立 Compose project、数据库和配置目录；原有域名入口继续保留作对照，不自动迁移原站点账号。

## 访问和登录

- 安装目录：`/home/ubuntu/Yu/agentic-browser/.deployment/private-agent-test`
- 回环入口：`http://127.0.0.1:3350`
- Compose project：`agent-4f93e5ff651e`
- 默认关闭注册，并发 1，每用户 1；已复用现有 Qwen 和管理员邮箱/密码。
- 新实例的 JWT、加密和内部服务密钥独立生成，配置文件为 0600，不写入仓库。
- 原站点的普通用户、Turnstile 和 Cloudflare 邮件配置没有迁入此实例。需要普通测试账号时使用本实例的 `user-create`。

从自己的电脑建立隧道，将 `SERVER_IP` 替换为真实服务器 IP（不使用 Cloudflare 代理后的地址）：

```bash
ssh -N -L 3350:127.0.0.1:3350 ubuntu@SERVER_IP
```

随后在电脑浏览器打开 `http://127.0.0.1:3350`，使用原先配置的管理员登录信息。新配置位于上述目录的 `config/settings.json` 和 `config/secrets.env`；无需再次提供密钥。

## 健康与备份

```bash
python3 /home/ubuntu/Yu/agentic-browser/.deployment/private-agent-test/agentctl.py --directory /home/ubuntu/Yu/agentic-browser/.deployment/private-agent-test doctor
python3 /home/ubuntu/Yu/agentic-browser/.deployment/private-agent-test/agentctl.py --directory /home/ubuntu/Yu/agentic-browser/.deployment/private-agent-test maintenance-status
systemctl list-timers agentic-backup-agent-4f93e5ff651e.timer
```

专属系统定时器已启用，每天北京时间 04:00 起尝试备份，忙时每 60 分钟重试，保留最近 7 份自动备份；每分钟检查普通备份中断恢复。执行用户为 UID/GID 1000（ubuntu），不是 root。systemd 的一次性服务结束后显示 `inactive` 属于正常情况，应结合 `Result=success` 和备份状态检查。

首次系统调度备份已完成并校验，存于实例 `backups/`。该目录也保留升级前备份，手工/升级备份不计入自动轮转。尚未配置异地目标；同盘备份不能覆盖整块磁盘丢失。

真实 Qwen 的只读网页任务已通过，消耗约 3,658 credits。rc.3 到 rc.4 管理工具升级后，账号、聊天、余额、预算和配置/密钥摘要一致，管理员可以重新登录。应用六镜像没有变化，因此这项结果不声称覆盖跨数据库版本迁移。

完整验收、候选包身份和剩余事项见 [进度](LIBRECHAT_PROGRESS.md)。需要停止本实例时，先停用它的定时器，再使用安装目录下的 Compose；不要停止其他项目的 Docker 容器。不要重启整个宿主来代替本服务的恢复，机器上仍有其他独立服务。
