# 配置文件与容器的对应关系

配置在**部署时**读取，不在构建时写入镜像。运行目录由 `agentctl.mjs --directory` 指定；配置目录可通过初始化时的 `--config-directory` 单独指定。源码部署统一使用仓库根目录的 `config/local/`，日常编辑其中的 `settings.json` 与 `secrets.env`。

源码仓库根目录不需要 `.env`。管理工具只读取所选安装目录中的 `.env`；本机 `.deployment/` 不进入 Git 或镜像，Mac 构建也不依赖它。

构建时只需要版本、目标架构和公共依赖；发布时使用独立的 Docker/GHCR 登录。Qwen key、模型名称、域名和邮件设置在目标机器执行 `init` 后填写。同一组镜像可以供多个部署者使用各自的配置，无需为每个 key 重新 build。Mac 与 Ubuntu 的统一命令见源码仓库的 `docs/BUILD.md`；部署发行包不包含维护者构建工具。

## 新 clone 后从哪里开始

源码根目录和新发行包均提供以下公开示例；它们不包含本站的配置值，也不被应用直接加载：

| 示例文件 | 可以提前确认的内容 |
| --- | --- |
| `config/settings.example.json` | 模型、费率、域名、管理员邮箱、注册策略、额度和容量的字段及默认值 |
| `config/secrets.env.example` | 需要填写的 API key、可选服务凭据，以及由安装器自动生成的密钥 |

只在 Mac 或 Ubuntu **构建、发布镜像**时，执行构建文档中的 npm 命令即可，无需填写示例或复制 `.deployment/`。**部署**时，在目标 Linux 上取得固定的 `release.json` 和镜像，运行安装包的 `agentctl.mjs ... init`。从源码使用相同入口则是：

```bash
npm ci
AGENT_DIR="$PWD/.deployment/local"
AGENT_CONFIG="$PWD/config/local"
npm run agent -- --directory "$AGENT_DIR" init \
  --config-directory "$AGENT_CONFIG" --release /absolute/path/to/release.json
nano "$AGENT_CONFIG/settings.json"
nano "$AGENT_CONFIG/secrets.env"
npm run agent -- --directory "$AGENT_DIR" up
npm run agent -- --directory "$AGENT_DIR" doctor
```

`release.json` 来自构建后的安装包或发布回执，不是手写空文件；本机 image ID 离线包先导入镜像，并给 `init` 加 `--development`。运行目录和配置目录都必须不存在，首次安装的完整前置条件和 HTTPS 步骤见部署指南（源码 `docs/DEPLOYMENT.md`、包内 `README.md`）。

`init` 生成真实 `settings.json`、`secrets.env` 和 `browser-token`，权限为目录 0700、文件 0600。**编辑生成的文件，不用空示例覆盖它们**，否则会丢掉自动生成的管理员密码和登录/加密密钥。新建安装使用自己的密钥；运行中的实例升级保留原密钥。

必须由你填写的是模型 API key、模型名称/地址/费率和管理员邮箱；公网部署还需域名和 Turnstile 公私钥，启用 SMTP 时填写发信参数与凭据。管理员初始密码、JWT、加密密钥和内部浏览器 token 自动生成，下面的字段表说明每项用途。

仓库 `config/` 提交两份公开示例；真实配置统一放 `config/local/` 并被 Git 忽略。`.deployment/` 仅保存本机生成的运行文件、数据和备份，新 clone 无需复制它。安装器、Compose 模板、初始化逻辑和示例均由 Git 提供，`init` 会自动生成实例所需文件。根目录无需额外 `.env.example`。

`--config-directory` 的绝对路径记录在运行目录的 `installation.json`，后续 `up`、`apply`、备份和定时器自动读取，无需重复传参。恢复到新实例时也可指定新的配置目录，原配置不会被复用。独立发行包安装若省略该参数，默认使用运行目录下的 `config/`；两种位置共用同一套工具。

例如发行包安装到 `/srv/my-agent` 且不指定独立配置目录，文件位置如下：

```text
/srv/my-agent/
├── config/
│   ├── settings.json   # 模型、费率、额度、容量等
│   ├── secrets.env     # API key、登录和邮件密钥
│   └── browser-token   # 自动生成的内部服务密钥
├── .env                # 自动生成，供 Compose 替换占位符
└── compose.yaml
```

## 文件如何传到应用

| 输入 | 传递方式 | 使用者 |
| --- | --- | --- |
| 配置目录内 `settings.json` | 只读挂载为 `/config/settings.json`；启动时生成临时 LibreChat 配置 | Agent |
| 配置目录内 `secrets.env` | Compose 的 `secrets.agent.file`，挂载为 `/run/secrets/agent`；启动程序读取后注入应用进程环境 | Agent |
| 配置目录内 `browser-token` | Compose secret，挂载为 `/run/secrets/browser_token` | Agent、Browser Service |
| `release.json`、实例信息与部分 settings | `agentctl.mjs` 在启动或应用配置时生成安装目录 `.env`，供 `compose.yaml` 的 `${…}` 插值 | Compose |
| 配置目录内 `nginx.conf` | 根据 origin、代理信任地址生成，只读挂载 | Gateway |

生成的 `.env` 包含六个镜像地址、实例名、UID/GID、Docker socket GID、入口端口、origin、`AGENT_CONFIG_DIR` 配置路径、数据目录和浏览器并发；不包含 Qwen key、管理员密码、JWT 或 SMTP 密码。Compose 只记录 secret 文件路径，应用启动后才读取这些值。

