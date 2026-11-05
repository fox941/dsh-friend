# 主实例与隔离测试实例

架构 v0.33，实例工具 1.0.0，测试隔离插件 0.1.0。companion-adapter 0.29.0、attention-scheduler 0.2.0 和第三方依赖版本保持不变。

## 数据与运行边界

| 项目 | 主实例 Main | 测试实例 Test |
|---|---|---|
| 角色数据 | `runtime/dev`（沿用原角色） | `runtime/test`（新生成独立身份） |
| 网页 | `http://127.0.0.1:3080` | `http://127.0.0.2:3081` |
| 备份 | `backups/dev` | `backups/test` |
| 会话、长期记忆、自我、情绪、日记、回执、预算 | 原数据继续使用 | 独立存储，不复制主数据 |
| QQ、B站与其他外部操作 | 沿用原配置与权限 | 不复制平台凭据，平台入口及外部工具禁止执行 |
| 夜间整理、注意力与自动浏览 | 原配置 | 初始关闭，可在本地测试记忆和自我状态工具 |
| 模型密钥 | 原凭据文件 | 初始化时仅复制 DeepSeek 密钥到自己的凭据文件 |

使用不同回环地址，是因为浏览器 Cookie 不按端口隔离。启动命令从所属实例的日志取得登录入口，避免主/测试相互挤掉登录态。模型密钥文件独立，首次复制后不自动同步、不从主实例回退；如使用同一付费账号，API 消费仍共用账户余额，本地用量记录分别保存。

共用的是项目源码、根依赖、固定工具和下载缓存。两个 profile 各自安装锁定依赖，不把测试 profile 的 node_modules 联接到主 profile。更新源码后先用测试实例验证，再明确停主实例、更新安装包并重启；更改共享 SDK、Node 或工具链时，两边都要停机。第一版不提供两套独立 SDK 版本并存。

## 日常命令

首次运行 `Setup-Test.cmd`，随后运行 `Start-Test.cmd`。本次部署若已初始化，直接启动即可。

| 操作 | 主实例 | 测试实例 |
|---|---|---|
| 启动 | `Start-Main.cmd` | `Start-Test.cmd` |
| 停止 | `Stop-Main.cmd` | `Stop-Test.cmd` |
| 状态 | `Main-Status.cmd` | `Test-Status.cmd` |
| 重启 | 原 `Restart-Dev.cmd` | `Restart-Test.cmd` |
| 恢复运行保护 | `Recover-Main.cmd` | `Recover-Test.cmd` |
| 停机快照 | `Backup-Main.cmd` | `Backup-Test.cmd` |
| 记忆导出 | 原 `Export-Memory.cmd` | `Export-Test-Memory.cmd` |
| 本地只读诊断 | 原 `Diagnostics.cmd` | `Test-Diagnostics.cmd` |

旧的 `Start-Dev.cmd`、`Stop-Dev.cmd`、`Runtime-Status.cmd` 等入口仍明确指向主实例，`dev` 目录没有改名。PowerShell 入口默认 Main，使用 `-Instance Test` 才切到测试；直接使用 Node CLI 时设置 `AI_FRIEND_INSTANCE=test`，省略时为 main，拼写错误会报错。每个启动器显式覆盖继承的实例选择，不沿用上一个终端的选择。

测试启动会检查独立身份、配置摘要、隔离插件摘要、平台凭据缺席及数据目录没有联接；运行中的健康检查也验证这些条件。配置被手动改动后不会继续执行模型工具，停止后通过 `Setup-Test.cmd` 重新生成安全配置。重复初始化保留测试身份、会话和记忆，不复制主角色。

## 工具拦截如何工作

`plugins/test-isolation` 是项目内的 DSH 插件，通过测试 profile 的 file URL 加载，不安装进主实例。它使用 SDK 的 `tools.guard` 在真实工具执行管线检查所有调用，包括嵌套分派。仅允许明确列出的本地记忆、自我、情绪和只读诊断工具；终端、任意文件、浏览器、网络、QQ/B站、自动活动控制及未来未知工具默认拒绝。

拦截规则独立于提示词，模型不能通过“请忽略限制”解除。提示词只说明当前处于测试环境，不规定性格、心情或回复优先级。后台模块默认关闭；已有内部记忆写入与审核仍只操作测试路径。

这是应用层的实例路由和权限隔离，不是操作系统沙箱。开发者、第三方可信插件代码、管理页面或手动修改配置仍有本机文件权限，因此不要把不可信代码当作安全插件安装。源码和工具链共用，直接改它们会影响后续启动的实例。

## 测试备份和恢复

1. 运行 `Stop-Test.cmd`，再运行 `Backup-Test.cmd`；主实例可继续运行。
2. 快照写入 `backups/test/<时间>`，包含测试身份、记忆、会话及 profile 元数据，排除可重装依赖和运行控制凭据。
3. 运行 `Restore-Test.cmd`，输入上述快照目录，或调用 `scripts/Test-Instance.ps1 -Action Restore -Snapshot <目录>`。
4. 恢复前校验文件哈希、测试标签、原路径和身份，拒绝主实例快照。当前已停止的测试数据另存一致性快照并移至 `backups/test/retired-*`，不直接删除。
5. 恢复冻结依赖并核验后保持停止，手动运行 `Start-Test.cmd`。安装失败时用同一快照重试；未完成的恢复会阻止测试启动。

测试快照只支持当前项目原路径恢复，未提供跨路径重绑定。主角色恢复仍使用完整迁移工具，不通过测试恢复入口。`Pack-Migration.cmd` 仍仅打包 `runtime/dev`，不会把 `runtime/test` 合入主角色；测试备份如需保存应另行携带。

## 公司开发与家用运行

先使用《家用电脑迁移指南》把现有主角色迁到家里，迁移成功后公司主实例保持停止，公司仅运行 Test。代码通过 Git 或版本包传递，`runtime`、`backups`、密钥和平台凭据不进入 Git。测试记忆不合并回家里的主角色，部署代码也不替换家里当前的 runtime。

目前同路径完整迁移和隔离实例都已实现，跨两台真实电脑的首次启动验收仍需在家用电脑进行；Windows 开机自启、跨路径恢复和自动发布尚未实现。

## 本次验证

2026-10-30：最终部署目录运行 848 项回归，全部通过。独立 DSH 实测覆盖网页认证、Native 写入、DeepSeek 对话、直接及嵌套工具拒绝（被拦工具执行次数为 0）。本机 Test 实测完成启动、健康状态下 Recover 不重启、Main 运行时的 Test 停机备份、恢复快照、恢复后记忆可用及再次启动，最后保持 Test 停止；Main 的 PID 和身份均未改变。未发送真实 QQ／B站消息。

另修复了 Windows PowerShell 按旧编码解析中文健康 JSON 导致首次启动失败的问题，入口统一使用 UTF-8，并加入了对应回归。验证记录保存在 `.work/instance-isolation-release.json` 和 `.work/instance-isolation-integration.json`。
