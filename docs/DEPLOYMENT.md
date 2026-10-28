# 当前服务器：原域名完整 Agent 部署

当前网站运行完整 Docker Compose Agent `v0.2.0-rc.6`，宿主负责 Nginx、Docker 和 Python 运维工具。

## 入口与配置

- 入口：<https://agentic-browser.zkpass.org>
- 安装目录：`/home/ubuntu/Yu/agentic-browser/.deployment/agent-site`
- Compose project：`agent-75a6bb6859e4`
- Gateway：`127.0.0.1:3351`；宿主 Nginx 将原域名转到此端口。
- 账号、密码、聊天、credits、预算、JWT 和加密密钥沿用原站点。无需重新注册或填写密钥。
- 公开注册与 Turnstile 保留，Cloudflare SMTP 找回密码保留；每用户一个浏览器，实际并发仍为 5，硬上限 10。
- 日预算默认 20,000,000 credits，个人初始额度 200,000；管理员页面保存的预算设置优先。

**配置目录：`/home/ubuntu/Yu/agentic-browser/.deployment/agent-site/config/`。** `.deployment` 是隐藏目录，可用 `ls -la` 查看。

| 文件 | 用途 |
| --- | --- |
| `config/settings.json` | 日常编辑：模型、费率、额度、容量、域名和 SMTP 设置 |
| `config/secrets.env` | 日常编辑：模型 API key、登录和邮件密钥 |
| `config/browser-token` | 自动生成的内部浏览器认证凭据 |
| `config/nginx.conf`、`config/smtp-verified.json`、`config/backup.json` | 管理工具生成的网关配置、邮件验证收据和备份策略 |
| `.env`（安装目录下） | 自动生成的 Compose 占位符取值，不手工编辑 |

配置文件权限 0600，目录权限 0700。比如 `.env` 中 `AGENT_PORT=3351` 让 Compose 把端口占位符替换为 3351；Qwen、登录和 SMTP 密钥通过单独的 secret 文件挂载。完整字段与说明见 [CONFIGURATION.md](../deploy/agent/CONFIGURATION.md)。

`deploy/agent/` 是源码模板，当前实例位于 `.deployment/agent-site/`。旧配置备份及切换快照已归档至 `.deployment/archive/`，逐文件校验保持一致，不作为当前配置入口。构建记录在 `output/build/`，临时验收目录在 `output/tests/`。

## 本机持久化

所有业务数据位于安装目录的 `data/`：

| 目录 | 内容 |
| --- | --- |
| `mongo-data` | 账号、聊天、余额、交易、预算等 Mongo 数据 |
| `redis-data` | Redis AOF 和运行缓存 |
| `browser-data` | 浏览器调度账本、运行时状态与会话挂载目录 |
| `uploads` / `images` / `logs` | 应用文件和日志 |

这些目录通过 Docker local bind volumes 挂载。重建容器不会删除数据；删除安装目录会删除数据。Mongo/Redis 子目录由数据库容器用户持有，不要递归 chmod/chown。控制接口和数据库没有发布宿主端口，只有 gateway 发布回环端口。

外层 Nginx 文件为 `/etc/nginx/conf.d/agentic-browser.conf`，仓库版本见 `deploy/agent/nginx.host.conf`。内层只信任当前宿主 Docker 网桥 `172.28.0.1` 转发的客户端 IP；用户身份仍由登录验证。若执行 Compose down 后重建网络，要重新确认 Gateway IP 并更新 `trustedProxyIPs`。

## 健康、配置应用与备份

```bash
python3 /home/ubuntu/Yu/agentic-browser/.deployment/agent-site/agentctl.py --directory /home/ubuntu/Yu/agentic-browser/.deployment/agent-site doctor
python3 /home/ubuntu/Yu/agentic-browser/.deployment/agent-site/agentctl.py --directory /home/ubuntu/Yu/agentic-browser/.deployment/agent-site maintenance-status
systemctl list-timers agentic-backup-agent-75a6bb6859e4.timer
```

修改配置后，在没有运行或排队任务时执行同一命令前缀下的 `apply`，先备份再更新。

定时器以 ubuntu（UID/GID 1000）运行，每天北京时间 04:00 起空闲备份，忙时每 60 分钟重试，保留 7 份自动备份，并每分钟检查普通备份中断恢复。备份位于 `agent-site/backups/`。现有备份 `20261028T122321Z-8858256c` 已做恢复演练，`20261028T141742Z-4e045fa5` 是 rc.6 升级前备份，完整性校验通过。

备份包含密钥和用户数据，仅保存在私密目录。当前没有异地备份，磁盘损坏恢复仍需外部存储。完整操作说明见 [私有部署运维](../deploy/agent/OPERATIONS.md)。

## 版本与验收

当前安装为已验收的 `v0.2.0-rc.6` 六镜像清单：三个应用镜像完整构建于 Browser 仓库 `a17ea73` / LibreChat `0d7ee88`，包内安装器来自 `ad65b08`。完整候选包保存在 `output/agent/releases/v0.2.0-rc.6/`，并已用仅含 Python/Docker 的 PATH 通过安装与故障恢复验收。

日常配置用安装目录的 `agentctl.py ... apply`；版本升级从新包运行 `agentctl.py ... upgrade`。故障恢复使用当前安装的备份，不使用退役站点的数据库快照。

实际升级证据见 `output/agent/rc6-site-upgrade.json`，各项验收状态统一见 [PROGRESS.md](plans/PROGRESS.md)。
