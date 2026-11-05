# 同路径迁移包与空目录恢复

2026-10-30；迁移工具协议 v1，架构 v0.32。companion-adapter 仍为 0.29.0，attention-scheduler 仍为 0.2.0。本轮是项目运维脚本，不修改第三方插件、角色人格、记忆策略或模型决策。

## 用户操作

公司电脑先退出本项目的 NapCat/AI QQ 和其他维护命令，再运行 `Pack-Migration.cmd`。命令通过原统一入口优雅停止 Host 和运行保护，检查数据库写者、平台端口、原身份、撤销状态、插件包与源码版本，然后生成 ZIP 和 SHA256 文件。生成后公司实例保持停止；打包失败时也不会自动重新运行角色。

输出默认位于 `releases/migration/`。工具保留完整解压目录及 ZIP，日志只输出阶段、数量和路径，不输出密钥或聊天正文。迁移包包括私密数据，需私下传输，不上传 Git。

家里先把 ZIP **完整解压到目标目录之外**，例如 `E:\迁移资料\本次迁移`。不要在压缩包内直接运行，也不要先手动复制程序到 `D:\ai friend`。解压根目录有：

- `Verify-Migration.cmd`：校验整个包的清单、字节数、哈希、快照、SQLite、身份和插件版本。
- `Restore-Migration.cmd`：恢复到清单记录的原路径，并运行恢复后项目的 Setup.ps1 -RestoreExisting 准备依赖。
- `migration.json`：迁移协议、原根目录、版本、身份和完整文件清单。
- `project/`：程序、插件源码、锁文件与 `.tools`。
- `snapshot/`：完整停机角色快照和原快照 manifest。

恢复成功后保持停止，不会替用户登录、发消息或自动开放平台。安装本机 QQ，使用 AI QQ 3197399707 扫码；检查 B站同一 AI 账号及必要网页会话；核对身份和记忆后运行 `Start-Dev.cmd`。媒体/ASR 仍需在目标电脑按实际能力验收。

## 范围

首版只支持 Windows x64、项目 Node v24.22.1 和清单记录的原安装路径。当前正常实例仍为 `D:\ai friend\runtime\dev`，不自动改成 prod，也不转换旧会话或 Python 环境中的绝对路径。

根目录的三个入口也可以使用 scripts/Migration.ps1；Verify/Restore 会询问完整解压包目录。命令行可以显式指定 BundleRoot；空目录检查、版本检查与同路径限制不会因为参数而绕过。

```powershell
# 生成：会先停止源实例；请先关闭 NapCat/AI QQ。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Migration.ps1 -Action Pack

# 在解压目录中校验和恢复，Target 默认取清单中的原根目录。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\project\scripts\Migration.ps1 -Action Verify -BundleRoot 'E:\迁移资料\本次迁移'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\project\scripts\Migration.ps1 -Action Restore -BundleRoot 'E:\迁移资料\本次迁移'
```

## 打包一致性

复用原完整快照和 host.lock 离线维护锁；项目另持有 `.migration.lock`。通过本项目 Host/运行保护入口启动时会检查迁移锁，防止后台恢复在复制中途重新启动。租约也会在维护期间重新检查 Host/保护进程。

清单包含程序、工具及完整快照的每个普通文件；不跟随目录联接或符号链接。项目 node_modules、Git、上游参考源码和 .work 不携带；`.tools` 自带的 Node/npm/pnpm/Python 运行依赖属于工具，会携带。DSH profile 的 node_modules 继续由原快照规则排除，`.friend-packages` 安装包及记录保留。

复制和压缩完成后重新核对整个源文件集合及哈希，发现新增、删除或改动就不发布成功包。ZIP 使用 Windows/.NET ZipArchive 流式压缩，支持中文文件名，不使用 Compress-Archive 的单文件读入方式，也不引入新的归档框架或机器人服务。最终 ZIP 附 SHA256 便于传输检查；清单校验保证完整性，不等于发布者签名，仍应只运行可信来源的包。

运行数据库以 SQLite 只读方式做 quick_check、表数量和原身份核对；完整文件哈希还覆盖会话、来源、附件、记忆、状态、关系、快照及平台操作回执。工具不会把单独 mnemon.db 或“记忆文本导出”当作完整角色。

## 恢复和重试

