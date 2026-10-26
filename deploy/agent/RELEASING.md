# 完整 Agent 发行准备

当前为 Linux amd64 候选版。公开 Agent 镜像和下载地址尚未发布，独立新服务器验收仍待完成。不能通过旧 `publish-images.yml` 发布完整 Agent：该 workflow 仍属于历史 MCP/controller 产品。

## 源码与镜像

两个仓库分别保留提交历史。Agent 镜像由 LibreChat 提交加 Browser 仓库的 `deploy/agent/app` 构建，Browser Service 和 runtime 来自 Browser 仓库。发行构建必须使用 `--committed`，读取 Git 对象，不使用工作区修改、未跟踪文件或先前编译产物：

```bash
python3 scripts/build-agent-images.py --run --committed --tag agent-v0.2.0-rc.2
```

一次完整构建生成 Agent、Browser Service 和 runtime 三个镜像，使用独立 2 CPU/5 GiB buildx builder。Chrome/扩展资源从本地缓存复制前逐项核对已提交 lock 的 SHA-256；缓存缺失或变化时失败。基础镜像按 digest 固定；APT/npm 上游仍是构建网络依赖，完整重建不等于字节级可复现构建。

构建报告记录三镜像的本机 ID、两个源码提交及运行时资源摘要。只有 `passed: true`、`sourceMode: committed` 且三镜像完整的报告可以进入打包。镜像标签可变，验收和包内引用均使用固定 ID 或 registry digest。

## 候选包

先提交安装工具与文档，再打包；打包器同样从 Git HEAD 的固定白名单读取，不从整个工作目录复制：

```bash
python3 scripts/package-agent.py \
  --build-report .deployment/agent-build/BUILD_DIRECTORY/report.json \
  --version v0.2.0-rc.2 \
  --output output/agent/releases/v0.2.0-rc.2
```

默认生成带六个镜像的离线候选包，以及外层/内层 SHA256SUMS、源码/工具提交清单、安装器、运维/安装手册、纯 Python 验收脚本和许可。镜像 archive 使用本机 image ID，导入后显式 `--development` 安装；不会将 ID 冒充 registry digest。包内 Mongo/Redis 也固定 ID，不依赖目标机已有仓库缓存。

已发布 registry 镜像后，可以增加 `--release /path/to/release.json` 生成轻量候选包。清单必须有 version 与 agent/browser/runtime/gateway/mongo/redis 六个不可变 registry digest；本机检查实际镜像身份与构建报告一致。打包器本身从不上传镜像、创建 tag、发布 Release 或更改公网服务。

`BUILD.json` 的应用源码提交与安装工具提交允许不同：安装工具/Compose/文档不烘焙进应用镜像。更改 `deploy/agent/app`、应用或 runtime 后必须重新构建对应完整镜像组，不能仅更新工具提交来掩盖陈旧镜像。

## 验收与发布门槛

1. 配置、运维和包边界测试通过；安装包文件校验通过。
2. 解压后的包独立完成安装、普通用户/credits、真实 Chrome、接管/自动继续、备份/新实例恢复、升级程序演练和资源清理。模拟模型不产生真实供应商费用，也不证明供应商兼容性。
3. 在独立干净 Linux amd64 机器重复上述验收，记录机器来源、Docker/Compose/Python 版本、六镜像身份及清理结果。现有宿主的新 Compose project 不能算新机器。
4. 对实际前后两个发行版本做升级/恢复验收；同一镜像的版本号演练只能证明操作流程。
5. 确定公开镜像仓库、固定版本标签及安装包的可下载位置后发布；匿名拉取/下载后重新校验。当前源码仓库私有，GitHub Release 附件不能被当作匿名下载入口。

候选包可以先交给测试机验收。未完成门槛时保持 candidate 状态，不更新旧 MCP controller/runtime 的 stable/latest 别名，不把未发布的地址写成可用下载链接。

可选 `.github/workflows/accept-agent-bundle.yml` 在 GitHub 的全新 Ubuntu runner 执行同一验收，输入可信 HTTPS 候选包地址与 SHA-256；不 checkout 源码、不 setup Node、不构建镜像。测试 PATH 只提供 Python/Docker，报告单独记录 runner 来源。该 workflow 已准备但尚未推送或执行；需先提供测试机可下载的候选包位置，不能把“已写 workflow”当作通过证据。
