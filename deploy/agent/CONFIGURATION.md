# 配置文件与容器的对应关系

配置在**部署时**读取，不在构建时写入镜像。旧 `.deployment/librechat/private.env` 已退出当前架构；修改它不会改变现在的站点。新部署只维护安装目录的 `config/settings.json` 与 `config/secrets.env`。

## 文件如何传到应用

| 输入 | 传递方式 | 使用者 |
| --- | --- | --- |
| `config/settings.json` | 只读挂载为 `/config/settings.json`；启动时生成临时 LibreChat 配置 | Agent |
| `config/secrets.env` | Compose 的 `secrets.agent.file`，挂载为 `/run/secrets/agent`；启动程序读取后注入应用进程环境 | Agent |
| `config/browser-token` | Compose secret，挂载为 `/run/secrets/browser_token` | Agent、Browser Service |
| `release.json`、实例信息与部分 settings | `agentctl render` 生成安装目录 `.env`，供 `compose.yaml` 的 `${…}` 插值 | Compose |
| `config/nginx.conf` | 根据 origin、代理信任地址生成，只读挂载 | Gateway |

因此，**不是把 `private.env` 整份塞进 Compose YAML**。生成的 `.env` 包含六个镜像地址、实例名、UID/GID、Docker socket GID、入口端口、origin、数据目录和浏览器并发；不包含 Qwen key、管理员密码、JWT 或 SMTP 密码。Compose 只记录 secret 文件路径，应用启动后才读取这些值。

普通 Compose secrets 使用文件挂载，不是宿主磁盘加密服务。安装目录为 0700，配置文件为 0600；宿主管理员仍能读取文件和进程。不要公开配置目录、备份或进程环境。[Docker Compose secrets 说明](https://docs.docker.com/compose/how-tos/use-secrets/)

## settings.json：普通设置

`init` 生成模板。只修改已有键或以下支持的可选键，不添加旧环境变量名。

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

这里没有 `QWEN_MODEL`、`QWEN_BASE_URL`、`DEMO_ADMIN_EMAIL` 等旧键，它们已归入 settings。格式遵循 Node `parseEnv`；需要包含 `#` 等特殊字符时使用引号。不要使用 `source secrets.env` 或将真实值作为命令行参数。

## 修改与生效

编辑配置文件后，在任务空闲时执行已安装的管理工具：

```bash
python3 /srv/my-agent/agentctl.py --directory /srv/my-agent apply
python3 /srv/my-agent/agentctl.py --directory /srv/my-agent doctor
```

`apply` 先备份，再重建容器加载配置。不要手改生成的 `.env`、`nginx.conf` 或容器内 `/tmp/agent/librechat.yaml`；它们会重新生成。SMTP 配置需通过 `mail-test` 后启用找回密码，见 [运维](OPERATIONS.md)。

Git/GHCR 的发布授权独立于以上文件。构建无需业务密钥，发布使用 Docker 已有登录；CI 可用 `GITHUB_TOKEN` 登录 Docker。不要把发布 Token 加入 `secrets.env`、旧 `private.env` 或安装包。
