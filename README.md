# Agentic Browser

一个可在本地运行的浏览器协作工具：Agent 操作网页，需要人工登录或确认时暂停，由用户接管，完成后交还同一个会话。

提供 HTTP API、团队 stdio MCP、公共演示远程 HTTP MCP 和中文接管页面。不依赖支付、x402、Kubernetes、Redis、多区域调度或云端证明；团队身份使用本地 SQLite。

## 项目计划与进度

- [总体计划](docs/PLAN.md)：产品目标、架构、阶段路线、验收条件和待讨论的决定。
- [进度记录](docs/PROGRESS.md)：已完成能力、测试与真实使用验收、当前限制和下一批工作。
- [会话与镜像管理设计](docs/SESSION_AND_MIRROR_DESIGN.md)：自部署团队的成员权限、会话回收、登录配置隔离和镜像授权设计草案。
- [固定扩展与运行镜像设计](docs/EXTENSIONS_AND_IMAGES_DESIGN.md)：zkPass TransGate、Schema Validator 的安装策略、环境版本与隔离方案；镜像和基础验收已完成。

产品方向是个人或团队自行部署使用，公共部署只演示功能。当前保留可信单用户模式，并新增团队成员身份、独立 Docker Runtime 和一次性人工镜像授权。每批完成后同步更新进度记录。

## 自部署与演示

真实使用从 [自部署指南](docs/SELF_HOST.md) 开始，使用成员身份和每 Session 独立 Docker Runtime。面向外部 Agent 的演示使用 [Ubuntu 公共 MCP 部署指南](docs/UBUNTU_PUBLIC_DEMO.md)：URL 即可连接，允许公网网页，独立临时容器，并发和时长有限额。另保留只运行虚构登录和固定步骤的 [断网访客演示](docs/PUBLIC_DEMO.md)。

Apple Silicon Mac 使用容器化控制器与浏览器，启动命令见 [Mac 部署指南](docs/MAC_DEPLOYMENT.md)。用户已反馈 Mac 本地部署测试通过；此前 Seccomp-BPF 检查失败的历史记录仍保留在 [进度文档](docs/PROGRESS.md)，本轮未重新验收 Mac 沙箱。

## 可信单用户快速体验

需要 Node.js 24+。在项目目录执行：

```bash
npm ci
npm run browser:install
npm run setup
npm start
```

打开 <http://127.0.0.1:3333>，将 `.env` 中的 `AGENT_BROWSER_TOKEN` 填入页面。点击「创建会话」，再打开接管页面。默认起始页是本地登录演示，只使用虚构账号。

`setup` 会生成随机令牌，不覆盖已有 `.env`。Linux 如果缺少浏览器系统依赖，执行 `npx playwright install --with-deps chromium`。

### Ubuntu 远程桌面模式

继续通过网页镜像操作服务器上的浏览器，无需 Mac 本地浏览器扩展。Ubuntu/Debian x86_64 上执行：

```bash
npm run desktop:install
```

安装器安装 Xvfb、xauth、x11vnc、Openbox 和 Google 官方稳定版 Chrome。在 `.env` 添加 `BROWSER_MODE=desktop` 后运行 `npm start`。服务器自行创建虚拟显示器，不需要外层 `xvfb-run`。每个会话拥有独立 Chrome 进程和 X11 显示器。默认使用临时用户目录，也可主动选择保存的登录配置。

人工接管时断开本服务的 Playwright/CDP 连接，由 noVNC 镜像完整远程桌面，鼠标键盘通过 VNC/X11 输入。交还时先撤销镜像连接并停止 VNC 服务，再连接到原来的 Chrome；页面与登录状态保留。前端不会在人工阶段请求 DOM、页面截图或标签页列表。控制权交接失败会关闭会话。

