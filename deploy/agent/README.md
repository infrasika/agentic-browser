# 完整 Agent 开发与构建

本目录负责 LibreChat Agent、Browser Service、Chrome runtime、gateway、Mongo 和 Redis 的完整 Compose 部署。原域名测试站也使用同一拓扑。用户入口是 [安装](INSTALL.md)，日常管理见 [运维](OPERATIONS.md)，发行流程见 [BUILD.md](../../BUILD.md)。

## 源码边界

- 本仓库：浏览器协议、调度、隔离运行时与 `deploy/agent/` 安装工具。
- `integrations/librechat/` 锁定上游源码及定制补丁：定制聊天应用、账号、原生 Agent 工具与成本管理。
- 协议定义在 `src/api/`；修改协议时用 `scripts/sync-browser-contract.mjs /path/to/prepared-librechat` 同步，`--check` 核对。

源码工具统一使用 Node.js 24 和 npm；构建另需 Git、tar 和 Docker/Buildx，输出 Linux amd64 / arm64 镜像。部署者使用 Node.js 24、Docker、Linux flock 和配置文件；发行工具已编译为独立文件，无需安装 npm 依赖。Mac 与 Ubuntu 使用相同命令；源码准备和修改方式见 [LibreChat integration](../../integrations/librechat/README.md)。当前未做 Mac 实机或原生 ARM64 部署验收。完整操作见 [构建与发布](../../BUILD.md)。

## 构建与测试

```bash
npm ci
npm run check
npm test
npm run build:agent -- --committed --tag v0.2.0-rc.7
```

构建从固定 Git 提交与已校验的 Chrome/扩展资源创建三个镜像，限制 2 CPU / 5 GiB，不读取本机账号、聊天或私密配置。输出报告位于 `output/build/`，不会自动发布或切换站点。

```bash
npm run accept:agent -- --release /path/to/release.json
npm run accept:agent-ops -- --release /path/to/release.json
```

上述测试创建独立 Compose project、本机数据目录和模拟模型，真实 Chrome 访问 HTTP 测试页。浏览器验收使用 3334，运维验收使用 3335/3336；端口必须空闲。覆盖双账号权限、初始 credits、幂等加额度、预算耗尽、排队、WebSocket、接管继续、退出释放、SMTP 找回、备份、恢复与升级失败。无需已有站点、宿主 systemd 或私密业务配置。成功后清理本次数据，失败诊断留在私密的 `output/tests/` 子目录，公开报告只含汇总。

`--hold` 可在通过后保留测试实例检查界面，收到 SIGTERM 后清理。完整发行包还有独立的 Node/Docker 验收，见 [安装说明](INSTALL.md)。

可选 `node --import tsx test/acceptance/accept-browser-soak.ts --run --capacity=1 --hold-seconds=300` 在有足够空闲资源的测试机执行浏览器持续负载、排队与接管验收。通过 `BROWSER_RUNTIME_IMAGE` 指定固定镜像 ID，使用独立账本和容器，不修改站点容量。

## 配置与持久化

`settings.json` 保存站点、模型/费率、额度、容量和代理设置；`secrets.env` 保存凭据；`browser-token` 仅交给 Agent 与 Browser Service。只有 gateway 发布回环端口，Docker socket 只交给 Browser Service，每个 Chrome 只挂载自己的会话子目录。

安装器生成的 `.env` 不手工编辑，数据统一落在安装目录的 `data/`。配置、邮件、备份和恢复细节只在 [运维手册](OPERATIONS.md) 维护。当前交付和剩余事项见 [进度](../../docs/plans/PROGRESS.md)。

各字段、Compose 插值和 secret 文件挂载的对应关系见 [配置说明](CONFIGURATION.md)。构建、发布不读取站点密钥。
