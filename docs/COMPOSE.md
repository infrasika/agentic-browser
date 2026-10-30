# Docker Compose 部署

此部署入口需要包含 Compose 初始化器的 Agent / Browser Service 镜像。已发布的 `v0.1.0-preview.9` 不包含这些入口，不能直接套用新模板。请使用同一版本提供的 `compose.yaml`、`settings.json`、`secrets.env` 和本指南；发布工具会将已验证镜像的固定 digest 写入 Compose 文件。

## 准备

服务器安装 Docker Engine 26+ 和 Docker Compose v2（支持 `service_completed_successfully`）。使用本机系统 Docker daemon 和 `/var/run/docker.sock`。支持 Linux amd64 / arm64；amd64 CPU 需支持 MongoDB 所需的 AVX。建议 4 vCPU、8 GiB 内存、30 GiB 可用磁盘起步。

宿主无需 Node.js、npm、Git 或源码。浏览器服务会通过 Docker socket 创建隔离的 Chrome 容器，因此该服务器及其部署文件应由可信管理员管理。

从同一版本的 Release 下载以下三个文件，放到一个空目录：

```text
my-agent/
├── compose.yaml
├── settings.json
└── secrets.env
```

镜像公开后不需 Docker 登录；当前私有仓库的 Release 下载仍需仓库访问权限。核对发布提供的 SHA256SUMS。不要把源码中的 `compose.template.yaml` 当成发行文件，它的镜像占位符由发布工具填写。

## 填写配置

在 `settings.json` 填写：

- `adminEmail`：管理员邮箱。
- `model.name`、`model.baseURL`：模型 ID 和兼容 API 地址。
- `model.promptRate`、`model.completionRate`：每百万 tokens 的美元价格，必须填数字。
- `origin`：默认 `http://127.0.0.1:3333`，适合通过 SSH 隧道访问；公网部署填写自己的 HTTPS 域名，并配置反向代理。

在 `secrets.env` 填写 `QWEN_API_KEY` 和至少 12 字符的 `DEMO_ADMIN_PASSWORD`。保留注册默认值 `closed` 即可自用。该文件作为只读文件挂载，内容不会由 Compose 做变量插值；包含 `#` 等字符时按 env 格式加引号。不要提交、分享或公开此文件，建议 `chmod 600 secrets.env`。

应用加密密钥和服务令牌首次启动时自动生成，保存在 Docker 命名卷，重复启动不会重置。管理员密码只用于首次建号，修改模板不会重置已有用户密码。

## 启动

在该目录执行：

```bash
docker compose up -d
docker compose ps
docker compose logs --tail 50 init
```

首次启动自动拉取全部六种镜像、校验配置、生成密钥和 Nginx 配置、初始化数据卷及管理员账号。`init` 和 `runtime-image` 正常完成后显示 `Exited (0)`，其余服务保持运行；首次拉取和初始化需要时间。只发布入口端口，数据库和浏览器内部端口不对外开放。Compose 对启动顺序和初始化完成条件的语义见 [Docker 文档](https://docs.docker.com/reference/compose-file/services/#depends_on)。

在服务器本机打开 `http://127.0.0.1:3333`。远程自用可在自己的电脑执行 `ssh -L 3333:127.0.0.1:3333 USER@SERVER` 后访问同一地址。公网访问通过 HTTPS 反向代理转发到服务器 `127.0.0.1:3333`；在设置中指定准确的 `origin` 和受信任代理 IP。无需配置 Cloudflare 也可以自用。

可在同目录增加 `.env` 修改非秘密的 Compose 参数：

```dotenv
COMPOSE_PROJECT_NAME=my-agent
AGENT_PORT=3333
AGENT_BIND=127.0.0.1
```

修改端口时同步修改 `settings.json` 的 `origin`。同机第二个实例使用另一个目录、不同项目名和端口；启用后不要随意修改项目名，否则 Compose 会使用另一组数据卷。

配置也可以放在独立目录，例如源码 checkout 的 `config/local/`。先把 `settings.json` 和 `secrets.env` 移到该目录，再在部署目录的 `.env` 设置绝对路径：

```dotenv
AGENT_CONFIG_DIR=/绝对路径/agentic-browser/config/local
```

该目录必须存在。默认不设置时使用 `compose.yaml` 所在目录。初始化、备份和恢复统一读取这个位置；升级不会覆盖用户配置，恢复会把备份中的配置写回指定位置。`.env` 仅存项目名、端口、配置路径和备份时间等 Compose 参数，模型与邮件密钥放在 `secrets.env`。

## 停止、重启和配置变更

```bash
docker compose --profile '*' down
docker compose up -d
# 已启用自动备份的站点，再启动备份服务：
docker compose --profile backups up -d backup
```

`--profile '*' down` 包含可选的备份服务，保留全部数据卷，管理员、聊天和密钥会保留。**不要加 `-v` / `--volumes`，它会删除数据库和密钥。** 修改配置前等现有任务结束，执行上述停止命令，编辑两份配置，再执行 `up -d`；只运行 `restart` 不会重新生成配置。若配置不合法，初始化器会指出字段并阻止首次启动，不会打印密钥。

数据存于此项目的 Docker 命名卷，包括数据库、上传、日志、配置和浏览器调度状态。现有 `agentctl` 的绑定目录备份不适用于此入口，不要混用。

## 容器内运维

以下功能需要发行文件中包含 `ops` 服务。**preview.10 尚不包含该服务；这些命令随下一版发布**，开发与验收进度见 [当前状态](STATUS.md)。所有命令都在部署目录执行，宿主只需 Docker / Compose。`ops` 是按需运行的管理容器，不提供公网管理接口。

```bash
docker compose run --rm ops status
docker compose run --rm ops backup
```

`status` 显示服务健康、维护状态与最近一次自动备份。备份要求没有活跃 Agent 或浏览器任务；繁忙时退出，稍后重试。它会启用维护页面、排空请求并依次停写应用与数据库，保存完整数据后恢复服务。结果中的 `backup` 是相对部署目录的路径，例如 `backups/20261030T120000Z-1234abcd`。

备份同时包含两份输入配置、当时的 Compose 文件和九个数据卷，包含应用加密密钥。文件有 SHA256 校验，未完成的 `.pending-*` 目录不作为可恢复备份。归档含密钥和用户数据，目录保持私有；异地副本应复制整个已完成的备份目录。`.env` 的项目名、监听地址和端口由目标服务器自行设置，不随备份覆盖。

```bash
docker compose run --rm ops verify-backup backups/实际备份目录
```

### 开启每日自动备份

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

### 从备份恢复到新项目

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

### 升级和失败回退

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

### 创建账号和重置密码

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