镜像 WebSocket 与 API 共用 `3333` 端口，SSH/Cursor 只需要转发这一端口。VNC 和 CDP 的内部端口仅监听回环地址，不需要对外开放。镜像通过首个 WebSocket 消息校验人工令牌与控制权版本，校验完成前不返回桌面数据；连接会在交还、关闭或到期时撤销。

这改变了浏览器启动和人工输入方式，并不保证 Google、X 等第三方在所有环境下接受登录。自动测试使用本地虚构账号；2026-10-13（北京时间）已完成一次真实 Google 登录验收：用户在远程桌面登录，交还后 Agent 在同一会话进入 Gmail，成功读取垃圾邮件文件夹状态。该结果证明本次协作流程可用，不代表其他网站或账号已验证。不会伪造浏览器指纹、修改 `navigator.webdriver` 或绕过验证码。

## 人工接管

1. Agent 创建会话，保存 `id` 和 `humanUrl`，通过操作接口执行任务。
2. 需要人工操作时，Agent 调用 `browser_handoff`，把 `humanUrl` 发给用户。用户也可以在接管页主动接手。
3. 服务端立即停止接收新的 Agent 操作，拒绝队列中的旧操作，等待已经开始的操作结束，再开放人工输入。
4. 用户点击远程画面，使用键盘或侧栏输入框完成登录、验证码等步骤。
5. 用户点击「完成，交还给 Agent」。Agent 查询状态，通过 `browser_wait` 等待 `control` 为 `agent`，继续原任务。

人工控制期间，Agent 的点击、输入、页面快照和截图均返回 `409`。Agent 接口没有强制交还操作。会话的 Cookie 和页面状态在交接中保留。默认临时会话结束后清理；主动选择保存的配置可供后续会话复用。

## 保存登录状态、恢复连接与续期

- **默认临时**：新建会话时默认不保存登录状态。已有临时会话不会自动转为保存配置。
- **主动保存**：远程桌面模式下，在首页「登录状态」选择「新建配置 · 保存登录状态」，命名后创建会话并登录。以后选择该配置新建会话，Chrome 会复用服务器上的用户目录。配置包含该浏览器中所有网站的登录数据；网站自身的过期或风控仍可能要求重新登录。
- **结束与删除**：结束会话会关闭浏览器；保存的配置保留，直到在首页单独删除。使用中的配置不能同时打开或删除，跨服务进程也受文件锁保护。关闭浏览器时先请求 Chrome 正常退出，使登录数据落盘。
- **断线恢复**：网络中断时暂停输入，自动重连后重新确认控制权；未确认的输入不会自动重发。刷新接管页可继续原会话，也可在首页输入服务令牌，通过「打开 / 恢复接管」重新取得链接。端口转发断开需恢复 Cursor/SSH 转发。
- **到期提醒**：接管页显示倒计时，剩余两分钟提醒。双方均可手动续期，将到期时间设为从现在起一个配置周期；反复点击不会累积多个周期。人工接管与断线期间仍计时，到期后无法续期复活。
- **服务重启**：正常重启会结束旧会话和旧链接；保存的配置仍在首页，可用于新会话。不会自动恢复原标签页、控制权或未完成任务。异常退出后若旧 Chrome 仍运行，配置会拒绝复用或删除，需先正常结束残留浏览器。

数据默认在 `.data/profiles/`，目录权限 `0700`、配置元数据 `0600`，已加入 `.gitignore`。配置文件记录名称、ID、创建时间与可选成员归属；网站登录数据由 Chrome 自身保存。自定义 `BROWSER_DATA_DIR` 时也应保持目录私有并排除版本控制。持有服务令牌的可信用户/Agent 可以复用这些配置。

## 连接 MCP

先启动 HTTP 服务，再在支持 stdio MCP 的客户端中添加配置，替换成实际项目路径。`npm --prefix` 会让适配器从项目目录加载 `.env`。

```json
{
  "mcpServers": {
    "agentic-browser": {
      "command": "npm",
      "args": [
        "--prefix",
        "/absolute/path/agentic-browser",
        "run",
        "--silent",
        "mcp"
      ]
    }
  }
}
```

