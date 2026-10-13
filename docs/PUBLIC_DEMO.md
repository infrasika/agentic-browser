# 受限访客演示

本文说明 `BROWSER_AUTH_MODE=demo` 的断网固定演示。让访客自己的 Agent 通过远程 MCP 访问公网网页，请使用独立的 `public` 模式和 [Ubuntu 公共 MCP 部署指南](UBUNTU_PUBLIC_DEMO.md)，不要混用配置。

演示模式用于展示“Agent 操作 → 人工虚构登录 → 交还 → Agent 继续”，真实使用请部署团队模式。当前已通过本机两个浏览器访客、两个独立容器的端到端测试，尚未发布公网站点。

在独立部署目录中构建同一运行镜像，配置：

```dotenv
BROWSER_AUTH_MODE=demo
BROWSER_MODE=docker
BROWSER_RUNTIME_IMAGE=agentic-browser:zkpass-prototype
BROWSER_DATA_DIR=.data
HOST=127.0.0.1
PORT=3334
PUBLIC_URL=http://127.0.0.1:3334
MAX_SESSIONS=2
```

然后 `npm run doctor`、`npm start`。公网入口仍需 HTTPS、WebSocket 和入口限流，见 [自部署指南](SELF_HOST.md)。本轮没有修改当前服务的 `.env` 或公开任何入口。

每位访客获得独立临时身份及 HttpOnly Cookie，创建自己的 Docker 容器。身份有效 10 分钟，Session 初始 5 分钟，可续期但不能超过 10 分钟，每访客最多一个。实例并发由 `MAX_SESSIONS` 限制；匿名新身份按服务器观察到的来源 IP 限速，并有总量上限。清除 Cookie 不会扩大实例总并发，但不是反滥用系统的替代品。

演示强制 `network=none`，即使配置写了 public 也不允许出网；只展示容器内固定端口的虚构站点，不开放真实 Google、GitHub 或 zkPass 网络证明。地址栏仍属于原生 Chrome，外部站点加载会失败。浏览器中的扩展来自同一镜像，安装不依赖网络。

访客不能创建成员凭据、保存/复用 Profile、传入任意会话起始 URL 或读取其他访客会话。演示数据使用 `BROWSER_DATA_DIR/public-demo` 子目录，与团队成员数据库和保存配置分开。人工镜像继续校验访客 Cookie、一次性票据和单窗口输入权限。

首页“开始体验”启动浏览器，访问者使用虚构用户名和密码登录后点击“完成，交还给 Agent”。服务中的固定演示步骤只检查自己的演示页并点击继续，然后把结果页面交还访客。它不是内置模型执行器，也不会执行用户提交的自由任务。

“结束会话”等待容器和资源记录回收完成后显示成功。关闭网页不立即结束会话，访客可在期限内重新进入；到期由后台清理。服务异常重启会清点残留，不恢复旧会话；不保留演示登录数据。

自动验收：`npm test` 的 demo 配置/权限/期限测试，以及 `npm run test:demo` 的真实 Chrome/noVNC 双访客流程。网络隔离与异常回收另外由 `npm run test:runtime` 覆盖。
