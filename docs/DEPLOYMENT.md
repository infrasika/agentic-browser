# 当前服务器：原域名完整 Agent 部署

2026-10-28（北京时间），按用户授权在原域名就地迁移。当前网站由完整 Docker Compose Agent 提供，宿主只负责 Nginx、Docker 和 Python 运维工具。

## 入口与配置

- 入口：<https://agentic-browser.zkpass.org>
- 安装目录：`/home/ubuntu/Yu/agentic-browser/.deployment/agent-site`
- Compose project：`agent-75a6bb6859e4`
- Gateway：`127.0.0.1:3351`；宿主 Nginx 将原域名转到此端口。
- 账号、密码、聊天、credits、预算、JWT 和加密密钥沿用原站点。无需重新注册或填写密钥。
- 公开注册与 Turnstile 保留，Cloudflare SMTP 找回密码保留；每用户一个浏览器，实际并发仍为 5，硬上限 10。
- 日预算默认 20,000,000 credits，个人初始额度 200,000；管理员页面保存的预算设置优先。

日常只编辑本安装目录下 `config/settings.json`（非密钥配置）和 `config/secrets.env`（模型、登录、邮件密钥）。`config/browser-token` 是内部浏览器认证凭据；文件均为 0600，目录为 0700。旧 `.deployment/librechat/private.env` 和独立测试实例的配置仅作停机回退资料，不再驱动当前网站。

SMTP 沿用原先验证通过的 Cloudflare 主机、发信地址和凭据；迁移验证收据只在旧指纹完全匹配时转换，没有重新发送邮件或轮换密钥。

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

修改配置后，在没有运行或排队任务时执行同一命令前缀下的 `apply`，先备份再更新。代码库已移除旧宿主运维入口。

新系统定时器以 ubuntu（UID/GID 1000）运行，每天北京时间 04:00 起空闲备份，忙时每 60 分钟重试，保留 7 份自动备份，并每分钟检查普通备份中断恢复。首份完整备份 `20261028T122321Z-8858256c` 已验证，位于 `agent-site/backups/`。已用这份实际备份恢复到独立目录核对账号、聊天、余额和预算；恢复副本只绑定自己的数据目录，代理信任列表重新置空。原管理员密码登录成功，真实 Qwen 完成读取网页并关闭浏览器，约消耗 3,663 credits；临时恢复实例及其容器、卷、网络已清理。

备份包含密钥和用户数据，仅保存在私密目录。当前没有异地备份，磁盘损坏恢复仍需外部存储。完整操作说明见 [私有部署运维](../deploy/agent/OPERATIONS.md)。

## 迁移与退役记录

停写期间导出旧 `LibreChatBrowserDemo` 数据库，导入新 `AgenticBrowser` 数据库。全部 65 个集合、183 条记录的摘要一致；应用启动后再次核对 2 个账号、4 段聊天、8 条消息、2 个余额、94 条交易和 1 条账期预算，均保持一致。持久登录、加密和模型凭据不变。无运行/接管任务时重建 Redis 缓存，旧 RDB 已保存在迁移快照，不携带旧进程地址缓存。

原始停写快照与 Nginx 配置在 `.deployment/in-place-migration/source/` 和 `nginx.before.conf`。旧宿主服务 `librechat-browser-demo`、`agentic-browser-service`、旧备份 timer，以及 `private-agent-test` 的 timer 已停用；旧数据库容器已停止且关闭自动重启，旧数据保留。3350 测试实例也已停止，不再作为日常入口。

这些旧快照只代表切换时的数据。网站产生新记录后，应从新实例最新备份恢复，不能直接切回旧库而丢弃后续写入。恢复演练不重启整机；其他项目的 PostgreSQL、Bifrost 和预览服务未改动。

当前安装使用本机构建的 `v0.2.0-rc.5` 镜像清单：Agent 来自 Browser 仓库 `49f48b1` / LibreChat `0d7ee88`，Browser Service 与 Chrome runtime 复用已验证的固定镜像，运维工具来自 `185e4a2`。清理后的 rc.6 完整候选包正在构建验收。验收报告见 `output/agent/in-place-deployment.json`。
