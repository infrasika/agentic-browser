# 公网站点部署与运维

本目录管理 `agentic-browser.zkpass.org` 的宿主部署。LibreChat 源码位于独立仓库 `../librechat-agent`；浏览器能力由原生 Agent tools 调用私有 Browser Service。[完整 Agent 私有部署](../agent/INSTALL.md) 使用独立 Compose 安装。

## 组件与端口

| 组件 | 生产 | 本机隔离验收 |
| --- | --- | --- |
| LibreChat | `127.0.0.1:3080` | `127.0.0.1:3091` |
| Nginx | 域名端口 80，由 Cloudflare 提供公网 HTTPS | `127.0.0.1:3081` |
| Browser 控制 API | `127.0.0.1:8081` | `127.0.0.1:18081` |
| Browser 画面/输入 | `127.0.0.1:8082` | `127.0.0.1:18082` |
| MongoDB | `127.0.0.1:27019/LibreChatBrowserDemo` | 独立库 `LibreChatBrowserAcceptance` |
| Redis | `127.0.0.1:6381`，`browser-production` 前缀 | `browser-acceptance` 前缀 |

两个应用以 ubuntu 用户运行于 systemd；数据库和每会话 Chrome 使用 Docker。Nginx 仅转发聊天和两个精确 viewer WebSocket 路径，删除伪造身份头；私有控制 API 不映射公网。当前每用户一个会话、实际并发 5、硬上限 10，暂不扩容。

## private.env 的有效变量

文件位于 `.deployment/librechat/private.env`。目录 0700、文件 0600，不进入 Git、镜像或发行包。`setup` 不覆盖现有值；`doctor` 只输出变量名，并拒绝未知键。

| 变量 | 当前用途 |
| --- | --- |
| `DOMAIN_CLIENT` | 唯一公网 origin；生成 LibreChat 的 client/server 域名、邮件链接与 viewer Origin 校验 |
| `QWEN_API_KEY` | 模型认证 |
| `QWEN_BASE_URL`、`QWEN_MODEL` | 模型地址、Agent 与标题模型 |
| `QWEN_PROMPT_RATE`、`QWEN_COMPLETION_RATE` | 每百万输入/输出 token 的美元记账费率 |
| `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY` | 登录/注册的前端挑战与服务端验证 |
| `DEMO_ADMIN_EMAIL`、`DEMO_ADMIN_PASSWORD` | 幂等管理员 bootstrap；不修改已有账号密码 |
| `DEMO_START_CREDITS` | 新账号初始额度；已有余额不覆盖 |
| `BROWSER_SERVICE_TOKEN` | LibreChat 与 Browser Service 的内部认证 |
| `JWT_SECRET`、`JWT_REFRESH_SECRET` | 登录和刷新令牌签名 |
| `CREDS_KEY`、`CREDS_IV` | LibreChat 凭据加密 |
| `BROWSER_RUNTIME_IMAGE` | 已安装、验收的固定 runtime image ID |
| `BROWSER_MAX_SESSIONS` | 实际放行量，范围 1–10 |
| `CLOUDFLARE_EMAIL_API_TOKEN`、`DEMO_EMAIL_FROM` | Cloudflare SMTP 发信认证与已验证域名发信地址 |
| `DEMO_EMAIL_TEST_TO` | 发信验收收件人，也是现有邮件验证凭据的组成部分 |

不用手写 `DOMAIN_SERVER`：渲染器从 `DOMAIN_CLIENT` 生成。邮件配置必须与已验证凭据匹配，才启用密码找回；修改后需要重新验收，不能直接删除验证凭据。费率由部署者根据实际模型配置，最终账单以供应商为准。

## 配置与应用

使用 Node 24.22.1。先在两个源码仓库分别安装依赖，并在 LibreChat 构建前端。站点配置命令：

```bash
npm ci
npm run setup:librechat
npm run doctor:librechat
node scripts/sync-browser-contract.mjs ../librechat-agent --check
node scripts/render-librechat-config.mjs
node scripts/render-librechat-services.mjs
```

两端协议定义由 `src/api/` 生成到 LibreChat data-provider；不手改生成文件。生成的 YAML、环境参数和 systemd 单元在 `.deployment/librechat/`。渲染不重启服务；运行单元安装前用 `systemd-analyze verify` 校验。修改必须先隔离验收，应用时等待没有活动会话。

```bash
docker compose -f deploy/librechat/compose.infrastructure.yaml up -d
node scripts/run-librechat.mjs bootstrap
sudo install -m 0644 .deployment/librechat/agentic-browser-service.service /etc/systemd/system/
sudo install -m 0644 .deployment/librechat/librechat-browser-demo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart agentic-browser-service librechat-browser-demo
npm run health:librechat
```

Nginx 配置在 `nginx.conf`；修改前校验 `nginx -t`，再 reload。保持当前 Cloudflare 到源站的网络边界。`nginx.acceptance.conf` 仅用于回环验收，不能直接用于公网。

## 邮件、备份与恢复

```bash
npm run mail:test:librechat
npm run health:librechat
python3 scripts/backup-librechat.py --help
python3 scripts/verify-librechat-recovery.py --help
```

邮件测试会向 `DEMO_EMAIL_TEST_TO` 发信；配置没变时不需要重复发送。公网备份在上海时间每日 04:00 开始，忙时每小时空闲重试至 23:00，保留 7 份。备份配置和 systemd 生成器分别是 `backup.json`、`scripts/render-librechat-backup.mjs`；隔离恢复步骤见 [RECOVERY.md](RECOVERY.md)。不能把这套宿主运维脚本应用到 Compose 安装。

详细状态见 [进度](../../docs/plans/LIBRECHAT_PROGRESS.md)。自动验收使用独立账号/数据库/回环端口和模拟模型；真实公开站点任务和发信测试必须按其具体范围执行，不能把模拟验收等同于真人 Turnstile 或真实模型验收。
