# 完整 Agent 自部署计划

2026-10-25：用户确认以完整 LibreChat Agent 取代 MCP 自部署入口，授权自动推进。

## 架构与边界

保持两个独立项目：LibreChat 管理聊天、账号、Agent、credits 与预算；Browser Service 管理私有工具 API、排队、控制权、画面和 Chrome 生命周期。发行配置、镜像构建和安装工具统一位于 Browser 仓库的 `deploy/agent/`。不新增 MCP 适配或第二套账号。

目标为预构建镜像 + Docker Compose，用户无需安装 Node、获取源码或编译前端。一个反向代理入口连接 Agent 与 Browser 数据监听器；数据库与控制 API 不发布端口。仅可信 Browser Service 挂载 Docker socket；运行时只获得会话子目录，不获得数据库、模型密钥或整个数据卷。

首版验收 Linux amd64、本地 Docker Unix socket、单机部署，默认并发 1，每账号 1，硬上限 10。ARM64/Mac 待整套验收。默认关闭公开注册，管理员由受控初始化创建；开放注册必须配置 Turnstile。Qwen 云模型的提示和工具结果仍离开本机；完全离线模型另行验收。

公网与私有部署共享配置生成器和应用行为，但各自有明确默认值。公网现有容量 5、预算、域名和认证行为保持不变；私有部署使用独立卷、密钥和端口。升级不得重新生成密钥、重置密码或发放 credits。

## 阶段和验收

| 阶段 | 交付 | 状态 |
| --- | --- | --- |
| P10.1 | 通用配置、私有模式、共享生成器；公网生成结果等价、缺配置拒绝启动 | 通过 |
| P10.2 | 定制 Agent/Browser 镜像、Compose、入口代理；独立数据库中验证聊天、排队、接管和自动继续 | 同机隔离验收通过，开发预览 |
| P10.3 | 安装初始化、账号创建/恢复、诊断、可移植备份/升级/恢复 | 同机隔离验收通过；见运维边界 |
| P10.4 | 干净主机从发行包安装、升级、恢复及资源清理；不复用宿主 Node 依赖 | rc.2 包内同机隔离验收通过；独立测试机待提供 |
| P10.5 | 固定镜像摘要、版本清单、安装包、自部署指南；旧 MCP 文档归档 | rc.2 六镜像候选包已生成并校验；正式发布待新机验收 |

每个阶段记录实际证据，不能把同机容器隔离验收称为独立新服务器验收。开发构建使用单独镜像标签；未验收镜像不替换公网服务。原有 MCP 版本的数据不自动迁入新账号库，旧发布保留独立历史。

## 2026-10-26（北京时间）P10.1 / P10.2 验收

已交付 `deploy/agent/` 的配置校验、幂等初始化、共享 LibreChat 配置生成器、Agent/Browser Dockerfile、Compose 与入口代理，以及受控镜像构建和隔离验收脚本。私有模式关闭注册，不依赖 Cloudflare；开放注册要求完整 Turnstile 配置。共享生成器与现有公网和旧验收配置逐项等价，未重写生产配置。

- 配置/初始化/代理边界 5 项、构建上下文 1 项、Browser 服务定向 9 项、LibreChat bootstrap 4 项通过；两项目相关类型检查和 LibreChat 相关格式/lint 通过。
- `output/agent/compose-latest.json`：从本地镜像启动独立数据卷，无宿主 Node 运行依赖；管理员/普通账号登录及权限、原生工具调用真实 Chrome、跨账号隔离、容量 1 时排队、输入 WebSocket、Done 撤销旧连接并自动继续、队列自动到号、标题和任务预算、重启后账号/密码/预算保留均通过。模拟模型不产生 Qwen 费用，也不替代供应商实测。
- `output/agent/ui-acceptance.json`：普通账号登录、聊天和浏览器同屏、真实远程画面输入、390px 手机无横向溢出、Done 后原任务完成。控制台仍有关闭 MCP 后的目录 404 和已结束连接的迟到请求；未影响已验证的页面流程，不宣称零控制台错误。
- Lighthouse 三次冷加载中位 LCP 3399ms、TBT 354ms、CLS 0.018，原预算不变。最终 Compose 验收 ID 为 `607b9186-a2ad-4a98-8cb6-4165ed32c509`；界面验收对应 `2b7ab23b-c5eb-4ef3-88af-96eec35dd806`。两个实例均清理完成，生产进程保持不变。

当前只有本地开发预览镜像。Agent 预览镜像由本次编译制品加配置/目录权限修正层组成；发行前仍需从最终版本完整重建、固定 digest 并在干净主机验收。尚未发布安装包或公开 Agent 镜像，不能让最终用户直接使用旧 MCP 安装器。

P10.3 已完成以下范围；下一阶段为 P10.4 干净主机验收和 P10.5 发行。现有公网 P9 流程保持不变。

## 2026-10-26（北京时间）P10.3 安装与运维