目标必须不存在、为空，或是带有同一迁移 ID、清单摘要和原身份的本次中断恢复。已有项目、另一份包或另一个角色均拒绝覆盖。源解压包必须在目标目录之外；恢复从包中的代码执行，不依赖目标机器已安装全局 Node。

复制后逐文件核对，先确认原身份、SQLite 表数量及版本，再运行 Setup 的 RestoreExisting 模式。这个模式只按锁文件重装依赖，保留原配置和 `.friend-packages`，不执行普通 Setup 中的初始化／补齐默认配置流程；原角色或 bootstrap 缺失就拒绝继续。安装输出保存在目标 `.work/migration-setup.log`；安装后再次检查程序及关键角色文件、数据库和实际安装的插件字节与版本。成功才把 `.migration-restore.json` 标为 ready。

失败后保留原迁移包，在同一台目标电脑重新运行相同 Restore 入口。已经存在且哈希一致的文件可复用，不覆盖变化后的数据；使用本包 ID 标记的临时拷贝文件可以重新复制。安装未完成时，Host/保护入口会阻止启动，不新建身份。已恢复实例一旦产生新记忆或会话，不能再用旧包覆盖。

保护仅覆盖本项目入口及检查到的本机写者。用户需关闭其他直接操作数据库、原生 CLI 或手工启动 DSH 的进程，不应在迁移过程中编辑程序或数据。

## 冷启动停止保护

隔离演练发现：Host 控制通道可能先于大型 DSH 模块图完成加载；旧实现若在这一阶段收到停止信号，后续仍可能进入 runCli。现在在导入结束后再次检查 stopping，已接到停止请求就不进入 DSH。对应真实子进程测试验证没有启动哨兵文件，正常完成退出。

## 验收边界

单元和故障测试使用隔离角色、临时 SQLite 和受控进程，覆盖篡改、额外文件、路径越界、Windows 特殊路径、联接、活动写者、旧版本不匹配、已有目标、失败重试和部分恢复阻止启动。

另做真实 DSH、Native、DeepSeek 的独立 ZIP 解压/依赖安装/原路径恢复/旧会话续接演练；QQ/B站在演练中关闭，不发送平台消息，不写正式角色。测试 SDK 和原生工具实际执行，缓存复用情况在报告中标注。模拟未完成活动明确标为夹具，不冒充真实观看。

本机隔离恢复不代表已经完成家用电脑实测。新机器的 QQ、B站验证、媒体/ASR CPU 兼容性和多日运行仍需实际验收。Main/Test 隔离及代码更新已分别在[实例隔离](44-instance-isolation.md)和[代码更新](45-code-updates.md)交付；跨路径迁移、开机自启及跨记忆后端转换仍属后续工作。

迁移包覆盖本项目程序、工具及 runtime 内的数据；机器上另行安装的 QQ、浏览器和项目外部文件不会自动搬迁。若历史资料引用项目之外的原文件，需另行核对其可用性。

## 本轮部署结果

- 候选和实际部署版本均通过 832 项完整回归，迁移专项 30 项。
- 真实 ZIP 解压、Node/pnpm/Native 工具、依赖重装和实际安装插件文件核对通过；演练复用了已有包缓存，没有把缓存命中当作目标电脑离线安装保证。
- 恢复前后 UUID 和数据库表数量一致；原真实 DSH 会话继续回答迁移前的临时代号。受控未完成活动保留原 ID，启动后按原逻辑标为 interrupted，没有重放；它是明确标注的模拟活动，不代表真实视频观看。
- 演练关闭 QQ/B站，未向真实平台发消息，也未写正式角色记忆。演练工具集包含 Node、包管理器和 Native；NapCat/媒体/ASR 的跨电脑登录与硬件兼容性仍待家用机器验收。
- 当前正式 Host 沿用原进程和身份，陪伴插件 0.29.0、调度插件 0.2.0 的源码和安装文件保持不变；本轮没有为正在运行的正式角色生成迁移包。
- 原脚本备份位于 backups/code/migration-1.0.0-2026-10-30T06-20-09-366Z，仅用于代码回退，不是角色数据快照。

发布和演练结果见 `.work/migration-release.json`、`.work/migration-roundtrip.json`；用户操作见根目录《家用电脑迁移指南.md》。
