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

## 停止、重启和配置变更

```bash
docker compose down
docker compose up -d
```

普通 `down` 保留数据卷，管理员、聊天、密钥会保留。**不要使用 `docker compose down -v`，它会删除数据库和密钥。** 修改配置前等现有任务结束，执行 `down`，编辑两份配置，再执行 `up -d`；只运行 `restart` 不会重新生成配置。若配置不合法，初始化器会指出字段并阻止首次启动，不会打印密钥。

数据存于此项目的 Docker 命名卷，包括数据库、上传、日志、配置和浏览器调度状态。备份需同时保存原始配置文件和完整数据卷（尤其 config 内的加密密钥）；停机后再做一致性备份。现有 `agentctl` 的绑定目录备份、定时任务和升级命令不适用于此入口，不要混用。此改动不迁移旧安装，不承诺跨版本升级；正式升级前应备份并遵循对应版本说明。