- `deploy/agent/agentctl.py` 提供 init/up/doctor/apply、普通账号创建、密码恢复、邮件测试、备份/校验、新实例恢复、同拓扑镜像升级及中断恢复。应用只依赖镜像；宿主需要 Python 3、Docker Engine 26+、Compose v2。版本清单使用固定 digest，本机 image ID 仅在显式 development 模式下接受。
- settings 是 origin/容量的唯一配置来源，自动生成 `.env`；已有目录拒绝重新初始化，修改运行配置要求空闲时 apply。账号命令复用 LibreChat 原生注册和单次恢复，不建立第二套账号；重复创建不发放额度，恢复撤销旧 token/session/passkey，余额保持。
- 可选 SMTP 支持验证证书的 TLS/强制 STARTTLS；测试收据绑定 SMTP 配置、凭据与外部 origin，确认接收并 apply 后才启用原生找回。隔离 TLS 邮件服务验证测试邮件、找回链接、单次消费、旧登录失效和额度保持；没有向真实收件人发送邮件。
- 备份先检查任务、事件和 runtime 空闲，维护入口拒绝新请求并排空已进入请求，再停止各写入服务，归档六个卷、配置/密钥、Compose 和版本清单。校验摘要和归档路径后原子发布；普通失败恢复服务。归档 helper 无网络/无 Docker socket，仅挂载一个目标卷，超时按独有名称清理。
- 恢复只允许新目录/project/卷，要求匹配镜像和数值 UID/GID，生成新的 Browser instance ID。先保持停止状态，默认回环 origin、关闭注册，核对后 recover。账号/密码/聊天/credits/预算一致；新实例还通过真实 Chrome 新任务与 Done 自动继续的 UI 验收。
- 升级前自动备份；失败保留维护状态，拒绝直接将旧程序接入可能已变更的数据库。已实测成功升级保留数据、错误 Agent 镜像触发失败保护、已有目标拒绝覆盖恢复。
- 完整报告 `output/agent/operations-317aa156-188e-46ff-a4a5-c34e31c25327.json`，UI 报告 `operations-ui.json`；配置/邮件 6 项、运维保护 7 项和类型检查通过。测试容器、卷和网络已清理，生产 PID 保持不变。模型模拟不收费，Chrome 实际访问 example.com。
- Lighthouse 最终在暂停代码编辑与运维负载后通过：三次冷加载中位 LCP 3415ms / TBT 326ms / CLS 0.018，原门槛不变。此前并行运维和随后仍有代码编辑/索引活动的两轮 TBT 分别为 741ms、553ms，失败记录保留；不能把此单机结果解释为任意负载下的性能保证。

操作见 [运维手册](../../deploy/agent/OPERATIONS.md)。本轮仍是同机开发预览：尚未验证新服务器，也没有公开镜像/发行包。恢复不包含外层 HTTPS 代理/证书、手工额外挂载文件及镜像本体；升级限定相同 Compose 拓扑，不做 Mongo 大版本转换。私有部署的定时备份、自动轮转、异地副本和宿主 watchdog 尚未安装；强杀/断电后通过持久操作记录和 recover 手动恢复，不能称为已自动兜底所有中断。

## P10.4 / P10.5 候选包准备

从 Git 固定提交构建三应用镜像，Chrome/扩展复制前核对 lock 摘要；包内包含六镜像、源码/工具版本清单、Python 安装与验收工具、校验文件和许可。新增白名单打包和拒绝篡改/额外文件/不完整镜像的校验。仓库主页和当前 Demo 指南已转向完整 Agent，旧 MCP 文档标记归档。构建及端到端证据如下。当前可确认的主机运行着公网 Demo，未发现可用独立测试机或 KVM；已询问用户提供测试机，同时继续不依赖它的工作。


### rc.2 候选包验收结果

- 应用源码固定为 Browser `20f9190ad8956f682945cdd2c4ab83fc15838dae`、LibreChat `0d7ee88b4fa9259b5176772968f8a29925348a01`；Agent/Browser/runtime 均从 Git 对象完整构建，无旧制品覆盖层。安装工具包固定为 `f0965847a9ca76c82a49899681839823668f9d03`。源码与工具分开记录，打包器拒绝应用输入变化后仍复用旧构建。
- 首轮 rc.1 真实 Chrome 启动失败：Git archive 的安全解包过滤器在私密 umask 下生成 0700 子目录，非 root runtime 导入 `src/api/actions.js` 时失败。统一源码目录为 0755，补嵌套目录回归，并从同一源码提交完整重建 runtime；对照容器由模块导入失败变为成功。rc.1 标记拒收，报告保留。
- rc.2 约 1.2 GiB，包含 Agent、Browser、runtime、gateway、Mongo、Redis 六个固定镜像和标准库 Python 安装/验收工具。压缩包摘要 `273deae1e3899ee45204fdb7d3b46b67835c395ad70df9e918bd210c5ca49f42`。三个应用镜像在首轮移除后成功导入；修复版 runtime 也在确认不存在后从 rc.2 重新导入，六镜像身份均核对。
- 从压缩包重新解压，PATH 只提供 Python/Docker，实测 `hostNodeAvailable: false`；通过缺配置/重复初始化保护、普通用户权限和一次性 credits、真实 Chrome 页面读取、接管归还自动继续、忙时拒绝备份、恢复到新 project/卷并保持账号/聊天/credits/预算、新 runtime ID 和新的真实任务，以及同镜像升级程序演练。该升级演练不代表两个实际发行版本间的数据迁移验证。
- 最终报告 `output/agent/bundle-acceptance.json`，汇总 `output/agent/release-candidate-acceptance.json`；Python 构建/运维/打包 15 项、配置 6 项、历史打包 2 项和类型检查通过。测试容器/卷/网络/helper 无残留，公网 PID 未变，16 项健康正常，运行并发保持 5。没有真实模型或邮件调用。
- 包位于 `output/agent/releases/v0.2.0-rc.2/`，未上传/公开发布。已准备 `.github/workflows/accept-agent-bundle.yml`，但尚未执行。独立干净主机、真实跨版本升级、匿名 registry 拉取和公开下载仍待验收，因此 P10.4/P10.5 不标记全部完成。
