# Agentic Browser 进度记录

更新日期：2026-10-13，北京时间。当前为自部署预览版，完成本轮可独立推进的开发和自动验收；没有发布公网服务。安装见 [自部署指南](SELF_HOST.md)，总体路线见 [计划](PLAN.md)。

## 最新追加：Mac 实机已部署，Chrome 沙箱验收受阻

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

公共演示使用短期访客、每人独立断网容器和固定虚构登录流程，不能保存 Profile 或签发成员/Agent 凭据。双访客的实际镜像流程已通过；这里只完成实现和本机验收，尚未对公网发布。

## 阶段状态

| 阶段 | 当前结果 | 剩余范围 |
| --- | --- | --- |
| M0 人机协作 | 实现与基础真实使用通过 | X/GitHub 等网站逐项验收。 |
| M1 会话稳定性 | 保存配置、重连、续期、绝对寿命与自动测试通过 | 真实 Google 保存配置重新打开及服务重启后复用。 |
| M2 团队隔离 | S1 身份、S2 Runtime、S3 镜像权限已实现并自动验收 | 另一台部署主机、入口代理及生产策略复核。 |
| M3 外部 Agent | 11 个 MCP 工具及真实 SDK 客户端完整协作通过 | Codex/Cursor 等具体桌面客户端的人工配置体验。 |
| M4 自部署与演示 | 指南、只读 doctor、源码允许清单打包、双访客演示已实现 | 干净主机安装与正式公开演示部署。 |
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
