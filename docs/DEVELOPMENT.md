# 开发指南

开发使用 Node.js 24+ 和 npm。先执行 `npm ci`，锁文件更新后重新安装；不同系统之间不复制 `node_modules`。镜像构建另需 Git、tar、Docker/Buildx，详见 [构建](BUILD.md)。Linux 安装运维还需 flock；Mac 可以构建镜像，安装器运行在 Linux。

## 源码边界

Browser Service、内部协议、队列、隔离运行时在 `src/`。LibreChat 应用由 `integrations/librechat/source.lock.json` 和 `customizations.patch` 定义，包含聊天、同屏浏览器、本地账号、原生 tools、credits、预算和管理员功能。上游 MIT 许可证在同目录保留。

安装模板与工具在 `deploy/agent/`：`agentctl.mjs` 是管理入口，`maintenance.mjs` 管理备份调度，`bundle.mjs` 校验发行包，`lib/system.mjs` 提供文件、进程和锁工具；`app/` 是 Agent 镜像内的配置、初始化和运维入口。它们属于当前产品，不是迁移脚本。组件关系见 [架构](ARCHITECTURE.md)。

## 修改 LibreChat

从仓库根目录准备新的开发 checkout，无需相邻私有仓库：

```bash
npm run source:prepare -- --output output/sources/librechat
npm --prefix output/sources/librechat ci
```

工具获取固定公开上游，应用补丁并校验完整 Git tree、补丁摘要、许可证和协议。输出目录必须不存在。上游提交是 checkout 的 HEAD，定制补丁已经暂存。进入该目录修改并运行受影响的上游测试；不要把应用配置或构建输出纳入补丁。

协议以 `src/api/actions.ts`、`src/api/protocol.ts` 为准。修改后从主仓库根目录执行：

```bash
node scripts/sync-browser-contract.mjs output/sources/librechat
node scripts/sync-browser-contract.mjs output/sources/librechat --check
```

同步需要 checkout 中的开发依赖以使用同一 Prettier 配置。只暂存审核过的应用与协议改动，然后从主仓库根目录重新记录完整补丁：

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const integration = 'integrations/librechat';
const source = 'output/sources/librechat';
const lock = JSON.parse(fs.readFileSync(`${integration}/source.lock.json`, 'utf8'));
const git = (...args) => execFileSync('git', ['-C', source, ...args], { maxBuffer: 64 * 1024 * 1024 });
assert.equal(git('rev-parse', 'HEAD').toString().trim(), lock.commit);
assert.equal(git('diff', '--name-only').toString(), '', 'Stage reviewed changes first');
const patch = git('diff', '--cached', '--binary', '--full-index', 'HEAD');
fs.writeFileSync(`${integration}/customizations.patch`, patch);
lock.patchSha256 = createHash('sha256').update(patch).digest('hex');
lock.tree = git('write-tree').toString().trim();
fs.writeFileSync(`${integration}/source.lock.json`, JSON.stringify(lock, null, 2) + '\n');
NODE
```

审核主仓库 diff，用另一个新目录再次 `source:prepare` 验证，再将 patch 与 lock 一起提交。上游版本升级必须显式更新基础提交并重新验证许可证、协议及应用测试。

## npm 入口与测试

```bash
npm run check
npm test
```

默认测试覆盖浏览器服务、调度、出口策略、部署配置和构建/运维/发行工具，不启动完整站点或调用付费模型。两项 Linux flock 测试在 Mac 跳过，在 Linux 必须通过。

`.github/workflows/ci.yml` 在 push、pull request 或手动触发时，在 Ubuntu 24.04 amd64、Ubuntu 24.04 arm64 和 macOS 14 上使用 Node.js 24 执行 `npm ci`、类型检查和上述测试。工作流只有源码读取权限，不需要部署密钥，不构建或发布镜像。CI 文件在本地提交后，需推送至 GitHub 才会运行；单元测试通过也不能替代镜像构建及完整安装验收。

| 命令 | 用途 |
| --- | --- |
| `npm run source:prepare -- --output NEW_DIRECTORY` | 准备并验证 LibreChat 源码 |
| `npm run runtime:fetch -- --arch arm64` | 下载并验证锁定浏览器资源 |
| `npm run build:agent -- --help` | 构建 Agent、Browser Service、Chrome runtime |
| `npm run publish:agent -- --help` | 发布预检、GHCR 上传、匿名拉取验证 |
| `npm run package:agent -- --help` | 生成含独立 Node 工具的安装包 |
| `npm run agent -- --help` | 源码环境中的安装和运维 CLI |
| `npm run test:service` / `npm run test:agent-config` / `npm run test:tools` | 单独验证服务、配置或工具 |
| `npm run test:runtime` | 真实 Chrome 沙箱、进程/文件/网络隔离及故障清理，需 Docker |
| `npm run test:extensions` | 容器内两个扩展加载及页面检查，需 Docker / Bash |
| `npm run accept:agent -- --release /path/to/release.json` | 完整业务流程：账号、预算、排队、接管、退出 |
| `npm run accept:agent-ops -- --release /path/to/release.json` | 邮件找回、备份、恢复、升级与失败保护 |
| `npm run accept:bundle -- --bundle /absolute/bundle --work /absolute/new-test-directory` | 仅用已生成安装包执行完整验收 |

`test:runtime` 和 `test:extensions` 通过 `BROWSER_RUNTIME_IMAGE` 指定待验收的固定本机镜像。`npm run runtime:build` 可单独生成开发用 runtime；可选 `node --import tsx test/acceptance/accept-browser-soak.ts --run --capacity=1 --hold-seconds=300` 做持续负载与排队检查。这些测试有不同隔离断言，不能用普通页面打开测试替代。

完整验收创建独立 Compose project、数据目录和模拟模型，Chrome 访问公网 HTTP 测试页。业务验收占用 3334，运维验收占用 3335/3336，包验收占用 3340/3341/3342；在空闲 Linux 测试机运行。运维验收还需要宿主 `openssl` 生成测试邮件证书，并要求可用内存超过 6 GiB。它们不读取站点密钥；成功后清理测试数据，失败诊断留在私密 `output/tests/` 或指定目录，只公开汇总报告。`accept:agent` 和 `accept:agent-ops` 的 `--hold` 可保留实例检查，结束时向进程发送 SIGTERM 清理。

`scripts/build/bundle-tools.mjs` 是打包器内部的 esbuild 入口，无需单独调用。准备、下载、构建、发布和打包工具分别对应 npm 命令，保留职责分离。完整发行流程见 [发布](RELEASING.md)。

## 文档维护

指南统一放在 `docs/`，根 README 只做入口。操作步骤使用当前 Node CLI 和 npm 参数；历史记录由 Git 保存，当前验收和未完成事项只维护 [STATUS.md](STATUS.md)。不要将服务器特有路径、迁移过程或已废弃命令混入通用安装流程。

部署、配置、运维文档同时进入安装包，修改相对链接时检查源码和包内两种位置。文件搬迁还需核对 `scripts/build/package-agent.mjs` 的白名单、Docker COPY 和 `.dockerignore`；分发声明是镜像输入，变更后必须重新构建对应发行镜像。
