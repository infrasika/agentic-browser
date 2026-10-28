# 完整 Agent 安装候选包

本包部署 LibreChat 聊天界面、原生浏览器工具、账号/credits/预算、远程 Chrome，以及所需数据库和入口代理。浏览器与聊天同屏，人工归还控制后任务自动继续。无需另外安装 MCP。

**当前是 Linux amd64 安装候选包，尚未完成独立新服务器验收或公开发布。** `BUILD.json` 记录应用源码提交、安装工具提交和六个镜像身份。验收结果以运行后生成的报告为准，打包成功不代表验收通过。默认关闭注册、并发 1；支持的硬上限为 10，实际并发需按主机容量验收。

## 1. 准备环境与校验

宿主需要 Python 3.10+、Docker Engine 26+、Docker Compose v2 或 v5，以及对 `/var/run/docker.sock` 的访问权限。仅支持 Linux amd64，CPU 需要支持 MongoDB 8 所需的 AVX。建议从 4 vCPU、8 GiB 内存、30 GiB 可用磁盘、一个浏览器开始；这不是十个并发的容量保证。外部网站和云模型仍需网络连接。

从可信渠道取得压缩包与外层 `SHA256SUMS` 后，在它们所在目录校验、解压：

```bash
sha256sum -c SHA256SUMS
tar -xzf agentic-browser-agent-v0.2.0-rc.6.tar.gz
cd agentic-browser-agent-v0.2.0-rc.6
python3 bundle.py verify
```

摘要用于检查文件完整性，不构成发布者身份签名；应核对可信下载渠道提供的摘要。不要把私密配置、备份或账号数据放到解压目录中，校验器会拒绝多余文件。

离线镜像候选包包含 `images.tar.gz`，执行：

```bash
python3 bundle.py load-images
```

这会导入六个固定 image ID，不修改已有服务。离线指安装镜像可转移，不表示 Qwen 或目标网站可以离线工作。rc.6 离线镜像来自 Docker 29 的 containerd image store；导入此包也应使用相同镜像存储，否则 image ID 的表示可能不同。不要在已有业务宿主上直接切换存储后端。registry 候选包不含镜像归档，安装时按不可变 digest 拉取。

如果收到的是 registry 候选包，跳过 `load-images`。公开 GHCR 包无需登录；私有 GHCR 包需要部署用户先配置 Docker 登录。不要填写尚未发布的镜像地址，实际引用以包内 `release.json` 为准。

## 2. 初始化并一次填写配置

选择当前用户可写的新目录：

```bash
# registry 候选包
python3 agentctl.py --directory "$HOME/my-agent" init --release release.json
# 离线候选包则在这条命令末尾加 --development
```

`--development` 仅用于包含本机 image ID 的离线候选包；正式 registry digest 清单省略该参数。不能把 image ID 当成可从 registry 拉取的 digest。已有安装目录拒绝覆盖。

编辑 `~/my-agent/config/settings.json` 与 `~/my-agent/config/secrets.env`，填写管理员邮箱、Qwen 模型/base URL/API key 和供应商实际费率。管理员密码、JWT、加密和内部服务密钥只生成一次，文件权限 0600。默认日预算 20,000,000 credits，初始用户额度 200,000；费用换算取决于所配置费率。不要把 API key 填入聊天或命令行。

字段和传递方式见 [CONFIGURATION.md](CONFIGURATION.md)：普通设置通过只读配置文件和生成的 Compose `.env` 传递，密钥通过 `/run/secrets/agent` 挂载。日常只编辑安装目录中的 `config/settings.json` 和 `config/secrets.env`。

```bash
python3 agentctl.py --directory "$HOME/my-agent" up
python3 agentctl.py --directory "$HOME/my-agent" doctor
```

打开 `http://127.0.0.1:3333`，使用配置中的管理员账号登录。远程服务器可从自己的电脑执行 `ssh -L 3333:127.0.0.1:3333 USER@SERVER` 后访问。只有 gateway 监听回环端口；Mongo、Redis、Browser 控制 API 和 MCP 不对外开放。

正式域名由你的 HTTPS 反向代理转发至 `127.0.0.1:3333`。将 settings 中的 origin 改为该 HTTPS 域名，代理保留 Host，支持 WebSocket/长连接并关闭缓存，然后空闲时运行 `apply`。默认私有注册不需要 Turnstile；开放注册必须配置 HTTPS 和 Turnstile 两个密钥。

## 3. 用户与运维

```bash
python3 agentctl.py --directory "$HOME/my-agent" user-create
python3 agentctl.py --directory "$HOME/my-agent" user-reset
python3 agentctl.py --directory "$HOME/my-agent" backup
```

创建普通账号、恢复密码、可选 TLS SMTP 找回、修改配置、升级和新实例恢复见 [OPERATIONS.md](OPERATIONS.md)。备份包含账号、密码摘要、聊天、预算及密钥，需私密保存。升级前自动停写备份；任务忙碌时拒绝执行，失败升级维持维护状态。

可通过 `schedule` 启用每日空闲备份、轮转和普通备份中断恢复，详见运维文档。异地存储、加密及远程挂载需要部署者自行准备，本机副本不能替代异地备份。公开注册和多人并发应在自己的环境完成容量及邮件验收后启用。云模型会接收提示和浏览器工具结果；网站凭据应在远程浏览器的人工接管阶段输入。

## 4. 在空闲测试机验收

包内验收仅依赖 Python 和 Docker。它依次新建三个临时安装实例，使用模拟模型，不调用真实 LLM 或发送邮件；真实 Chrome 访问带固定标记的 httpbin.org HTTP 测试页。它短时占用三个回环端口（默认 3340/3341/3342）及约 4–6 GiB 内存，结束后清理本次容器、卷和网络，成功时只保留报告。请在空闲测试机执行：

```bash
python3 acceptance/verify.py --work "$HOME/agent-bundle-acceptance"
```

覆盖：缺配置拒绝启动、重复初始化保护、普通用户和初始 credits、原生工具打开 Chrome、接管/归还自动继续、忙时延后备份、定时备份和副本校验、备份到新实例恢复、真实新任务、升级程序演练和清理。另在所有写入服务停止后强杀备份进程，验证恢复及遗留辅助容器清理；注入无效 Agent 镜像导致升级失败，验证维护保留、升级前备份恢复和新任务。升级演练使用同一应用构建，不等于跨版本数据库迁移验收；复制目标也是同机目录，不是异地测试。报告不会自行声明“全新服务器”；需要结合实际测试机来源确认。失败的本机诊断目录可能包含测试凭据，不要公开上传。

LibreChat 和浏览器依赖的许可与分发说明保存在 `LICENSES/`；完整上游依赖许可也保留在对应镜像中。