团队客户端应显式配置个人凭据，见 [Agent 接入指南](docs/AGENT_CLIENT.md)。上面的简例从本地 `.env` 读取 legacy 共享令牌。

工具：`browser_create`、`browser_sessions`、`browser_status`、`browser_action`、`browser_screenshot`、`browser_handoff`、`browser_close`、`browser_profiles`、`browser_extend`、`browser_human_link`、`browser_wait`。

`browser_create` 可传 `profileId` 复用用户主动保存的配置，省略则创建临时会话。创建和删除保存配置通过首页或 HTTP API 完成。

`browser_action` 参数示例：

```json
{"sessionId":"<id>","action":{"type":"navigate","url":"https://example.com"}}
{"sessionId":"<id>","action":{"type":"snapshot"}}
{"sessionId":"<id>","action":{"type":"click","selector":"text=Sign in"}}
```

`snapshot` 返回页面文字和控件属性，不返回表单输入值。`click`、`fill` 支持 Playwright selector。`pointer` 使用当前网页视口坐标；原模式为 1280×800，桌面模式随原生窗口变化，Agent 可参考页面截图。桌面镜像包含浏览器工具栏，不能直接把镜像坐标当网页坐标。弹出的新标签页自动成为当前页，也可通过 `tabs` / `selectTab` 切换。

## HTTP API

Agent 路径使用 `Authorization: Bearer <凭据>`；团队模式填写个人 Agent 凭据，legacy 模式填写 `AGENT_BROWSER_TOKEN`。POST 请求使用 `Content-Type: application/json`。

