# Agentic Browser 进度记录

更新日期：2026-10-14，北京时间。当前为自部署预览版，Ubuntu 公共 MCP 已通过 Cloudflare 域名 HTTPS 入口验证；用户已明确将 Cloudflare 到源站的 TLS 配置暂缓，不作为当前功能体验的阻塞项。公共演示见 [Ubuntu 部署指南](UBUNTU_PUBLIC_DEMO.md)，真实使用见 [自部署指南](SELF_HOST.md)，总体路线见 [计划](PLAN.md)。

## 最新追加：GHCR 双架构公开发行已验收

2026-10-14，用户确认 Codex 和 Claude 命令行体验均通过，选择 `ghcr.io/infrasika/agentic-browser-*` 发布公共镜像，并要求覆盖 x86、M 系列 Mac 与 ARM 服务器。发行改由 GitHub Actions 使用 `GITHUB_TOKEN`，无需服务器保存个人镜像仓库令牌。源代码仓库保持现有可见性。

已准备原生 `ubuntu-24.04` / `ubuntu-24.04-arm` 构建矩阵、双架构验收后合并版本索引、拒绝覆盖已有版本、包含 digest 固定配置的部署包与校验清单。新增平台自动选择；下载并校验官方 amd64/arm64 Chrome `155.0.8059.79-1`，保留两个扩展的锁定版本。发行镜像携带来源和第三方说明。部署包仅包含允许清单中的配置/文档，不含本机 `.env`、登录数据或令牌。

本机 amd64 候选镜像验收通过：类型检查、51 项单元/API 测试、两个扩展实际运行与 Chrome 沙箱检查、团队 Compose 隔离和恢复、五浏览器公共配额与人工接管。证据在 `output/runtime/release-{build,extensions,controller,public}-amd64.log` 和 `release-unit.log`。线上公共服务尚未切换到候选镜像。

