# 外部 Agent 接入

公共演示现在提供 URL 形式的 Streamable HTTP `/mcp`，无需本地运行适配器，见 [Ubuntu 部署与客户端配置](UBUNTU_PUBLIC_DEMO.md)。公共模式有 9 个工具，每次 `browser_create` 返回独立 `sessionId`、`sessionKey`，后续工具都须传入二者；不提供会话/Profile 列表。接管链接是一次性临时授权，Agent 只应展示给用户。

公共模式的 `browser_handoff` / `browser_human_link` 同时返回 `humanUrl`、`userMessage`、结构化结果和独立文本消息。Agent 应先把 `userMessage` 发给当前用户，包含真实可点击链接及完整 URL（保留 `#` 片段），再调用 `browser_wait`。不能只说“点击 Connect”或用首页代替会话链接；链接遗漏、已用或过期时重新签发，`sessionKey` 始终只用于工具调用。

下文说明**团队自部署**的 HTTP API 和 11 个 stdio MCP 工具。成员先登录工作台，创建个人 Agent 凭据；需要复用登录状态时，明确勾选允许使用的 Profile。Agent 默认只创建临时会话，不能创建/删除 Profile、读取人工 Cookie 或取得镜像票据。

MCP 启动示例（路径按实际安装位置修改）：

```json
{
  "mcpServers": {
    "agentic-browser": {
      "command": "node",
      "args": ["--import", "tsx", "/absolute/path/agentic-browser/src/mcp.ts"],
      "cwd": "/absolute/path/agentic-browser",
      "env": {
        "AGENT_BROWSER_URL": "http://127.0.0.1:3333",
        "AGENT_BROWSER_TOKEN": "替换为工作台一次显示的个人Agent凭据",
        "AGENT_BROWSER_VIEW_URL": "http://localhost:50350"
      }
    }
  }
}
```

示例采用通用 MCP JSON 结构；具体客户端的配置入口和 `cwd` 支持可能不同。当前已使用官方 MCP TypeScript SDK 的真实 stdio 客户端验收完整链路，尚未对每个桌面客户端逐个人工配置验收。

`AGENT_BROWSER_URL` 是 MCP 进程实际能访问的服务地址。`AGENT_BROWSER_VIEW_URL` 可选，仅将交给人的接管链接改成 Mac 上已经转发成功的入口，不负责创建 SSH 隧道。若 MCP 在 Ubuntu、用户在 Mac，这两个地址可能不同；本地端口变更后需要更新后者。地址只能是 HTTP(S) origin，不接受内嵌用户名密码或路径。

## 推荐任务流程

1. `browser_create` 创建一次连续任务的 Session，可省略 `profileId`，或使用已授权配置。内置隔离演示地址是 `https://agentic-browser.invalid/demo`。
2. 用 `browser_action` 的 `navigate`、`snapshot`、`click`、`fill` 等执行网页任务。状态确认不使用重复提交表单的方法。
3. 遇到登录或人工确认，调用 `browser_handoff` 并向用户展示 `humanUrl`。团队链接不含人工秘密，需要对应成员登录工作台后才能打开。
4. `browser_wait` 等待 `control=agent`，可传入交接结果的 `revision` 作为 `afterRevision`。每次最多等待 25 秒。
5. 结果为 `ready` 后继续；`timed_out` 表示本次等待结束，浏览器及控制权保持原状，可以再次等待或向用户说明仍待人工操作。
6. 完成任务调用 `browser_close`。临时环境回收；主动保存的 Profile 保留到成员删除。

取消 MCP `browser_wait` 请求会通过 SDK 的标准取消信号中止 HTTP 等待，不会模拟人工交还或关闭浏览器。明确关闭请用 `browser_close`。网页操作遇到超时不能盲目重放，先用状态及页面快照确认已经发生的变化。

同一成员的多个 Agent 也互相隔离会话；工作台“绑定并接管”可把自己的会话明确交给某个个人凭据。重新绑定先进入人工控制并隔离旧的排队操作，需由本人再交还。

## HTTP 等待接口

```http
POST /api/sessions/<session-id>/wait
Authorization: Bearer <个人Agent凭据>
Content-Type: application/json

{"control":"agent","afterRevision":1,"timeoutMs":20000}
```

成功返回 `{ "status": "ready" | "timed_out", "session": ... }`。每个凭据最多同时两个等待，全实例最多 64 个。断开 HTTP 请求会释放等待；等待期间仍反复检查凭据和会话绑定，撤销、停用或更换绑定会使旧等待结束。等待不会延长 Session 寿命。

| 结果 | 含义与处理 |
| --- | --- |
| 401 `unauthorized` | 凭据失效、过期或成员停用；重新配置，不能改用人工凭据。 |
| 404 `session_not_found` | 不存在或未授权给当前凭据；不暴露其他成员信息。 |
| 409 `control_unavailable` | 人工或其他交接阶段，停止浏览器操作。 |
| 410 `session_ended` | 会话已结束；需要时创建新 Session，不复活旧链接。 |
| 429 `session_limit` / `wait_limit` | 达到配额；结束闲置会话或取消多余等待。 |
| 503 `runtime_stopped` | 隔离运行环境已停止；保存配置需在回收确认后重新打开。 |
| 504 `operation_timeout` / `runtime_timeout` | 操作未及时完成；确认会话和网页状态，不自动重试提交。 |

MCP 错误内容保留上述 `error`、`status`、`message`，便于客户端区分认证、人工等待和浏览器故障。其他工具包括会话列表、状态、截图、Profile 列表、续期和接管入口恢复，共 11 项。

## 自动验收

`npm test` 验证实际 stdio MCP 协议、等待/超时/取消、转发地址以及权限。完整链路使用：

```sh
AGENTIC_TEST_DOCKER=1 AGENTIC_TEST_MCP=1 npx tsx --test test/team-desktop.integration.ts
```

该验收包括个人凭据 → MCP → HTTP → 独立容器 Chrome → 成员 Cookie/noVNC → 原生虚构登录 → 交还 → `browser_wait` 唤醒 → Agent 读取结果。真实账号登录和 zkPass 证明另行记录，不混作此自动化的验收结果。