| 方法与路径                       | 用途                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/sessions`             | 创建；请求 `{ "purpose": "任务", "url": "https://example.com" }`，URL 可省略；可选 `profileId` 复用保存配置 |
| `GET /api/sessions`              | 列出会话与控制状态                                                           |
| `GET /api/sessions/:id`          | 查询状态                                                                     |
| `POST /api/sessions/:id/actions` | 发送操作                                                                     |
| `GET /api/sessions/:id/screen`   | 当前视口 JPEG，密码输入框遮罩                                                |
| `POST /api/sessions/:id/handoff` | 交给用户；请求 `{ "reason": "请完成登录" }`                                  |
| `POST /api/sessions/:id/wait` | 可取消的控制状态等待；上限 25 秒，仅返回元数据 |
| `POST /api/sessions/:id/extend` | 续期；请求 `{}`，不改变控制权 |
| `POST /api/sessions/:id/human-link` | 恢复接管链接；请求 `{}`，使用当前访问地址 |
| `GET /api/profiles` | 查看保存配置及当前模式是否支持保存 |
| `POST /api/profiles` | 主动创建保存配置；请求 `{ "name": "工作账号" }` |
| `DELETE /api/profiles/:id` | 删除未使用的配置及其全部本地浏览器数据 |
| `DELETE /api/sessions/:id`       | 销毁会话                                                                     |

`actions` 支持 `navigate`、`snapshot`、`click`、`pointer`、`fill`、`type`、`press`、`scroll`、`back`、`forward`、`reload`、`tabs`、`selectTab`。精确字段见 [src/contracts.ts](src/contracts.ts)。

团队模式人工页面使用个人 Cookie，Agent 无法取得人工身份；镜像须再取得 15 秒一次性票据，见 [成员说明](docs/TEAM_SETUP.md)。配置创建和删除仅允许成员本人。

legacy 模式人工页面使用独立的 `/api/human/:id` 路径和会话专属令牌，支持 `takeover`、`resume`、`extend`、`actions`、`screen` 及 DELETE。接管链接将令牌放在 URL fragment，页面读取后从地址栏移除，保存在当前标签页的 `sessionStorage`。

会话状态包含 `transport: "page" | "desktop"`、`profile`（临时为 `null`）、`serverTime`、`ttlSeconds` 与 `expiresAt`；倒计时参考服务器时间。桌面模式在人工阶段使用 `WS /api/human/:id/desktop`，原人工 `actions`、`screen` 返回 `409`，不重新接入自动化。WebSocket 需同源 Origin；legacy 首帧为 JSON `{token, revision}`，团队首帧为 `/desktop-grant` 返回的票据，收到文本 `ready` 后开始标准二进制 RFB 流。Agent 路径不支持桌面连接。

## 配置

| 环境变量                   | 默认值 / 说明                                               |
| -------------------------- | ----------------------------------------------------------- |
| `AGENT_BROWSER_TOKEN`      | legacy 必填，至少 32 字符；团队/演示模式忽略                 |
| `BROWSER_AUTH_MODE` | `legacy`；自部署设 `team`，受限演示设 `demo` |
| `BROWSER_RUNTIME_IMAGE` | `agentic-browser:zkpass-prototype`，管理员选择本地镜像 |
| `BROWSER_NETWORK` | `public` 或 `none`；demo 强制 none |
| `BROWSER_EGRESS_DENY_HOSTS` | 补充禁止访问的管理域名/IP，逗号分隔 |
| `MAX_SESSIONS_PER_MEMBER` | `2`，包含正在创建；demo 强制 1 |
| `SESSION_MAX_LIFETIME_SECONDS` | `14400`，续期不能越过绝对寿命 |
| `AGENT_BROWSER_VIEW_URL` | MCP 返回的接管链接 origin，可用于本地转发 |
| `HOST`                     | `127.0.0.1`                                                 |
| `PORT`                     | `3333`                                                      |
| `PUBLIC_URL`               | `http://127.0.0.1:3333`，应与实际访问 origin 一致，不带路径 |
| `SESSION_TTL_SECONDS`      | `1800`（60–14400 秒），创建/续期周期，接管仍计时                  |
| `MAX_SESSIONS`             | `4`，包括正在启动的会话                                     |
| `BROWSER_MODE`             | `playwright`；可信单用户可选 `desktop`；team/demo 强制 `docker`              |
| `BROWSER_DATA_DIR`         | `.data`，身份、Profile 和 Runtime 私有记录；demo 使用其 public-demo 子目录 |
| `DESKTOP_CHROME_PATH`      | `/usr/bin/google-chrome-stable`，仅桌面模式使用             |
| `HEADLESS`                 | `true`；有桌面环境时可设为 `false`                          |
| `CHROMIUM_EXECUTABLE_PATH` | 可选，自定义 Chromium 路径                                  |
| `AGENT_BROWSER_URL`        | MCP 适配器连接地址；默认使用 `PUBLIC_URL`                   |

修改服务端端口时同步修改 `PUBLIC_URL`。服务校验 Host / Origin；当 `PUBLIC_URL` 为本地回环地址时，也接受 `localhost`、`127.0.0.1` 和 `[::1]` 的其他本地端口，以支持 SSH / IDE 转发。浏览器 Origin 仍必须与请求 Host 一致。

### 远程 Ubuntu + Mac / Cursor

在 Cursor 的 Ports 面板转发远程端口 `3333`，然后使用面板显示的本地地址打开页面。如果本地端口被分配为 `50350`，接管地址的开头改为 `http://127.0.0.1:50350`，保留 `/view#...` 部分。通过转发后的工作台创建会话时，返回的链接会自动使用该本地地址。

如果使用会自动转发远程地址的应用内浏览器，应向应用传入服务器原始地址 `http://127.0.0.1:3333/view#...`。不要再次提交已经映射的本地端口，否则可能形成重复转发。先用同一地址的 `/health` 检查连接。

也可以在 Mac 终端通过现有 SSH 连接配置运行 `ssh -N -L 127.0.0.1:3333:127.0.0.1:3333 <你的服务器SSH别名>`。远程服务继续监听回环地址，无需开放公网端口。

