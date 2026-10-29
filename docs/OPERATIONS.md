# 私有 Agent 运维

使用 `agentctl.mjs` 管理一个完整 Agent 实例，应用只在镜像里运行；宿主需要与镜像架构匹配的 Linux、Node.js 24+、flock（util-linux）、Docker Engine 26+ 和 Compose v2/v5。每个安装目录对应独立的 Compose project。

## 安装后的配置与数据

首次部署按安装指南执行（源码中为 `docs/DEPLOYMENT.md`，发行包中为 `README.md`），其中集中维护软件准备、Cloudflare、初始化、密钥填写和公网验收步骤。本手册以 `/srv/my-agent` 为示例运行目录，使用时换成自己选择的路径。真实配置目录由 `installation.json` 的 `configDirectory` 记录；源码部署使用根目录 `config/local/`，未显式指定时默认为运行目录下的 `config/`。

版本清单固定六个镜像，普通模式只接受 registry digest。默认入口仅监听 `127.0.0.1:3333`，数据库和 Browser 控制 API 不发布公网。配置字段及挂载关系见 [CONFIGURATION.md](CONFIGURATION.md)。

数据明确保存在安装目录的 `data/`：`mongo-data`、`redis-data`、`browser-data`、`uploads`、`images`、`logs`。Compose 使用绑定这些目录的本地数据卷，浏览器仍能按会话子目录隔离挂载。容器删除或重建不会删除这些文件；删除安装目录则会丢失数据。Mongo/Redis 子目录由容器内数据库用户持有，不要递归修改权限。启动会拒绝缺失或符号链接数据目录，不会偷偷创建空库。

外层代理模板 `nginx.host.conf` 使用 `agent.example.com`、回环端口 3333 和源站 TLS，需填写自己的域名和证书，配合 Cloudflare Full (strict)。外层代理覆盖 `X-Real-IP`，内层 gateway 仅信任 `settings.json` 的 `trustedProxyIPs` 中明确列出的代理源 IP，默认不信任任何转发 IP。宿主 Nginx 经 Docker 回环端口进入时，该源 IP 通常是 `front` 网络的 Gateway，必须实际检查；若删除重建网络导致地址变化，应重新配置。不要填写网段或公网访客地址。该设置只信任客户端地址，用户身份仍由 LibreChat 登录验证。

`.env` 由工具从 settings 自动生成，不需要手动同步 origin/容量。修改运行中的 settings 或 secrets 后，等待任务空闲并运行 `apply`：先备份、停止写入，再加载新配置；不会重置已有密码或发放 credits。管理面板内保存的日预算优先于首次 YAML 默认值。

```bash
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent apply
```

## 普通账号与密码恢复

```bash
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent user-create
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent user-reset
```

命令交互输入邮箱，创建时还输入显示名/用户名；密码使用隐藏输入且要求重复确认。重复创建返回 `already_exists`，不修改原密码和余额。新账号始终是普通用户，使用原生注册路径领取一次初始额度。

服务器侧恢复命令复用原生单次密码重置，撤销旧登录、refresh session 和 passkey，不增加 credits，也不发送邮件。已启用的双因素认证不会被此命令自动关闭。自动化可用 `--input-file /private/account.json`，文件必须由当前用户持有、权限 0600；密码不接受命令行参数，不写到报告中。

## 可选通用 SMTP

所有供应商共用一套 SMTP 实现。Cloudflare Email Sending 的开通、固定 SMTP 参数和 token 权限见安装指南；无需另装 Worker 或增加 REST 发信后端。使用已有其他供应商时，`settings.json` 增加：

```json
"smtp": {
  "host": "smtp.example.org",
  "port": 465,
  "encryption": "tls",
  "from": "agent@example.org",
  "username": "your-smtp-user"
}
```

在 `secrets.env` 填写 `SMTP_PASSWORD`。支持隐式 TLS 或强制 STARTTLS（通常为 587）；验证服务端证书，不提供关闭证书验证的开关。用户名/密码必须成对提供；受控无认证 SMTP 可同时留空。发信域名认证仍由邮件供应商管理。

```bash
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent mail-test --to your-address@example.org
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent apply
```

`mail-test` 只向指定地址发送一封配置测试邮件；SMTP 接受后保存与域名、SMTP 配置和凭据绑定的验证收据，`apply` 后启用原生 Forgot Password。修改这些配置后旧收据失效，找回入口关闭，需重新测试。SMTP 接受不等于到达收件箱，部署者仍需核对收件。未配置邮件时可使用服务器侧恢复命令。

## 备份与恢复

```bash
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent backup
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent verify-backup /srv/my-agent/backups/BACKUP_NAME
```

有运行、排队、人工接管、未确认事件或未清理 runtime 时会延后，不终止用户任务。空闲时入口进入维护状态并排空已进入应用的请求，再停止 Agent、Browser、Redis 和 Mongo 写入。归档包括六个数据卷、所选配置目录的配置/密钥、Compose 和固定镜像清单；每个文件有 SHA-256，完整验证后才去掉 `.pending` 标记。备份结束先恢复健康，再解除维护。

