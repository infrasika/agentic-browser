# 完整 Agent 开发与构建

本目录负责 LibreChat Agent、Browser Service、Chrome runtime、gateway、Mongo 和 Redis 的完整 Compose 部署。原域名测试站也使用同一拓扑。用户入口是 [安装](INSTALL.md)，日常管理见 [运维](OPERATIONS.md)，发行流程见 [RELEASING.md](RELEASING.md)。

## 源码边界

- 本仓库：浏览器协议、调度、隔离运行时与 `deploy/agent/` 安装工具。
- 相邻 `librechat-agent` 仓库：定制聊天应用、账号、原生 Agent 工具与成本管理。
- 协议定义在 `src/api/`；修改协议时用 `scripts/sync-browser-contract.mjs /path/to/librechat-agent` 同步，`--check` 核对。

最终用户只需要 Python、Docker 和配置文件。开发源码需要 Node 24；构建需要 Linux amd64、Python、Docker/Buildx 和两个源码仓库。

## 构建与测试

```bash
npm run check
npm test
npm run test:python
python3 scripts/build-agent-images.py --run --committed --tag agent-v0.2.0-rc.6
```

构建从固定 Git 提交与已校验的 Chrome/扩展资源创建三个镜像，限制 2 CPU / 5 GiB，不读取本机账号、聊天或私密配置。输出报告位于 `.deployment/agent-build/`，不会自动发布或切换站点。

```bash
node scripts/accept-agent-compose.mjs --run --release /path/to/release.json
node scripts/accept-agent-operations.mjs --run --release /path/to/release.json
```

上述测试创建独立 Compose project、本机数据目录和模拟模型，真实 Chrome 访问 HTTP 测试页。浏览器验收使用 3334，运维验收使用 3335/3336；端口必须空闲。覆盖双账号权限、初始 credits、排队、WebSocket、接管继续、SMTP 找回、备份、恢复与升级失败。无需已有站点、宿主 systemd 或私密业务配置。成功后清理本次数据，失败诊断留在 `.deployment/`，公开报告只含汇总。

`--hold` 可在通过后保留测试实例检查界面，收到 SIGTERM 后清理。完整发行包还有独立的 Python/Docker 验收，见 [安装说明](INSTALL.md)。

底层浏览器可用 `scripts/accept-browser-service.ts` 验收；可选 `scripts/accept-browser-soak.ts --run --capacity=1 --hold-seconds=300` 在有足够空闲资源的测试机执行持续负载。两者均通过 `BROWSER_RUNTIME_IMAGE` 指定固定镜像，使用独立账本和容器，不修改站点容量。

## 配置与持久化

`settings.json` 保存站点、模型/费率、额度、容量和代理设置；`secrets.env` 保存凭据；`browser-token` 仅交给 Agent 与 Browser Service。只有 gateway 发布回环端口，Docker socket 只交给 Browser Service，每个 Chrome 只挂载自己的会话子目录。

安装器生成的 `.env` 不手工编辑，数据统一落在安装目录的 `data/`。配置、邮件、备份和恢复细节只在 [运维手册](OPERATIONS.md) 维护。当前交付和剩余事项见 [进度](../../docs/plans/PROGRESS.md)。
