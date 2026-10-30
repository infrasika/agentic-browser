# 运维：账号、配置、备份与升级

所有命令在 compose.yaml 所在目录执行。服务器只需 Docker / Compose；ops 是按需运行的管理容器，没有公网接口。管理员通过聊天应用的管理入口调整额度和预算。

## 健康与备份

```bash
docker compose run --rm ops status
docker compose run --rm ops backup
```

`status` 显示服务健康、维护状态与最近一次自动备份。备份要求没有活跃 Agent 或浏览器任务；繁忙时退出，稍后重试。它会启用维护页面、排空请求并依次停写应用与数据库，保存完整数据后恢复服务。结果中的 `backup` 是相对部署目录的路径，例如 `backups/20261030T120000Z-1234abcd`。

备份同时包含两份输入配置、当时的 Compose 文件和九个数据卷，包含应用加密密钥。文件有 SHA256 校验，未完成的 `.pending-*` 目录不作为可恢复备份。归档含密钥和用户数据，目录保持私有；异地副本应复制整个已完成的备份目录。`.env` 的项目名、监听地址和端口由目标服务器自行设置，不随备份覆盖。

```bash
docker compose run --rm ops verify-backup backups/实际备份目录
```

## 开启每日自动备份

在部署目录 `.env` 添加或修改：

```dotenv
AGENT_BACKUP_TIMEZONE=Asia/Shanghai
AGENT_BACKUP_HOUR=4
AGENT_BACKUP_KEEP=7
```

```bash
docker compose --profile backups up -d backup
docker compose logs --tail 20 backup
```

备份容器每分钟检查一次，在指定时区当天到达计划小时后、站点空闲时执行；错过计划时间会补做，成功后当天不重复。保留最近 7 份完整备份，手动和升级前备份也计入轮转；可将 `AGENT_BACKUP_KEEP` 设为 1–365。它与人工运维共用操作锁，正在维护时自动延后。修改计划后重新执行上述 `up` 命令。

## 从备份恢复到新项目

推荐在一个新目录和新 Compose 项目中先恢复验收。准备包含 `ops` 的同版本发行文件，将完整备份目录复制到新目录的 `backups/` 下。新目录的 `.env` 明确设置不同项目名和未占用端口，例如：

```dotenv
COMPOSE_PROJECT_NAME=agent-restored
AGENT_PORT=3334
AGENT_BIND=127.0.0.1
```

```bash
docker compose run --rm ops restore backups/实际备份目录
```

工具先验证全部摘要与归档路径，再恢复密钥及数据，完成后保持停机维护。检查恢复出来的 `settings.json` 和 `secrets.env`；更换域名或端口时同步修改 `origin`，然后启动：

```bash
docker compose run --rm ops recover
docker compose run --rm ops status
```

确认账号、聊天、额度和浏览器功能正常后再切换反向代理。默认拒绝覆盖已有项目；只有明确要用备份替换该项目全部数据时，才在 `restore` 命令后加 `--replace`。损坏的备份会在修改现有服务前被拒绝。

## 升级和失败回退

核对新版本说明及 SHA256SUMS，把新 `compose.yaml` 保存到当前部署目录的 `releases/版本/compose.yaml`，先不要覆盖正在使用的文件或个人配置。

```bash
docker compose run --rm ops upgrade releases/版本/compose.yaml
docker compose run --rm ops status
```

升级先准备新镜像，确认空闲后完整备份，再替换版本并验证服务。失败时保留维护状态，不自动让旧代码访问可能已经迁移过的数据库。执行回退会恢复升级前的完整数据及旧版本：

```bash
docker compose run --rm ops rollback
```

如果新镜像连 `ops` 也无法启动，用升级前备份中的 Compose 文件启动旧版管理工具：

```bash
docker compose --project-directory "$PWD" \
  -f backups/升级前备份目录/compose.yaml run --rm ops rollback
```