这是停写后的完整数据卷快照，恢复要求相同数值 UID/GID、匹配的固定镜像及安装格式 v1 的 Compose 拓扑；不支持跨 Mongo 大版本转换。归档包含密钥、账号和聊天，目录/文件权限为 0700/0600，应使用受控存储。镜像本身、外层 HTTPS 代理/证书、手工额外挂载文件不在备份内；使用本机镜像时需另外保留对应镜像（候选包的 images.tar.gz 包含六个安装镜像）。

## 定时备份与中断恢复

以安装目录的所有者运行（不要用 root 替代该用户）：

```bash
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent schedule --timezone Asia/Shanghai --hour 4 --keep 7 --retry-minutes 60
```

命令在所选配置目录生成私密的 `backup.json`，在运行目录的 `state/systemd/` 生成两个 systemd unit，不修改其他实例。由服务器管理员将输出目录内的 `.service` 和 `.timer` 用 `sudo systemctl link` 链接，再 `sudo systemctl enable --now TIMER_NAME` 启用。服务显式以安装目录所属 UID/GID 运行，备份进程不使用 root，且该用户本身须有 Docker 访问权限。系统定时器不依赖 SSH 登录或用户服务管理器缓存的组列表，开机后会继续检查；不支持 systemd 的宿主可由自己的调度器每分钟调用 `maintain`。

```bash
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent maintain
node /srv/my-agent/agentctl.mjs --directory /srv/my-agent maintenance-status
```

定时器每分钟检查中断恢复；每天按指定时区从设定小时开始尝试备份。任务运行或人工接管期间延后，按 `retry-minutes` 重试；成功后同一个当地日期不重复备份。系统错过运行时间后会在下一次检查补做。所有维护操作共用实例锁，互不并行。

默认保留最近 7 份**该调度器生成的完整备份**，手工备份、升级前备份和 `.pending` 不自动删除。归档或复制失败可在私密状态文件和 systemd journal 中查到失败状态，不输出凭据。普通备份被强杀后，下一次检查会清理属于该实例的遗留归档辅助容器、恢复健康，再开放入口；不会自动恢复失败升级、未完成 restore 或来历不明的维护标记。人为停止服务但没有备份恢复意图时，也不会自动启动。

可加 `--copy-to /mnt/backup/agent-copies`，将每份备份校验后原子复制到另一个预先创建的 0700 目录，再轮转；复制失败只重试同一份快照，不重复停服务。路径可指向受控的加密磁盘或远程挂载目录，目录所有者须与实例一致。工具不会自动配置存储账号、加密或挂载；远程挂载应由宿主保证可用并禁止掉线后写入本地挂载点。本机目录副本不构成异地灾备。未提供目标时只有本地备份。

备份包含调度策略供审计，但恢复出的新实例不会继承定时器、复制目标或自动开启备份；验收后重新执行 `schedule`。升级时从新候选包运行 `agentctl.mjs ... upgrade`，成功后更新安装目录的管理工具；定时器会使用安装目录的新工具；Node 安装路径变化后需重新执行 `schedule` 并重新加载 systemd 单元。

恢复**只允许新的安装目录和新 project/数据卷**：

```bash
node /srv/my-agent/agentctl.mjs --directory /srv/restored-agent restore /srv/my-agent/backups/BACKUP_NAME --port 3334
# 查看恢复配置后启动
node /srv/restored-agent/agentctl.mjs --directory /srv/restored-agent recover
```

恢复可增加 `--config-directory /absolute/path/to/config/restored` 指定新的独立配置目录。运行目录和配置目录都拒绝覆盖已有路径；不会沿用备份源的配置路径。

恢复采用当前安装器的目录挂载模板，目标数据只落在新目录；不会复用源目录或源代理信任地址。恢复先验证摘要、路径与条目类型，拒绝符号链接及活跃 runtime 记录。保留账号/密码/聊天/credits/预算，生成新的 Browser instance ID，避免接管原实例容器。默认改为新回环 origin、关闭注册和 Turnstile，旧邮件收据因 origin 改变而失效；先停在未运行状态供核对配置，不自动重放网页操作。切换回正式域名及验证 SMTP 后再开放访问。

## 升级与中断处理

```bash
node /path/to/next-bundle/agentctl.mjs --directory /srv/my-agent upgrade --release /path/to/next-bundle/release.json
```

当前支持相同 Compose 拓扑的版本升级。先检查并准备固定镜像，空闲时生成升级前备份，再同步新版包的 Compose 模板并启动新版本，健康通过后解除维护；保留账号、配置和密钥。`compose.yaml` 由发行包管理，直接修改会在升级时被替换，旧副本保存在升级前备份中。升级失败保留维护状态与备份路径，不自动把旧程序连接到可能已迁移的新数据库。用升级前备份恢复到一个新实例，验收后再切换入口。

普通备份被中断时，`state/operation.json` 保留恢复意图；执行 `recover` 恢复服务。未完成的 restore 或失败升级会拒绝直接解除维护。进程被终止、强杀或宿主断电后，已启用的定时器会尝试恢复普通备份，否则手动 `recover`。升级失败必须从升级前备份恢复到新实例，不要手工删除维护标记来绕过失败状态。

诊断仅输出状态和汇总。必要时在安装目录运行 `docker compose ps` / `docker compose logs` 查看本机详情；日志和备份不应上传公共 issue。当前没有一键销毁或覆盖恢复命令。