## legacy 模式边界

- 面向可信用户和可信 Agent。浏览器可以访问本机网络。原模式共享 Chromium 进程但隔离 BrowserContext；桌面模式隔离浏览器进程、显示器和临时目录，仍以同一 Ubuntu 用户运行，没有容器或操作系统级隔离，人工桌面可以访问该用户的本机文件。
- 控制权交接是合作式的。创建者拿得到人工链接，不能把它当成对恶意 Agent 的独立身份验证；服务令牌拥有全部会话的管理权限。
- 服务不记录输入正文、录像或导出 Cookie，不对外暴露 CDP。桌面模式的临时 Chrome 用户目录会在会话期间落盘，正常关闭时删除；异常断电可能在系统临时目录留下文件。密码字段的 Agent 截图会遮罩，但网页其他位置仍可能显示敏感内容。交还后 Agent 可以读取登录后的网页。
- 原模式为 1280×800 截图镜像。桌面模式为 1280×900 的完整窗口，可操作地址栏、标签页和原生弹窗；没有 Mac 本机文件传输或本机通行密钥桥接。人工阶段不自动关闭网页弹窗，Agent 阶段保持原有自动关闭行为。临时目录不会用于跨会话复用登录。
- 文字快照主要覆盖顶层页面；跨域 iframe 内的控件可通过截图和坐标操作。
- 接管凭据仅保存在当前标签页的会话存储中。关闭页面后，可以通过服务令牌和首页恢复仍存活会话的链接；旧会话到期或服务重启后需新建会话。

## 开发与验证

```bash
npm run dev
npm run check
npm test
npm run test:browser
npm run test:desktop # Linux，先安装桌面依赖和 Playwright Chromium
npm run verify # 全套验收；需 Compose 及已构建的浏览器、控制器镜像
npm run package:preview # 本地源码归档，排除私有数据
```

单元和 HTTP 测试覆盖控制权竞争、队列失效、授权、到期与关闭；浏览器集成测试启动真实 Chromium，验证人工登录、交还、继续操作及会话存储隔离。

桌面集成测试经过真实 noVNC 和原生键盘输入，验证本地演示登录、断开/重连后保留状态、旧镜像连接撤销、错误凭据/过期版本/跨来源被拒绝，以及独立 Chrome 用户目录的会话隔离。额外验证网络中断、接管页刷新、到期提醒和续期；持久化测试使用虚构 Cookie，完整重启服务进程后验证登录保留、临时会话隔离和配置删除。

| 模块                     | 职责                              |
| ------------------------ | --------------------------------- |
| `src/sessions.ts`        | 生命周期、控制权切换与操作队列    |
| `src/browser.ts`         | Chromium 和浏览器动作             |
| `src/profiles.ts`        | 保存配置元数据、私有目录与跨进程互斥 |
| `src/desktop.ts`         | 原生 Chrome、Xvfb、VNC 与连接切换 |
| `src/desktop-gateway.ts` | 同源认证与 WebSocket/VNC 转发     |
| `src/http.ts`            | HTTP、鉴权和静态页面              |
| `src/mcp.ts`             | MCP stdio 适配                    |
| `web/`                   | 工作台、接管页面、登录演示        |

参考 Popcorn 的浏览器会话与人工交互思路，按本地使用场景重新实现。来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

### 预装扩展与团队身份原型

已加入 [预装 zkPass 扩展镜像](runtime/README.md) 及 [成员身份与个人 Agent 凭据](docs/TEAM_SETUP.md)。镜像断网安装、Schema Validator 合成接口捕获、双成员权限和原生远程桌面交还均有自动验收；独立 Runtime、网络边界和异常回收也已通过基础自动验收。安装见 [Runtime 指南](docs/RUNTIME.md)，外部 Agent 接入见 [客户端指南](docs/AGENT_CLIENT.md)；正式发行与真实业务验收另行记录。
