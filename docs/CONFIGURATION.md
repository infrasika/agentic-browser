# 配置参考

构建镜像不需要模型密钥、域名或本站配置。部署时填写 `settings.json` 和 `secrets.env`，同一套镜像可以供不同用户部署。首次安装见 [部署指南](DEPLOYMENT.md)，修改、备份和恢复见 [运维指南](OPERATIONS.md)。

## 文件位置

发行文件默认放在一个私有目录，例如 `/srv/my-agent/`：

```text
/srv/my-agent/
├── compose.yaml     # 发行文件，固定六种镜像的 digest
├── settings.json    # 普通设置
├── secrets.env      # 用户填写的凭据
├── .env             # 可选，Compose 项目名、端口等参数
├── backups/         # 运维工具生成的完整备份
└── releases/        # 升级前存放新版本 compose.yaml
```

也可以把两份用户配置放到独立目录，并在部署目录 `.env` 设置 `AGENT_CONFIG_DIR=/绝对路径/config/local`。先创建该目录并放入两份文件；初始化、备份、恢复都读取这个位置。两个实例必须使用不同项目名、端口和配置目录。启用后不要随意更改项目名，否则会选中另一组数据卷。

源码只提交 `config/settings.example.json` 和 `config/secrets.env.example`。新 clone 需要在本机运行时，可复制到被 Git 忽略的 `config/local/`；只构建和发布时无需创建它。`.deployment/` 是本机部署目录，不是新 clone 的依赖。

应用身份密钥、内部浏览器令牌、生成的网关配置和 SMTP 验证收据保存在 Docker 命名卷，启动时自动生成或更新。重复启动保留已有密钥；损坏的身份文件会阻止启动，应从备份恢复。

## settings.json

JSON 不支持注释或尾随逗号。模型相关空值必须在首次启动前填写。

| 字段 | 用途 |
| --- | --- |
| `version` | 配置格式，保持 `1` |
| `name` | 站点名称 |
| `origin` | 完整访问地址；公网使用 HTTPS，本地允许 loopback HTTP；不带额外路径 |
| `adminEmail` | 首次创建管理员的邮箱，管理员与普通用户共用登录页 |
| `registration` | `closed` 或 `public`，默认关闭公开注册 |
| `turnstileSiteKey` | Turnstile 公钥；启用时与私钥配对，公开注册必须配置 |
| `model.name` | 模型 ID，首次建站前确定 |
| `model.baseURL` | 兼容 API 根地址，通常以 `/v1` 结尾，不加 `/chat/completions` |
| `model.promptRate`、`model.completionRate` | 输入/输出的美元每百万 tokens 价格，填非负数字 |
| `credits.initial` | 新账号一次性初始 credits，默认 `200000`，不是每日刷新 |
| `credits.daily`、`credits.timeZone` | 初始全站每日预算和账期时区，默认 `20000000`、`Asia/Shanghai`；管理员已保存的预算优先 |
| `browser.maximum` | 全站并发 1–10，默认 1；每账号最多一个未结束会话 |
| `trustedProxyIPs` | 可选的上游代理 IP 列表，默认空；宿主 Nginx 场景填写实际 Docker 网桥来源 IP |
| `smtp` | 可选对象，含 `host`、`port`、`encryption`、`from`、`username`；见运维指南 |

计费单位为 **1,000,000 credits = 1 美元**，消耗为 token 数乘对应 rate。例如输入价为 0.5 美元/百万 tokens，则 `promptRate` 填 `0.5`。这是单位示例，不是 Qwen 报价；币种、地区和实际费率由部署者核对。预算按填写的费率记账。

已有实例暂不支持直接修改 `model.name` 来切换 Agent 模型；启动检查会拒绝不一致的型号。可以轮换 API key 或更新同一模型的接口地址。误改型号时恢复原值，不要删除数据库绕过检查。

## secrets.env

此文件只接受以下变量。权限设为 `0600`，不要提交 Git、放进镜像或发送到聊天。

| 变量 | 用途 |
| --- | --- |
| `QWEN_API_KEY` | 与模型及接口区域匹配的 API key，必填 |
| `DEMO_ADMIN_PASSWORD` | 首次建号密码，至少 12 字符，部署者填写并保存；修改它不会重置已有账号 |
| `TURNSTILE_SECRET_KEY` | 可选 Turnstile 私钥；与 settings 的 site key 同时填写或同时留空 |
| `SMTP_PASSWORD` | 可选 SMTP 凭据；Cloudflare Email Sending token 也填在这里 |

文件通过只读挂载传给初始化器，按 Node `parseEnv` 读取，不由 Compose 插值。含 `#` 等字符时用引号包裹，不要使用 `source secrets.env`。JWT、凭据加密密钥和 browser token 由初始化器生成在配置卷内，不应手动加入此文件。

## .env 与插值

`.env` 是可选的 Compose 参数文件，由部署者按需创建，不再由外部安装器生成。只在 `compose.yaml` 所在目录使用；仓库根目录无需额外 `.env`。

| 参数 | 默认值 / 用途 |
| --- | --- |
| `COMPOSE_PROJECT_NAME` | `agentic-browser`；决定项目和数据卷名称 |
| `AGENT_PORT`、`AGENT_BIND` | `3333`、`127.0.0.1`；入口端口和地址 |
| `AGENT_CONFIG_DIR` | `.`；两份用户配置所在目录，可设绝对路径 |
| `AGENT_BACKUP_TIMEZONE`、`AGENT_BACKUP_HOUR` | `Asia/Shanghai`、`4`；每日备份时区和小时 |
| `AGENT_BACKUP_KEEP` | `7`；保留完整备份数，范围 1–365 |
| `AGENT_ALLOW_LOCAL_IMAGES` | `0`；仅维护者本机候选验收时设为 `1`，正式部署保持默认 |

例如 `.env` 写 `AGENT_PORT=3351`，Compose 就把 YAML 中 `${AGENT_PORT:-3333}` 替换成 `3351`；未设置时使用 `3333`。这就是插值。`.env` 的所有变量不会自动进入应用环境，只有 Compose 明确引用的字段会生效。镜像地址由发行文件固定，模型密钥不参与 YAML 插值。

## 容器如何读取配置

| 数据 | 传递方式 |
| --- | --- |
| 用户的两份配置 | `init` 只读挂载 `/input/settings.json`、`/input/secrets.env`，校验后生成运行配置 |
| 应用配置、身份密钥 | 专属 `config` 卷；Agent 只读挂载，启动程序注入应用进程环境 |
| 浏览器配置 | 独立 `browser-config` 卷，只含地址、容量和服务 token，不含模型或登录密钥 |
| 网关配置 | 独立 `gateway-config` 卷，由 origin 和代理信任设置生成 |
| 运维状态 | `operations` 卷，保存操作锁、维护状态和定时备份收据 |

宿主可信管理员控制部署目录、Docker socket 和备份。文件挂载并不加密宿主磁盘。备份包含用户数据及身份密钥，恢复时必须一并保留。

Cloudflare DNS、代理、SSL 模式在控制台配置；源站证书放宿主 Nginx 目录；Turnstile 与 SMTP 凭据按上表填写。应用无需 Cloudflare Global API Key、DNS 编辑 token 或账号 ID。Git/GHCR 授权独立使用 Docker/系统凭据库，不放在站点配置中。