“插值”就是替换 YAML 中的占位符。例如 `.env` 中的 `AGENT_PORT=3351` 会让 Compose 将 `${AGENT_PORT:-3333}` 替换为 `3351`，最终端口映射为 `127.0.0.1:3351:8080`。其中 `:-3333` 表示未设置时使用默认值。`${AGENT_IMAGE:?...}` 同理替换成镜像地址，缺失时则报错。

管理工具会显式通过 `--env-file` 指定本安装目录的 `.env`。这个文件用于解析 Compose 配置，并不会自动把其中每个变量注入容器；容器环境变量由 YAML 的 `environment` 指定，密钥则按上表作为文件挂载。

普通 Compose secrets 使用文件挂载，不是宿主磁盘加密服务。安装目录为 0700，配置文件为 0600；宿主管理员仍能读取文件和进程。不要公开配置目录、备份或进程环境。[Docker Compose secrets 说明](https://docs.docker.com/compose/how-tos/use-secrets/)

运行目录中的 `installation.json` 记录实例实际使用的配置位置。现有实例变更路径时，需要先完整备份并停写，同步元数据、Compose 挂载和定时器，再显式重建容器；仅改变 secret 的源文件路径，Compose 可能复用仍指向旧路径的容器。不能只移动文件或用符号链接替代。新部署直接用 `--config-directory` 选定位置即可。

## settings.json：普通设置

`init` 生成模板。只修改已有键或以下支持的可选键。

| 字段 | 用途 |
| --- | --- |
| `version` | 配置格式，保持 `1` |
| `name`、`origin` | 应用名称和完整访问地址；公网使用 HTTPS，本地允许 loopback HTTP |
| `adminEmail` | 首次创建管理员使用的邮箱 |
| `registration` | `closed` 或 `public`；默认关闭公开注册 |
| `turnstileSiteKey` | Turnstile 公钥；公开注册必须同时配置私钥与 HTTPS |
| `model.name`、`model.baseURL` | Qwen 模型名称和兼容 API 地址；不是 API key |
| `model.promptRate`、`model.completionRate` | 输入/输出 credits 每 token，换算见下文 |
| `credits.initial` | 新账号一次性初始 credits，默认 200,000 |
| `credits.daily`、`credits.timeZone` | 初始全站日预算、账期时区；管理员页面保存的预算优先 |
| `browser.maximum` | 全站并发 1–10，默认 1；每账号固定最多一个会话 |
| `trustedProxyIPs` | 可选，明确的上游代理 IP 列表；默认空 |
| `smtp` | 可选对象：`host`、`port`、`encryption`、`from`、`username`；参见运维手册 |

当前计费代码使用 **1,000,000 credits = 1 美元**，扣费为 token 数乘对应 rate。因此供应商输入价为 0.5 美元/百万 tokens 时，应填写 `promptRate: 0.5`。这是单位示例，不是某个 Qwen 型号的报价；模型价格、计费地区和币种换算需要按部署时实际供应商配置确认。

## secrets.env：私密设置

| 变量 | 用途与维护方式 |
| --- | --- |
| `QWEN_API_KEY` | 模型 API key，部署者填写 |
| `DEMO_ADMIN_PASSWORD` | 首次创建管理员密码，初始化随机生成；已有账号改密码使用 `user-reset` |
| `JWT_SECRET`、`JWT_REFRESH_SECRET` | 登录会话签名密钥，首次生成，升级保留 |
| `CREDS_KEY`、`CREDS_IV` | 应用凭据加密密钥，首次生成，升级保留 |
| `TURNSTILE_SECRET_KEY` | 可选 Turnstile 私钥，必须与 settings 的 site key 配对 |
| `SMTP_PASSWORD` | 可选 SMTP 凭据；Cloudflare 发信凭据也放这里 |

模型名称、API 地址和管理员邮箱在 `settings.json` 中设置。密钥格式遵循 Node `parseEnv`；需要包含 `#` 等特殊字符时使用引号。不要使用 `source secrets.env` 或将真实值作为命令行参数。

## 修改与生效

编辑配置文件后，在任务空闲时执行已安装的管理工具：

```bash
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent apply
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent doctor
```

`apply` 先备份，再重建容器加载配置。不要手改生成的 `.env`、`nginx.conf` 或容器内 `/tmp/agent/librechat.yaml`；它们会重新生成。SMTP 配置需通过 `mail-test` 后启用找回密码，见 [运维](OPERATIONS.md)。

Git/GHCR 的发布授权独立于以上文件。构建无需业务密钥，发布使用 Docker 已有登录；CI 可用 `GITHUB_TOKEN` 登录 Docker。不要把发布 Token 加入 `secrets.env` 或安装包。

## Cloudflare 配置边界

官方公网安装流程统一使用 Cloudflare DNS/代理、Full (strict) 和 Turnstile，逐步设置见安装指南（源码中为 `docs/DEPLOYMENT.md`，发行包中为 `README.md`）。这是受支持的公网入口路径，不新增另一套应用或 Compose。

| Cloudflare 配置 | 保存在哪里 |
| --- | --- |
| DNS、代理、缓存、WebSockets、SSL 模式 | Cloudflare 控制台，不传入应用 |
| Origin CA 证书与私钥 | 宿主 Nginx 的证书目录，不放入应用配置或镜像 |
| Turnstile Site key | `settings.json` 的 `turnstileSiteKey` |
| Turnstile Secret key | `secrets.env` 的 `TURNSTILE_SECRET_KEY` |
| 可选 Email Sending token | `secrets.env` 的 `SMTP_PASSWORD`；发信参数放 `settings.smtp` |

应用不需要 Cloudflare Global API Key、DNS 编辑 token 或账号 ID。公开注册必须有 Turnstile，但 `registration: closed` 仍然是同一套账号系统的配置开关。邮件只维护现有 SMTP 实现，不增加 Cloudflare 专用 HTTP 发信实现。