首次 [Actions 运行](https://github.com/infrasika/agentic-browser/actions/runs/38508385940) 中，两个原生架构均完成镜像构建，但扩展截图因 runner UID 与容器 UID 不同而写入失败，发布被正确阻止。测试脚本改用专属临时截图目录，退出时复制证据并清理，不修改源码或实际 Profile 权限；随后重跑完整双架构验收。维护者流程见 [发布指南](RELEASING.md)。

修复后的 [Actions 运行](https://github.com/infrasika/agentic-browser/actions/runs/38508756846) 全部通过，已发布 [v0.1.0-preview.1](https://github.com/infrasika/agentic-browser/releases/tag/v0.1.0-preview.1)，来源提交 `737c2f1793c66733faf9f39fc6053022e2e9ca4e`。两个架构各通过 51 项单元/API、2 项扩展实际测试、团队 Compose 和公共五浏览器验收，Chrome Namespace / Seccomp-BPF / TSYNC 均启用。日志保存在 `output/runtime/actions-{amd64,arm64}-verified.log`。

镜像索引摘要已写入 `deploy/release.env`：controller 为 `sha256:deb472408efa8511e8628fed50225da225859e8d83c3c91a0f7a5ed8b1f9a170`，runtime 为 `sha256:856e292cb46ea2aac54db39148cda9611aeb970d74db980f3d3b791215f37d54`。实际 Release 的部署包、清单和校验和已下载并校验成功；源码仓库仍为 private。

已通过临时 registry 凭据拉取两个 amd64 索引引用，随后立即删除临时 Docker 登录配置。从实际部署包的独立解压目录、使用发布 digest 再跑团队 Compose 验收，通过成员隔离、原生接管、保存配置、重启与崩溃恢复（约 39 秒）。测试项目/卷已清理；证据为 `output/releases/v0.1.0-preview.1/clean-install-controller.log`。本机没有构建或替换这些已发布镜像，线上公共控制器继续运行原版本。

2026-10-14，用户完成两个 GHCR 包的 Public 切换后，公开发行验收通过：无账号 HTTP 客户端取得两个镜像索引，原始内容的 SHA256 与发行 digest 一致，均包含 `linux/amd64` 和 `linux/arm64`。随后使用空 Docker 凭据目录完成 controller/runtime × amd64/arm64 四种组合的匿名拉取，全部成功。

再从新的临时目录解压实际 Release 部署包，先校验原附件 SHA256，再通过包内 `release-compose.sh pull` 匿名拉取本机镜像，并完成团队 Compose 流程复验（约 40 秒）：成员隔离、原生接管、保存配置、重启和崩溃恢复均通过；独立测试项目、卷和目录已清理。此轮为同一 Ubuntu 主机上的干净目录安装，不标记为另一台全新主机验收。

公开验收记录见 [固定版本记录](../deploy/releases/v0.1.0-preview.1-public-verification.json)，同时追加到 Release 的 `PUBLIC-VERIFICATION.json` 附件。证据日志在 `output/releases/v0.1.0-preview.1/pull-anonymous-*.log`、`install-anonymous-pull.log`、`public-clean-install-controller.log`。原 `RELEASE.json` 的 `publicPullVerified: false` 保留发布时事实；后续成功结果由新附件记录，不覆盖原部署包、清单或校验和。当前镜像无需 GHCR 登录即可拉取；私有源码仓库及其 Release 附件仍需仓库权限或管理员分发。

新原生 ARM 镜像的 Mac Docker Desktop 验收仍需单独记录。可复现保证是拉取同一镜像 digest；apt 源和上游历史文件可用性尚不保证逐字节源码重建。

## 前一批：5 个并发浏览器、容量展示与满额提示

2026-10-14，按用户要求推进公共 Demo 的容量与异常回收验收。现有全站上限继续通过 `.env.public` 的 `AB_MAX_SESSIONS` 配置（1–32）；当前服务器已改为 5，同来源 IP 上限保留为 2。确认没有访客浏览器后重建公共控制器，线上健康检查通过，HTTPS `/api/public/capacity` 返回上限 5。其他服务、访客隔离和临时期限不变。

新增仅公开汇总数量的容量接口，主页每 10 秒展示当前会话数/上限和剩余名额；满额时明确提示稍后再试，接口失败时清除旧数字并显示自动重试状态。公共 MCP 的全站/来源满额错误保留原 JSON 格式，同时增加结构化容量、建议 30 秒重试间隔和可直接展示的 `userMessage`/文本，要求 Agent 告知用户而非自动循环重试。全站满额提示优先于来源满额提示；汇总不公开会话 ID、网址、身份或凭据。

容量包含启动预留、运行和待清理资源。复核发现“Chrome 启动失败且容器清理失败”的旧路径会提前释放名额，本批修复：保留启动失败的工作区以重试回收，同时保留全站、成员和来源 IP 配额；清理成功才允许复用名额。到期、关闭以及未交付创建的回收也覆盖在验收中。

验收结果：

- `npm run check`、前端语法和差异空白检查通过；49 项单元/API 测试通过，覆盖五路同时启动拒绝第六路、计数只含汇总、全站/来源提示、关闭释放、到期清理失败、启动失败清理重试，以及原有权限/取消/等待回归。
- 最终控制器镜像的独立 Compose 验收通过（约 83 秒）：五个真实 Chrome 与各自代理同时存在，第六次创建被拒绝；关闭一个后可新建。实际浏览器验证主页满额、自动更新、容量接口 503 后提示和恢复，并回归镜像刷新重连、虚构登录、交还、Agent 继续、隔离与退出清理。
- 独立测试项目、容器和卷已清理；线上在零访客会话时更新，确认全站 5、来源 2，并从公共域名验证健康和容量接口。未登录真实账号。

公共域名下的独立 Chrome 复验主页显示 `0 / 5`，配置复制入口正常，390px 手机宽度无横向溢出。截图：`output/playwright/capacity-public-desktop.png`、`capacity-public-mobile.png`。其余证据：`output/runtime/capacity-unit.log`、`capacity-compose.log`、`capacity-build.log`。部署配置和 Agent 错误处理约定已同步到 [Ubuntu 指南](UBUNTU_PUBLIC_DEMO.md) 与 [客户端说明](AGENT_CLIENT.md)。

当前 5 是管理员配置的接入上限，已验证五浏览器功能流程，并非对任意网页负载的性能保证。下一步补充启动耗时/失败与清理统计、较长时间负载观察，以及 Codex/Cursor 实际客户端体验；未将整个运行稳定性里程碑标记为完成。

## 前一批：用户确认 Claude CLI 公共体验测试成功

2026-10-14，用户明确反馈“claude cli 中测试成功了”。结合本次 GitHub 人机协作体验上下文，将 Claude CLI 接入公共 MCP 的实际客户端验收记为通过；此前接管链接未展示、领取页丢失票据的问题，已在修复后得到用户复测确认。证据来源为用户实测反馈，服务端与浏览器自动验收结果见下方记录。

下一步按计划推进小范围体验、配额与到期提示反馈，并补充 Codex/Cursor 的实际客户端验收；不因单个客户端成功而将其他客户端或并发容量标记为已验收。本次仅更新文档，未重启服务。

## 前一批：修复领取前刷新导致接管票据丢失

用户反馈 Claude 已显示完整链接，但打开后变为 `/connect` 并提示缺少链接。通过公共域名复现：旧 `connect.js` 在页面加载时立即执行 `history.replaceState` 清空片段，首次打开仍可从内存领取，但领取前刷新就稳定丢失票据。未确认用户首次加载的具体重载触发点；同时发现 Cloudflare Rocket Loader 正在改写入口模块标签。

接管页现保留 URL 片段直到领取成功，再替换为镜像地址；票据不复制到浏览器存储。同一标签页的 `hashchange` 会重新解析新链接，支持从缺失/过期页面恢复；网络失败后可重试，服务端判定已用/过期时引导重新签发。初始按钮在脚本就绪前禁用。接管页与镜像页按 Cloudflare 官方方式添加 `data-cfasync="false"`，排除 Rocket Loader 改写，线上已确认原生模块标签保留。创建工具说明也明确：先调用交接工具，再展示其最新链接，不能继续使用已被交接替换的初始链接。

验收：语法与类型检查通过，44 项单元/API 测试通过。扩展的真实 Compose 回归覆盖缺失链接、旧链接 410、新片段恢复、领取前刷新、临时网络故障重试、领取后去除票据，以及原有虚构登录/交还/Agent 继续/隔离与回收。正式实例无活跃访客浏览器后部署；独立 Chrome 经公共 HTTPS 域名实际点击验证刷新后领取、noVNC 连接正常、人工交还和 Agent 读取虚构站点，测试会话已关闭。没有使用截图中的票据或访问用户的 GitHub 会话。

证据：`output/runtime/connect-refresh-unit.log`、`connect-refresh-compose.log`、`connect-refresh-build.log`；线上截图 `output/playwright/connect-public-ready.png`、`connect-public-mirror.png`。Ubuntu 指南已更新领取前刷新与 Cloudflare 脚本优化说明。

## 前一批：修复公共 MCP 接管链接展示

用户在 Claude CLI 中完成创建与交接工具调用后，仅看到“点击 Connect”，没有实际链接。服务端原先只在 JSON 中提供 `humanUrl`；Copy prompt 中“请勿分享接管链接”的措辞也可能被理解为不能向当前用户展示。现将交接约定明确为：调用 `browser_handoff` 后先向当前用户发送实际链接，再调用 `browser_wait`。

`browser_handoff` 和 `browser_human_link` 新增包含可点击链接、完整原始 URL 及真实按钮文案的 `userMessage`，同时提供 `structuredContent` 和独立文本消息；保留首个 JSON 文本块，兼容已有客户端。MCP 初始化说明、交接/重新签发/等待工具说明、主页任务、Copy prompt 及客户端文档同步更新。链接仅发给当前用户并完整保留 `#` 片段，`sessionKey` 不进入用户消息；重新签发仍使旧未领取链接失效，鉴权与一次性领取逻辑不变。

验收：类型检查通过；44 项单元/API 测试通过，新增回归覆盖 JSON/结构化/文本结果一致、可点击与可复制 URL、密钥不泄漏、旧链接失效、实际领取及无权限不返回链接。独立 Compose 全流程通过，使用返回消息中的链接进入真实镜像，再完成虚构登录、交还和 Agent 继续。正式实例无活跃访客浏览器后更新；公共 HTTPS MCP 实测返回消息中的链接可以领取测试会话，交还后能读取虚构站点，最后已关闭测试会话。线上主页提示词已更新，健康检查正常。证据：`output/runtime/handoff-link-unit.log`、`handoff-link-compose.log`、`handoff-link-build.log`。

本轮验证了服务端返回与 SDK/浏览器链路，没有代跑用户的 Claude CLI 对话。客户端模型仍负责将工具结果展示到聊天中；遇到旧说明可重连 MCP，链接遗漏时要求调用 `browser_human_link` 并完整发送 `userMessage`，会话已结束时重新创建。

## 前一批：首页 Claude Code 安装说明

依据 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)，在主页补充 `claude mcp add --transport http --scope user agentic-browser <当前 MCP 地址>`、独立复制按钮、用户范围说明，以及 `claude mcp get agentic-browser` / `/mcp` 的检查步骤。Copy prompt 同步包含 Claude Code 的安装方式；JSON 示例补齐 `type: "http"`，避免被 Claude Code 当作 stdio 配置解析。

语法和差异空白检查通过；确认无活跃访客浏览器后更新线上控制器，健康检查正常。独立 Chrome 实测命令完整复制、提示词包含相同命令、JSON 的 HTTP 类型及成功提示均正确，390px 手机宽度无横向溢出。截图为 `output/playwright/claude-homepage-mobile.png`，构建日志为 `output/runtime/claude-homepage-build.log`。本机未安装 Claude CLI，本次验证范围为页面与官方命令用法，没有修改用户的 Claude 配置或声称完成 Claude 客户端连接验收。

## 前一批：首页 Copy prompt 接入入口

公共主页“连接 MCP”区域新增 `Copy prompt` 主按钮和可展开的完整提示词预览。提示词从当前部署配置读取 MCP 地址，包含 Streamable HTTP 接入、通用 JSON 配置、保留客户端已有配置、实际验证工具可用性，以及 HTTPS 下的 GitHub 私有仓库体验任务。提示词要求按当前客户端的能力配置；不能直接配置或需要刷新、重启时给出具体步骤，不承诺任意客户端都能自动安装。

保留原有复制配置和 Codex CLI 命令。剪贴板被拒绝时，自动展开并选中完整文字，提示手动复制；配置加载失败时禁用复制按钮并提示刷新。HTTP 入口的提示词继续只使用公开网页和虚构数据，不改变既有展示条件。

语法检查、`npm run check` 和差异空白检查通过。确认无活跃访客浏览器后重建控制器镜像并部署，线上健康检查正常。使用独立 Chrome 在公共 HTTPS 域名实际点击，验证剪贴板与预览逐字一致、MCP 地址及 GitHub 任务正确、原有复制配置仍可用；模拟剪贴板拒绝和配置接口 503 后，回退及错误提示正常。390px 手机宽度下展开长提示词无横向溢出。截图位于 `output/playwright/copy-prompt-desktop.png`、`output/playwright/copy-prompt-mobile.png`，构建日志位于 `output/runtime/copy-prompt-build.log`。没有修改测试者客户端配置，也没有登录真实 GitHub 账号。

## 前一批：补齐直接启动的环境配置

按用户要求为 `.env` 补齐 11 项原本隐含的运行时默认值，包括身份模式、数据目录、浏览器路径/无头选项、Docker 镜像与出网配置、成员和绝对期限限制、公共来源限额及代理信任。保留已有域名、端口、desktop 模式、会话参数和令牌；可选 Chromium 路径及 Docker 卷配置仅添加注释，不启用无效空值。

通过配置解析器比较补齐前后的完整有效配置，确认所有原有值和实际行为一致。文件仍为 0600 且由 Git 忽略，未输出令牌或其他凭据，未重启服务。同步为 `.env.example` 和 Ubuntu 指南说明：直接运行读取 `.env` 的 `PUBLIC_URL`；公共 Compose 读取 `.env.public` 的 `AB_PUBLIC_URL` 并映射到容器内 `PUBLIC_URL`；小写 `public_url` 不生效。当前线上公共服务继续使用 `.env.public`。

## 前一批：修复域名 Host 校验及 Cloudflare 镜像转发

用户已将 `agentic-browser.zkpass.org` 通过 Cloudflare 指向服务器，并配置 Nginx 80 → 本机 8080。访问报 `host_rejected` 的原因是公共 Compose 实例仍配置旧 IP origin；修改旧服务的 `.env` 不会更新此实例。已在 `.env.public` 设置 `AB_PUBLIC_URL=https://agentic-browser.zkpass.org`，重建公共控制器，并将 8080 改为仅监听 `127.0.0.1`。

仅更新 `/etc/nginx/conf.d/agentic-browser.conf`，补齐 HTTP/1.1、Upgrade/Connection、关闭代理响应缓冲；从 Cloudflare 官方 IPv4/IPv6 网段恢复访客 IP，拒绝信任其他来源伪造的 `CF-Connecting-IP`。Nginx 覆盖发给应用的 `X-Real-IP`，应用开启 `AB_TRUST_PROXY=true`，后端端口不对公网开放。旧配置备份为 `/var/backups/agentic-browser/agentic-browser.conf.20261013T174125Z`，语法检查后已平滑重载，未修改其他站点。

实际域名验收通过：首页 200、`/health` 正常、MCP 协商与 9 个工具、HTTPS 接管 URL、Secure Cookie、Cloudflare/Nginx 的 WebSocket 与 RFB 握手、人工交还、Agent 读取虚构站点，以及关闭测试会话。没有登录真实账号或读取私人仓库。

当前客户端入口为 `https://agentic-browser.zkpass.org/mcp`。本机只有 Nginx 80 监听，没有源站 443/TLS；不能把 Cloudflare 边缘 HTTPS 等同于全链路加密，也未读取或改变 Cloudflare SSL 设置。后续应配置源站证书和 443，再启用 Cloudflare Full (strict)，仍需真实 Codex 客户端人工体验。

## 前一批：首页改为 GitHub 私有仓库示例

用户要求用真实 GitHub 登录体验替代首页虚构账号任务，将“私有账户数量和名字”按 GitHub 私有仓库总数与名称实现。首页已展示该协作流程，HTTPS 入口会显示可交给 Agent 的任务：打开 GitHub 登录页 → 用户在远程浏览器登录 → 交还 → Agent 统计私有仓库数量和名称 → 关闭会话。

自动审批拒绝了在当前明文 HTTP 入口直接引导真实账号登录，因此采用 HTTPS 条件展示：当前 8080 HTTP 首页仅展示流程说明，隐藏可执行登录任务并保留未加密提示。若继续要求在 HTTP 启用真实登录引导，需要用户明确知悉并确认该风险，再重新提交审批；也可先配置 HTTPS。

已验证 HTTP/HTTPS 两种显示分支，重建控制器镜像并在确认没有运行中访客浏览器后更新服务。公网 IP 首页返回 200，旧虚构账号任务已移除，服务健康；本次没有登录真实 GitHub 账号或读取仓库数据。

## 前一批：8080 端口 IP 试运行

用户要求通过服务器公网 IP 的 8080 端口试用。用户原先修改的是旧服务 `.env`；现已创建独立、仅本机用户可读写且被 Git 忽略的 `.env.public`，配置公共模式监听 `0.0.0.0:8080`，入口 `http://18.140.117.155:8080`，MCP 为同地址的 `/mcp`。

通过 `scripts/public-demo.sh up -d --force-recreate --wait` 启动 `agentic-browser-demo-controller-1`，状态 healthy，使用专属 `agentic-browser-demo-data` 卷。旧的 127.0.0.1:3333 服务和其他 Docker 项目未改动。全站/来源并发均为 2，未启用代理请求头信任。

服务器本机回环及通过公网 IP 访问 `/health` 均返回正常；实际外部电脑的连通性仍由用户试用确认。当前为 HTTP，仅用于虚构数据测试；正式账号体验前切换 HTTPS。未修改云安全组、系统防火墙或现有 Nginx。

## 前一批：Ubuntu 公共 MCP 演示实现与验收

用户反馈 Mac 本地部署测试已通过，本轮按新要求推进 Ubuntu 公共演示：访客自己的 Agent 通过 URL 接入，允许公网网页，需要限额；先提供 IP 配置，以后替换域名。该反馈没有附新的 Mac 沙箱结果，本轮也未重新测试 Mac；下方较早的 Seccomp-BPF 失败记录保留为历史证据。

新增 `BROWSER_AUTH_MODE=public` 和无状态 Streamable HTTP `/mcp`，提供 9 个工具。每次创建返回独立 Session 密钥，后续工具逐会话鉴权；不使用传输层 Session ID 作为身份，不提供匿名全站会话/Profile 列表。一次性人工接管链接 2 分钟有效，领取后使用临时 HttpOnly Cookie；人工阶段拒绝 Agent 观察和输入，点击交还后由访客自己的 Agent 继续。

默认全站 2 个浏览器、每来源 IP 2 个；创建每分钟 6 次、MCP 请求每分钟 120 次，并限制在途请求。Session 初始 5 分钟、最长 10 分钟，禁止保存配置。浏览器和代理使用独立容器，仅挂载自己的代理子目录；公网 80/443 可用，私网/元数据与管理地址仍拦截。创建请求实际断开后回收未交付浏览器；清理失败保留配额与重试记录。

新增独立 `.env.public.example`、`compose.public.yaml`、`scripts/public-demo.sh`，以及 Nginx HTTPS/WebSocket 模板；修复配置公网 IP/域名时控制器健康检查的 Host。首页直接展示 JSON MCP 配置和 Codex CLI 命令，接管页说明临时期限、运营者权限与 HTTP 试运行边界。原断网 `demo` 和团队 `team` 模式继续保留。

本轮自动验收：

| 检查 | 结果与范围 |
| --- | --- |
| `npm run check` | 通过。 |
| `npm test` | 43 项通过，其中新增 8 项公共 MCP 测试；会话密钥/Cookie 隔离、一次性链接、期限、来源配额、HTTP 取消回收、请求限速及清理失败重试。 |
| `npm run test:public-mcp` | 实际独立 Compose + 两个 SDK 客户端 + 两套 Chrome/代理；原生虚构登录、刷新重连、等待交还、外部 Agent 继续、HTTP 公网 IP 健康检查、公网 HTTPS、云元数据拒绝、停止回收和重启失效。 |
| `npm run test:demo` | 原断网双访客镜像流程回归通过。 |
| `npm run test:controller` | 原团队 Compose、双成员权限、保存配置、Chrome 沙箱、控制器重建和崩溃回收回归通过。 |
| Nginx 配置 | 临时证书和本机高端口下 `nginx -t` 通过；未安装/替换系统站点或重载现有代理。 |

证据在 `output/runtime/public-check.log`、`public-unit.log`、`public-build.log`、`public-compose.log`、`public-offline-regression.log`、`public-team-regression.log` 和 `public-nginx-check.log`。测试仅用随机项目/卷/端口和虚构数据，结束后清理测试资源。源码预览允许清单已纳入公共配置、代理模板、页面及测试；真实 `.env.public`、数据卷、Chrome 包和凭据不进入归档。

尚未对公网开放 IP/端口，也未配置真实域名证书；Codex/Cursor 桌面客户端人工接入需部署后验收。SDK 1.32.1 的 HTTP 链路已验证，协商协议为 `2025-11-25`；未宣称支持之后的所有协议修订。无状态 HTTP 不按匿名请求 ID 跨连接取消操作；若客户端仅发送取消通知而不真正断开，服务端等待可继续到 25 秒上限，创建可完成后等待到期回收。文档与工具提示已说明，不把取消等同于关闭浏览器。

下一步：按 Ubuntu 指南填入 IP 并开放测试者入口 → 实际 Codex 连接与人工交接 → 替换域名/HTTPS、核对代理来源限额 → 小范围邀请体验。真实日常数据继续使用个人/团队自己的部署。

## 前一批：Mac 实机已部署，Chrome 沙箱验收受阻

2026-10-13：在 Apple Silicon Mac 的 Docker Desktop Engine 29.8.2 上构建 arm64 控制器、amd64 Chrome 镜像，部署到 `http://127.0.0.1:3334`。显式使用 `desktop-linux` context；3333 的 Cursor 监听保持原状。控制器 healthy、doctor 全项通过，正式成员列表为空，测试仅使用虚构数据。

实机发现并修复 `DockerEngine.prepare` 的镜像 ID 兼容问题：containerd 平台 inspect 返回的子 manifest 摘要不能直接再次作为 image ID 查询，现先固定顶层 ID，再检查目标平台，继续保留实例固定镜像与 amd64 校验。

类型检查通过，Linux 控制器内 35 项单元/API 测试通过。Compose 验收完成挂载与成员隔离、配额、noVNC 刷新、原生虚构登录、交还与 Agent 读取后，在 `chrome://sandbox` 的 Seccomp-BPF 断言失败（Namespace/PID/Network 为 Yes，Seccomp-BPF/TSYNC 为 No）。后续保存配置重开、重建和崩溃恢复未执行，不能记为通过。

扩展套件确认两项固定扩展的版本与启用状态，第一项在同一沙箱断言失败；第二项 Schema Validator 的断网合成捕获、结果返回、交还 Agent 通过。测试容器和随机卷已清理，正式控制器与专属数据卷保留，没有真实登录或安全配置降级。完整验收和真实使用仍受阻，原因待进一步定位。详见 [Mac 实机结果](MAC_DEPLOYMENT.md)。证据：`output/runtime/mac-build.log`、`mac-doctor.log`、`mac-controller-test.log`、`extensions-test.log`。

## 前一批：已授权仅控制器挂载 Docker socket

2026-10-13：用户在了解权限范围后明确授权“仅控制器容器挂载 Docker socket”。已落实 `compose.yaml`、本地配置示例和 `scripts/compose.sh`：团队认证、127.0.0.1 入口、默认单会话、专属 named volume，控制器以 uid/gid 1000 运行，附加 socket 的 Linux 组，不使用 privileged。只有控制器获得 Docker 管理权限；浏览器与代理不继承 socket 或附加组。启动步骤见 [Mac 部署指南](MAC_DEPLOYMENT.md)。

真实 Compose 控制器自动验收已通过，测试文件为 `test/controller.integration.ts`，入口 `npm run test:controller`，已加入完整验收脚本。覆盖：

- 控制器内 doctor 通过；只读根、cap-drop ALL、非 root、专属数据卷、仅本机发布 HTTP。
- 双虚构成员与 Agent 越权拒绝、默认单会话限额，Chrome/代理只挂载 Profile/代理所需子目录，没有 Docker socket、身份库或完整控制器数据。
- Agent 创建会话 → 人工镜像刷新重连 → 原生输入虚构登录 → 交还 → Agent 读取登录结果。
- Chrome namespace/seccomp 沙箱保持启用；主动保存的虚构 Cookie 在控制器完全重建后仍能读取。
- 控制器 SIGKILL 后再次启动，依据原实例账本清理遗留浏览器/代理并释放 Profile；正常停止同样完成回收且保留数据卷。

最终镜像复验：类型检查、35 项单元/API 测试及 1 项完整 Compose 验收全部通过。日志为 `output/runtime/controller-types.log`、`controller-unit-test.log`、`controller-compose-final.log`；首轮证据为 `controller-compose-test.log`，最终镜像构建为 `controller-authorized-build.log`。测试只操作随机命名的测试项目和虚构数据，最终移除测试容器及其卷，未修改运行中旧服务、真实成员或 Profile。

本轮解决了原先缺少明确 socket 授权的阻塞。当前 Ubuntu 可以完成容器控制器验收，**Apple Silicon Mac 实机尚未验收**；下一步是在用户 Mac 按指南构建、启动、创建成员并验证沙箱、固定扩展、人机交接和性能，不再需要重复申请该 socket 权限。

## 前一批：M 系列 Mac / 32 GiB 适配

用户明确希望部署在 Apple Silicon Mac，32 GiB 内存。已新增原生架构控制器镜像、容器内获取固定软件包的构建脚本，以及浏览器 amd64 平台选择和 named volume 子目录挂载支持。具体可审阅配置与边界见 [Mac 部署适配](MAC_DEPLOYMENT.md)。

本批实际验收：

- `npm run check` 通过；单元/API 测试由 33 增至 35，全部通过，新增卷根、路径越界、符号链接逃逸和 demo 卷根配置测试。
- 原有 4 项 Runtime 验收通过；新增真实 named volume 子目录测试修正夹具后通过，覆盖配置/代理挂载范围、Chrome 沙箱、人工镜像交接、配置再开与清理。
- 实际 MCP SDK → Docker Chrome → noVNC 虚构登录 → 交还继续的回归通过。
- 控制器镜像和浏览器镜像在当前 Linux amd64 主机构建成功；控制器在断网、只读根、cap-drop ALL 的容器内检查依赖通过，以 uid 1000 运行，容器没有 Docker socket。

证据：`output/runtime/mac-unit-test.log`、`mac-runtime-test.log`（保留首次失败与原有四项结果）、`mac-volume-test.log`（修正后的新增验收）、`mac-mcp-regression.log` 和 `mac-final-build.log`。新增测试的两处夹具修正为：用实际私有标记文件检查挂载泄漏，而非把镜像自带空 `/data` 目录当成泄漏；通过测试容器内部诊断检查 Chrome 沙箱，保持产品 API 仅接受 HTTP(S) 导航的限制。

该批结束时，自动审批因缺少明确 socket 授权阻止了完整 Compose 部署；用户后续明确授权，本页最新追加已记录实际完成的部署验收。真实 M 系列上的架构模拟、Chrome 沙箱与扩展性能仍需在 Mac 上验证。

## 本轮结果

已经实现并验证“外部 Agent → 独立容器 Chrome → 成员接管远程镜像 → 虚构登录 → 交还 → Agent 继续”的完整链路。同一 Session 内复用浏览器，不是每个工具调用都新建环境。Session 关闭后回收临时容器；主动保存的 Profile 独立保留，并按成员和具体 Agent 凭据授权。

两个指定扩展随运行镜像携带原始包，全新 Profile 在完全断网时也能安装。Schema Validator 已通过原版扩展实际捕获合成接口、返回校验成功再交还；真实 TransGate 证明仍待业务配置和数据源，不能用安装成功替代证明验收。

公共演示包括原断网固定流程和新公网 HTTP MCP 模式，两者使用独立临时访客，均不能保存 Profile 或签发成员/Agent 凭据。新模式的任务由访客自己的 Agent 执行，具体边界见本页最新追加；这里只完成实现和本机验收，尚未对公网发布。

## 阶段状态

| 阶段 | 当前结果 | 剩余范围 |
| --- | --- | --- |
| M0 人机协作 | 实现与基础真实使用通过 | X/GitHub 等网站逐项验收。 |
| M1 会话稳定性 | 保存配置、重连、续期、绝对寿命与自动测试通过 | 真实 Google 保存配置重新打开及服务重启后复用。 |
| M2 团队隔离 | S1 身份、S2 Runtime、S3 镜像权限已实现并自动验收 | 另一台部署主机、入口代理及生产策略复核。 |
| M3 外部 Agent | 团队 stdio 11 工具及公共 HTTP 9 工具，实际 SDK 完整协作通过 | Codex/Cursor 等具体桌面客户端的人工配置体验。 |
| M4 自部署与演示 | Ubuntu 公共 Compose、IP/HTTPS 指南、限额和双访客实际 Docker 链路已实现 | 干净主机安装与正式公开演示部署。 |
| M5 版本与运维 | 已有本地镜像摘要、源码文件摘要、验收入口及运维说明 | 实际跨版本升级、Profile 兼容、备份恢复和发布渠道。 |
| E0 扩展安装 | 两项原始 CRX、离线安装及 Chrome 沙箱通过 | 持续升级验收。 |
| E1 扩展业务 | Validator 合成成功路径及人机交还通过 | 真实 TransGate 证明、失败/取消路径及业务网络需求。 |
| E2 运行模板 | 实例级镜像 ID 固定、每 Session 扩展启动检查通过 | 未提供 Session 任意选镜像或模板市场。 |
| E3 制作与发布 | 干净 Docker 构建及本地源码预览包 | 跨版本回退与正式发行。 |

## 前一批全套自动验收

本轮最终镜像构建后执行 `npm run verify`，类型检查及 **46 项测试全部通过**。记录位于 `output/acceptance/20261013T060600Z/results.tsv`，各项日志保存在同目录。输出目录不进入版本库；可复现证据是下列测试代码及验收脚本。

| 命令/步骤 | 结果 | 验证范围 |
| --- | --- | --- |
| `npm run check` | 通过 | TypeScript 检查。 |
| `npm test` | 33 项通过 | 控制权竞争、期限、成员与凭据、逐资源授权、CSRF、Profile 归属/锁、镜像票据、出网规则、排队动作撤销、MCP 等待取消及 demo 权限。 |
| `npm run test:browser` | 1 项通过 | Chromium 虚构登录与交接。 |
| `npm run test:desktop` | 2 项通过 | 原生远程桌面、完整服务重启后的虚构 Cookie 保留。 |
| `npm run test:team` | 2 项通过 | 双成员工作台、真实 noVNC 单窗口、刷新/断网重连、虚构登录及注销撤销。 |
| `npm run test:extensions` | 2 项通过 | 断网安装、原版 UI、Chrome 沙箱、Cookie/扩展存储隔离、原生输入及原版 Validator 的合成捕获。 |
| `npm run test:runtime` | 4 项通过 | 文件/进程/环境/挂载/网络隔离、保存 Cookie 跨容器复用、公网代理与私网拒绝、容器强杀、控制进程 SIGKILL 后清点恢复。 |
| Docker + MCP 真实客户端链路 | 1 项通过 | 官方 SDK stdio 客户端、个人 Agent 凭据、独立容器、人工镜像、等待唤醒、交还继续。 |
| `npm run test:demo` | 1 项通过 | 两个匿名访客的独立断网容器、虚构登录、固定 Agent 完成、显式回收归零。 |

Docker + MCP 命令：`AGENTIC_TEST_DOCKER=1 AGENTIC_TEST_MCP=1 npx tsx --test test/team-desktop.integration.ts`。完整顺序在 [验收脚本](../scripts/acceptance.sh)。测试使用临时目录和虚构账号，没有读取用户的真实 Profile、密码或 Cookie。

部署只读检查 `BROWSER_AUTH_MODE=team BROWSER_MODE=docker npm run doctor` 已通过。源码预览归档已经在全新临时目录完成允许清单与全部 83 个源文件摘要核对、`npm ci --offline`、类型检查和 33 项单元/API 测试，全部通过；测试目录已删除。证据在 `output/runtime/preview-install-test.log`。这不等于另一台干净主机的安装验收。

上一批验收时的镜像：`agentic-browser:zkpass-prototype`，当时 ID 为 `sha256:1f1f217bc20c4f46f43ef654b92f3a96ad70cb5cc5edcfbf7d54c1f9db13263e`。锁定 Chrome `155.0.8059.39`、TransGate `0.5.5`、Schema Validator `0.1.3`；包摘要见 [锁文件](../runtime/assets.lock.json)。Debian 软件源未固定到快照，不能声称逐字节可复现构建。

验收后本项目测试用浏览器/代理/扩展容器均已清理。其他项目的容器不在操作范围内。

## 已实现的权限与生命周期

- 成员由服务器管理员创建，密码用 scrypt，身份和随机凭据摘要保存在私有 SQLite；Cookie 与个人 Agent 凭据用途分离。
- Session 绑定成员及具体 Agent 凭据。同成员另一把 Agent 凭据也不能自动接管；保存 Profile 必须逐项授权，创建/删除只允许成员本人。
- 人工镜像需要 Cookie 加 15 秒一次性票据。同一 Session 一个输入窗口；交还、注销、撤销、到期和停用会终止存活连接。
- 每个 Session 一个浏览器容器，网络默认隔离；出网经自己的 Unix socket 代理，只允许经解析校验的公网 80/443，拒绝私网、元数据和管理入口。CDP/VNC 不发布宿主机端口。
- 默认临时，保存模式只挂载一份获授权的 Chrome 目录。成员与实例限额包含正在创建的会话；续期受绝对寿命限制。
- 回收先确认容器消失，再释放配置锁和资源记录。失败保留记录并重试；重启按本实例标签清点，不按任意 PID 或全局 Docker 清理。
- MCP 状态等待最长 25 秒，可取消；取消等待不会结束浏览器，不自动重放网页操作。
- 访客 demo 强制断网、每人一会话、5 分钟初始期限和 10 分钟上限，身份/数据与团队模式分目录。

实现与边界分别见 [成员说明](TEAM_SETUP.md)、[Runtime](RUNTIME.md)、[Agent 接入](AGENT_CLIENT.md) 和 [访客演示](PUBLIC_DEMO.md)。宿主机管理员仍在信任边界内；容器不构成绝对隐私保证，也不能撤回外部 Agent 已取得的信息。

## 本轮修复的问题

| 问题 | 处理及验证 |
| --- | --- |
| 严格容器配置下 Chrome sandbox 无法启动 | 在官方 seccomp 基础上允许 Chrome 内部 namespace 的 chroot，外层仍 cap-drop ALL、非 root。 |
| Validator 合成 Schema 的断言类型不匹配 | 夹具改为原版扩展要求的字符串，未修改扩展。 |
| Agent 撤销时已排队动作仍可能执行 | 操作开始和返回前重新核验，等待也受撤销约束。 |
| 第二镜像窗口不断重连争抢 | 明确独占错误，提示关闭旧窗口后手动重连。 |
| Docker stop 返回但自动删除尚未结束 | 等待并核实容器消失，必要时重试；资源记录不提前清除。 |
| 删除会话时轮询抢先显示结束 | 忙碌期间暂停轮询，过期响应不改变新状态；显式结束等待清理响应，真实双访客回收通过。 |
| 管理地址的不同 IPv6 写法可能绕过文本比较 | 以 IP 地址集合比较，补充等价地址拒绝测试。 |

## 真实使用与待人工验收

| 场景 | 结果 |
| --- | --- |
| 用户在 Ubuntu 远程 Chrome 登录 Google，交还后读取 Gmail 垃圾邮件状态 | 先前已通过一次真实使用；本轮没有再次登录真实账号。 |
| Google 保存 Profile 重新打开、正常服务重启后复用 | 待用户主动创建保存配置并登录。自动化中的虚构 Cookie 已通过。 |
| X 登录并读取关注者；GitHub 登录后读取仓库数量 | 先前尝试未完成，不记录为已支持。 |
| zkPass TransGate 真实证明 | 待应用/Schema、数据源、所需节点和测试账号；当前不能代填或自动付费。 |
| 新主机、实际 HTTPS 入口、桌面 Agent 客户端 | 待对应部署环境和客户端验收。 |
| Chrome/扩展真实跨版本升级和回退 | 待第二个审核版本及可丢弃测试 Profile。 |

这些依赖未阻止本轮继续完成其他开发；不会把它们标成通过，也不会将真实账号秘密写进文档。

## 当前部署状态和下一步

本轮没有修改现有 `.env`，没有把正在使用的服务自动切换为团队或演示模式，没有创建真实成员密码、迁移旧 Profile、公开服务、提交 Git 或上传镜像。源码与本地运行镜像已更新；运行中的旧服务不因此自动代表最新版。端口转发是否仍存活需以使用时的客户端面板为准。

下一批建议按以下顺序推进：

1. 优先在用户 M 系列、32 GiB Mac 按 [Mac 指南](MAC_DEPLOYMENT.md) 部署，验证实际架构模拟、Chrome 沙箱、两项扩展及完整人机流程；另一台干净 Linux 主机仍可按自部署指南验收。
2. 用户在保存配置中登录真实网站，验证新 Session 和正常重启后的复用。
3. 提供 zkPass 测试应用/Schema 与数据源，完成真实证明和失败/取消路径，记录所需网络协议。
4. 依据结果决定首个正式版本及发布渠道，再验收升级、私有数据备份恢复和回退。

## 变更记录

| 日期 | 事项 | 结果 |
| --- | --- | --- |
| 2026-10-13 | 仅控制器 Docker socket 明确授权与 Compose 部署 | 非 root 容器控制器、专属卷及默认单会话落地；类型检查、35 项单元/API 和完整 Compose 协作/保存/回收验收通过。Mac 实机待验收。 |
| 2026-10-13 | 远程 Chrome 人机交接与稳定性 | 真实 Google/Gmail 协作通过一次；保存配置、重连、续期初版 22 项自动测试通过。 |
| 2026-10-13 | 确认产品与部署方向 | 外部 Agent 优先；公共部署只演示，真实使用自部署；团队成员隔离；固定两项 zkPass 扩展。 |
| 2026-10-13 | 扩展 E0/E1 原型 | 离线安装、沙箱、原版 Validator 合成捕获与交还通过。 |
| 2026-10-13 | S1/S3 | 成员、具体凭据绑定、Profile 授权、Cookie/票据和镜像独占通过。 |
| 2026-10-13 | S2/E2 | 独立 Runtime、固定镜像 ID、出网策略、扩展就绪、资源回收和异常恢复通过。 |
| 2026-10-13 | M3 | MCP 等待/取消、转发入口、真实 SDK 客户端的完整容器协作通过。 |
| 2026-10-13 | M4 预览 | 受限双访客演示、自部署指南、doctor 和允许清单源码打包；最终全套 46 项测试通过。 |
