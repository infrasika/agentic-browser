# 预装扩展运行镜像原型

已在 Ubuntu / Docker、linux/amd64 验证。镜像包含 Chrome、远程桌面依赖和两个未修改的官方 CRX 包；不包含网站登录数据。每个新 Profile 从镜像本地安装扩展，安装不需要连接商店。

```sh
npm run runtime:build
npm run test:extensions
```

第一次获取包需要网络；之后优先使用 `output/runtime/packages/` 缓存。`assets.lock.json` 分别固定 amd64/arm64 Chrome 155.0.8059.79、TransGate 0.5.5、Schema Validator 0.1.3 的摘要。上游内容变化时构建会失败，不会静默更新。审阅更新后才运行 `python3 scripts/fetch-runtime-assets.py --refresh-lock`，并重跑验收。官方更新端点不保证长期提供旧版本；锁文件并不能替代部署者保存的原始包缓存。

`test:extensions` 在全新、断网、只读根文件系统的容器里执行，临时数据位于 tmpfs，退出删除容器。只挂载测试截图输出目录，不挂载宿主机用户数据、Docker socket 或真实 Profile。测试包括：

- 两个扩展的 ID、启用状态和版本；实际界面截图。
- Chrome namespace / PID / network / seccomp 沙箱状态。
- 两个独立 Chrome/Profile 之间的虚构 Cookie 与扩展存储隔离。
- 人工阶段断开 CDP、原生键盘输入、交还后撤销旧 VNC 连接。
- 原版 Schema Validator 打开本地合成数据源、捕获 JSON 接口、显示成功、返回结果，再交还 Agent。夹具使用原版扩展的 Dev Center 消息协议，并按其要求使用字符串类型的断言值。

测试日志位于 `output/runtime/acceptance.log`（若重定向）、`output/runtime/extensions-test.log`；截图位于 `output/runtime/screenshots/`。这些输出不纳入版本库。测试不代表真实 TransGate 证明、外部节点连通性、所有校验失败/取消路径。团队 Runtime 隔离有独立验收记录，见 [Runtime 指南](../docs/RUNTIME.md)。

容器以非 root 运行、移除全部 Linux capabilities，开启 no-new-privileges；未使用 privileged、host network 或关闭 Chrome 沙箱的参数。`chrome-seccomp.json` 基于 Playwright 官方配置，增加允许 `chroot` 系统调用，以便 Chrome 在自己的 user namespace 内建立沙箱；这不会给外层进程授予 CAP_SYS_CHROOT。来源和许可证见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

已接入服务的每 Session 独立 Runtime、出网边界和扩展启动就绪检查。管理员在实例级指定本地镜像，控制进程启动时解析并固定镜像 ID；不允许 Session 传入任意镜像或 Docker 参数。跨版本升级/回退尚未验收，安装与预览版交付见 [自部署指南](../docs/SELF_HOST.md)。Debian 软件源依赖尚未固定到快照；当前构建还不是逐字节可复现发行包。
