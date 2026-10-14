# 发布固定版本镜像

镜像仓库为 `ghcr.io/infrasika/agentic-browser-controller` 和 `ghcr.io/infrasika/agentic-browser-runtime`。代码仓库的可见性不随镜像发布改变。

按用户已确认的发布约定，源码仓库保持 Private，仅上述两个 GHCR 镜像包为 Public；Release 部署包由有仓库权限的管理员下载分发。

首个预览版为 [v0.1.0-preview.1](https://github.com/infrasika/agentic-browser/releases/tag/v0.1.0-preview.1)，[双架构 Actions 验收与发布](https://github.com/infrasika/agentic-browser/actions/runs/38508756846) 已通过，来源提交 `737c2f1793c66733faf9f39fc6053022e2e9ca4e`。两个 GHCR 包已公开，两个镜像、两个架构的匿名拉取和独立目录部署复验均通过。当前默认摘要记录在 `deploy/release.env`，后续公开验证记录见 `deploy/releases/v0.1.0-preview.1-public-verification.json` 和 Release 的 `PUBLIC-VERIFICATION.json`。

## 触发发布

先将审核完成的代码推送到 `main`。在 GitHub 仓库的 **Actions → Publish verified browser images → Run workflow** 中选择 `main`，填写从未使用过的版本号，例如 `v0.1.0-preview.2`。也可以使用已授权的 GitHub CLI：

```sh
gh workflow run publish-images.yml --ref main -f version=v0.1.0-preview.2
```

无需在 Ubuntu 主机执行 `docker login`，也不需要配置个人 GHCR token secret。工作流使用限于当前作业的 `GITHUB_TOKEN` 和 `packages: write` 权限；创建 Release 的作业另有 `contents: write`。GitHub 账户需允许 Actions 和原生 ARM runner 运行，私有仓库适用其 Actions 配额及计费规则。

## 发布门槛与输出

两个原生 runner 分别构建 `linux/amd64`、`linux/arm64` 控制器和浏览器，不使用 QEMU 跳过实际 ARM 执行。每边执行类型/单元检查、Chrome 与两个扩展的摘要校验、扩展实际操作及 Chrome 沙箱检查、团队隔离/恢复、五浏览器容量和人工交接验收。只有两个架构都通过，才创建共同的版本标签和部署包。

中间镜像使用 `build-<完整提交>-<架构>` 标签；最终发布使用这次验收后记录的 digest，不依赖标签再次解析构建结果。已存在的发行版本会被拒绝，认证或网络失败也不会被当作“版本尚不存在”。若发布阶段部分成功，应使用新的版本号重新运行，不覆盖已有版本。

Release 附件：

- `agentic-browser-deploy.tar.gz`：配置、脚本、说明和第三方声明，包含 `deploy/release.env` 固定两个镜像索引 digest。
- `RELEASE.json`：提交、平台、镜像摘要与 Chrome/扩展锁定信息。
- `SHA256SUMS`：上述两个文件的校验和。

Actions 另保留架构摘要与验收证据。源仓库私有时，其 Release 附件也不会自动公开；管理员可分发部署包，或从具有仓库权限的账户下载。镜像为 Linux 容器；M 系列 Mac 通过 Docker Desktop 使用 arm64，并仍需 Mac 实机验收。

## 首次公开与部署复验

GHCR 新包默认为 private。首次发布后，维护者应分别打开两个包的 **Package settings → Change visibility → Public**；只修改这两个镜像包，不修改源代码仓库。然后使用没有 registry 凭据的 Docker 配置验证匿名拉取两个镜像及两个平台，记录结果。

`RELEASE.json` 初始 `publicPullVerified: false` 表示构建发布作业未独立证明匿名下载可用。公开完成后另外记录验收时间和拉取 digest，不用覆盖已发布附件或其校验和。

最后在干净目录解压部署包，按 [自部署指南](SELF_HOST.md) 执行拉取、启动、doctor、虚构成员和浏览器交接；不要复制开发机的 `.env` 或真实登录数据。验收通过后记录版本和 Actions 链接到 [进度](PROGRESS.md)。

## 锁定文件与升级

基础镜像、npm 依赖、Chrome 和扩展有固定引用或摘要。Chrome/CRX 官方下载端点可能更新；缓存和下载文件必须满足 `runtime/assets.lock.json`，不允许在 CI 内自动刷新锁。升级 Chrome 时显式刷新两个架构并检查相同版本，审核扩展权限，再完整验收。

发行部署通过 digest 固定相同镜像，不承诺浮动 Debian apt 源下逐字节相同的源码重建。发布不能包含个人 Profile、环境凭据或真实账号测试数据。
