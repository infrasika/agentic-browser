# 开发指南

开发使用 Node.js 24+ 和 npm。先执行 `npm ci`，锁文件更新后重新安装；不同系统之间不复制 `node_modules`。镜像构建另需 Git、tar、Docker/Buildx，详见 [构建](BUILD.md)。Linux 安装运维还需 flock；Mac 可以构建镜像，安装器运行在 Linux。

## 分支约定

`main` 保存通过检查后合入的代码，`feature` 用于日常开发。开始工作前先同步远程；新 clone 后切换 `feature` 会跟踪同名远程分支：

```bash
git fetch origin
git switch feature
git pull --ff-only origin feature
git merge origin/main
```

在 `feature` 上修改、运行相关检查、提交并推送；完成一个可交付阶段后再合入 `main`。从已提交的源码或固定版本标签构建发行镜像，不直接在 `main` 上堆积开发中的改动。

## 源码边界

Browser Service、内部协议、队列、隔离运行时在 `src/`。LibreChat 应用由 `integrations/librechat/source.lock.json` 和 `customizations.patch` 定义，包含聊天、同屏浏览器、本地账号、原生 tools、credits、预算和管理员功能。上游 MIT 许可证在同目录保留。

部署模板在 `deploy/compose/`，唯一运维入口是容器内 `operations.mjs`。`deploy/agent/app/` 保存镜像内配置、启动、邮件和账号逻辑，`deploy/agent/lib/` 提供共享文件、归档和进程工具。组件关系见 [架构](ARCHITECTURE.md)。

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

这些测试统一由 `npm test` 执行，不再为各子集维护 npm 别名。调试单个测试文件时可直接运行，例如：

```bash
node --import tsx --test test/browser-service.test.ts
node --test test/tooling/compose-operations.test.mjs
```

`.github/workflows/ci.yml` 在 main 的 push、pull request 或手动触发时，在 Ubuntu 24.04 amd64、Ubuntu 24.04 arm64 和 macOS 15 arm64 上使用 Node.js 24 执行 `npm ci`、类型检查和上述测试。工作流只有源码读取权限，不需要部署密钥，不构建或发布镜像。macOS 检查验证 Node 工具和源码的跨平台兼容性，不代表已验证 Mac Docker 构建。发布流水线复用同一套源码检查，镜像构建和部署验收在原生 Linux runner 上运行。

| 命令 | 用途 |
| --- | --- |
| `npm run release` | 读取 package.json 版本，触发 GitHub Actions 构建、验收和发布 |
| `npm run source:prepare -- --output NEW_DIRECTORY` | 准备并验证 LibreChat 源码 |
| `npm run runtime:fetch -- --arch arm64` | 下载并验证锁定浏览器资源 |
| `npm run build:agent -- --help` | 构建 Agent、Browser Service、Chrome runtime |
| `npm run publish:agent -- --help` | 发布预检、GHCR 上传、匿名拉取验证 |
| `npm run test:runtime` | 真实 Chrome 沙箱、进程/文件/网络隔离及故障清理，需 Docker |
| `npm run test:extensions` | 容器内两个扩展加载及页面检查，需 Docker / Bash |

`test:runtime` 和 `test:extensions` 通过 `BROWSER_RUNTIME_IMAGE` 指定待验收的固定本机镜像。单独构建开发用 runtime 也使用统一构建器，明确目标架构，例如：

```bash
npm run build:agent -- --component runtime --platforms linux/arm64 --tag development
BROWSER_RUNTIME_IMAGE=agentic-browser-runtime:development-arm64 npm run test:extensions
```

amd64 主机将上述架构和镜像后缀改成 `amd64`。构建器自动获取锁定资源，输出架构镜像与构建报告。可选 `node --import tsx test/acceptance/accept-browser-soak.ts --run --capacity=1 --hold-seconds=300` 做持续负载与排队检查。这些测试有不同隔离断言，不能用普通页面打开测试替代。

完整验收创建独立 Compose 项目，使用模拟模型、TLS 邮件服务和访问公网测试页的 Chrome。默认占用 3350 / 3351；测试机需 OpenSSL 和约 6 GiB 可用内存。它不读取站点密钥，结束时清理 Docker 资源，诊断留在私密工作目录，只有汇总报告用于发行。

`scripts/build/bundle-tools.mjs` 是打包器内部的 esbuild 入口，无需单独调用。准备、下载、构建、发布和打包工具分别对应 npm 命令，保留职责分离。完整发行流程见 [发布](RELEASING.md)。

## 文档维护

指南统一放在 `docs/`，根 README 只做入口。操作步骤使用当前 Node CLI 和 npm 参数；历史记录由 Git 保存，当前验收和未完成事项只维护 [STATUS.md](STATUS.md)。不要将服务器特有路径、迁移过程或已废弃命令混入通用安装流程。

部署、配置、运维文档同时进入发行目录，修改相对链接时检查源码和包内两种位置。文件搬迁还需核对 `scripts/build/package-compose.mjs` 的白名单、Docker COPY 和 `.dockerignore`；修改镜像输入后必须重新构建对应发行镜像。

## Docker-only Compose 入口

`deploy/compose/compose.template.yaml` 定义独立的命名卷部署，`deploy/agent/app/compose-init.mjs` 在容器内校验输入、生成并持久化密钥、渲染网关配置。`src/compose-service.ts` 自动读取容器内 Docker socket 的组，并在运行浏览器服务前降权至 UID 1000。`deploy/compose/operations.mjs` 随 Agent 镜像打包，用同一入口提供一次性 `ops` 管理任务和每日 `backup` 服务；Docker CLI、Compose 插件及其许可证随镜像提供。全部部署使用此模板，不再维护宿主 Node 安装器。

维护者在包含新入口的镜像构建完成后生成部署文件，并执行隔离验收：

```bash
npm run package:compose -- --release /absolute/release.json --output output/compose
npm run accept:compose -- --release /absolute/release.json --work output/compose-test
```

测试本地镜像时两条命令可加 `--development`，正式发行必须使用固定 digest。验收使用 3350 / 3351 端口，可用 `--port` 指定主端口，恢复实例使用下一端口；不要占用当前站点端口。部署子进程的 PATH 仅包含 Docker，没有 Node/npm。

验收使用模拟模型和本地 TLS 邮件服务，包含账号隔离、额度与预算、排队、登出清理和密码找回检查；覆盖未配置拒绝启动、真实 Chrome 接管继续、重复启动和错误配置恢复；还验证独立配置目录、账号创建/重置、活动任务拒绝备份、停写备份与数据保留、升级失败完整回退、强杀备份后恢复、新项目恢复及损坏备份拒绝、每日备份轮转和同日重启去重。启用备份后继续检查正常升级，以及备份服务启动失败时完整回退数据和调度服务。结束时包含全部 profiles 清理容器、网络及测试数据卷；汇总报告必须同时为 `passed: true`、`cleanup.passed: true`、`cleanup.remaining: 0`。

用户无需运行这些维护者脚本，也无需宿主 Node.js。发布 CI 在两个原生平台上执行此验收，通过后将部署文件、MIT 许可证、指南和验收报告加入 Release。