正常备份期间进程或主机中断，可用 `ops recover` 清理遗留归档辅助容器并恢复服务。它会拒绝直接恢复未完成的升级或数据覆盖；这些情况需执行 `rollback`，或重新从已验证的备份恢复。不要手工删除维护标记来绕过检查。

## 创建账号和重置密码

修改 `DEMO_ADMIN_PASSWORD` 不会重置已有账号。先创建权限为 0600 的临时 JSON 文件，用编辑器填写邮箱与新密码，避免把密码放进命令行参数或聊天：

```json
{"email":"admin@example.com","password":"填写至少12字符的新密码"}
```

```bash
docker compose run --rm -T ops user-reset < account.json
rm account.json
```

这可以重置管理员或普通本地账号，撤销已有登录会话，不发送邮件。新建普通账号使用 `user-create`，JSON 还需提供 `name` 和唯一的 `username`；新账号按配置获得初始 credits。

已填写 SMTP 配置时，可显式发送一封测试邮件：

```bash
docker compose run --rm ops mail-test --to 自己的测试邮箱
```

收据写入配置卷并随备份保留。该命令会实际发信；备份、恢复及升级本身不会调用模型或发送邮件。

## 修改配置与日常停止

等待任务结束，先备份当前配置和数据，再停止服务、编辑 settings.json / secrets.env 并重建：

```bash
docker compose run --rm ops backup
docker compose --profile '*' stop
# 在编辑器中修改两份配置，然后：
docker compose up -d --force-recreate
docker compose run --rm ops status
# 原先启用了每日备份的站点，再执行：
docker compose --profile backups up -d backup
```

`restart` 不会重新生成配置。保持项目名和网络不变；`stop` 保留容器、网络和数据卷。要移除容器可用 `docker compose --profile '*' down`，但不加 `-v` / `--volumes`，并在重新启动后核对 `trustedProxyIPs` 的网桥地址。既有账号密码用 user-reset 修改，不通过修改初始密码实现。

备份不包含镜像本身、宿主 Nginx/证书、手工增加的额外挂载或 override 文件。自行保管这些部署依赖；恢复到同版本和支持的 CPU 架构，数据库跨大版本升级需单独验证。命名卷备份不是跨数据库版本的转换工具。

## 启用 Cloudflare 邮件找回

项目共用一套 TLS SMTP 实现。先在 Cloudflare Email Service → Email Sending 开通并验证发信域名，例如 mail.example.com；创建覆盖该账号的 Email Sending: Edit token。Email Routing 的收信转发不等于发信权限，开通条件以供应商控制台为准。

在现有 settings.json 顶层添加以下字段，不要覆盖整个文件：

```json
"smtp": {
  "host": "smtp.mx.cloudflare.net",
  "port": 465,
  "encryption": "tls",
  "from": "noreply@mail.example.com",
  "username": "api_token"
}
```

SMTP_PASSWORD 填对应 token。发信地址必须属于已验证域名，api_token 是固定用户名。[Cloudflare SMTP 参数与权限](https://developers.cloudflare.com/email-service/api/send-emails/smtp/)

按上节加载配置后，显式向自己的测试邮箱发一封邮件：

```bash
docker compose run --rm ops mail-test --to your-address@example.com
docker compose restart agent
docker compose up -d --wait agent
```

返回 accepted 后确认实际收件；SMTP 接受不等于已到收件箱。测试成功的收据写入配置卷，Agent 重启后启用 Forgot Password。修改 origin、发信设置或凭据后旧收据失效，需重新测试。其他供应商使用同一 smtp 配置，支持隐式 TLS 或强制 STARTTLS，保留证书验证。没有邮件时可继续使用 user-reset。

## 排查

```bash
docker compose ps -a
docker compose logs --tail 50 init agent browser gateway
docker compose run --rm ops status
```

初始化失败先修正字段，不删除数据卷。维护状态按操作结果使用 recover、rollback 或 restore；不要直接删除状态标记。共享日志前去除邮箱、用户内容和会话信息。管理员账户和普通账户共用登录页；普通用户不能使用管理入口。
