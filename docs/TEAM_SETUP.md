# 成员身份原型

S1 已实现成员登录、个人 Agent 凭据、Session/Profile 所有者和旧配置显式迁移；这是分阶段开发版本。每 Session 的 Docker Runtime、私有挂载、受控出网及异常回收（S2）已通过基础自动验收，正式发行仍需部署环境核对。人工 Cookie 已独立于 Agent，15 秒一次性镜像授权、单窗口输入及连接撤销（S3）已通过自动验收。

成员由有服务器权限的部署管理员创建，不开放匿名注册。元数据使用 Node 24 内置 SQLite，位于 `BROWSER_DATA_DIR/identity/identity.sqlite`，目录 0700、文件 0600。密码使用独立随机盐和 scrypt 派生；浏览器登录 Cookie 和 Agent 凭据仅保存 SHA-256 摘要。接口使用独立随机秘密，不能互换用途。实现使用 [Node SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) 和 [scrypt API](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。

```sh
npm run members -- create alice
npm run members -- create bob
npm run members -- list
```

创建时在终端输入至少 12 字符的密码，不显示输入，也不通过命令行参数传递。随后按 [Runtime 指南](RUNTIME.md) 构建镜像，设置 `.env` 的 `BROWSER_AUTH_MODE=team`、`BROWSER_MODE=docker` 并正常重启服务。团队模式完全忽略共享 `AGENT_BROWSER_TOKEN`；现有 `legacy` 模式继续用于可信单用户演示。

打开工作台并登录个人账号，在“管理个人 Agent 凭据”中创建具名凭据，将一次显示的值配置给外部 Agent。Agent 只能操作由自身创建或由成员显式绑定的 Session；创建凭据时逐项授权可复用的 Profile，默认仅临时会话，配置创建和删除只允许成员本人；人工页面必须使用该成员的浏览器登录 Cookie。返回的 `humanUrl` 只包含 Session ID，不能代替人工身份。

成员从工作台创建的会话初始处于人工控制。工作台可选择个人 Agent 凭据并“绑定并接管”，绑定会停止旧 Agent 操作，完成后由人工交还；同成员的其他 Agent 不能自动认领。

登录 Cookie 有效 12 小时，HttpOnly、SameSite=Strict；HTTPS 入口额外设置 Secure。生产入口需配置 `PUBLIC_URL=https://实际域名` 并在可信代理终止 TLS；本地 SSH 端口转发可使用 localhost HTTP。所有使用 Cookie 的写请求校验同源 Origin 及自定义请求头。登录有进程内限速及并行上限，正式部署仍需配合入口限流。

Agent 凭据有效 90 天，每成员最多 20 个有效凭据，可分别撤销。退出浏览器只撤销该次人工登录。修改密码或停用成员会撤销该成员所有登录和 Agent 凭据；重新启用不会恢复旧凭据。

```sh
npm run members -- password alice
npm run members -- disable alice
npm run members -- enable alice
```

停用后后续请求立即拒绝，已连接画面在发送数据前或至多下一次 1 秒检查时终止；浏览器 Session 由 5 秒清理周期关闭。保存配置保留，不自动删除。运行中的异步请求在返回数据前再次检查凭据。服务器重启后成员与凭据仍存在；活动 Session 不自动恢复。

旧的无所有者 Profile 在团队模式下被冻结：不出现在成员列表，也不能凭已知 ID 打开。确认归属并结束占用它的旧会话后，由部署管理员执行：

```sh
npm run members -- claim-profile alice <旧配置的UUID>
```

这个命令只允许分配无所有者配置，不能重新分配其他成员的已有配置。HTTP 不提供认领接口。迁移后的配置不再出现在 legacy 模式列表。

自动验收见 [成员权限测试](../test/team.test.ts)：两个虚构成员、各自 Agent、直接按 ID 越权、配置占用、旧数据冻结/迁移、跨用途凭据、撤销、停用、CSRF 和持久化。真实账号数据不进入这些测试。

团队镜像连接需要有效人工 Cookie 与 15 秒、单次、绑定同一登录和控制版本的票据。同一会话只允许一个输入窗口；请关闭旧窗口后在另一个窗口重新连接。刷新和断网会重新取票，不自动交还控制权。测试入口：`npm test`、`npm run test:team`。
