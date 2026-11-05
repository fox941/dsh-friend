当前实现（2026-10-28）：companion-adapter 0.14.0 / 架构 v0.16。Web、QQ、B站交流、浏览、回忆/反思和整理候选共用持久意图与DeepSeek行为选择；收到消息不再默认抢占。事件回合日上限仍为0（不限），平台轮询与探索额度独立。详见[全局行为实现](21-autonomous-attention.md)。

# 本地运行、备份与当前能力

更新：2026-10-27。第一阶段已完成：DSH Web、DeepSeek、Mnemon 和 Native 的本地记忆链路；已实现第一版自我成长、自然语言情绪及手动只读整理预演；明确请求后的可恢复提案应用已实现；已实现受控夜间增量整理及遗漏补做；QQ主用户文字通道、B站只读活动与外部事件内部处理已接入。

## 直接使用

1. 双击项目根目录的 `Start-Dev.cmd`，浏览器会打开本地界面。重复启动会连接现有实例。
2. 新建对话，使用默认的“陪伴（空白起点）”模式。个人描述为空，没有预填名字、性格、恋爱关系或情绪数值；模型训练带来的倾向仍然存在。
3. 可以聊天，并明确要求记录值得长期保留的信息；在 Mnemon 页面查看实际条目。插件目前依靠模型选择记忆工具，不保证每句话自动记住。
4. 双击 `Stop-Dev.cmd` 正常停止服务。关闭浏览器不会停止后台服务。

网页入口是 `http://127.0.0.1:3080`。DSH 启用了本地鉴权，启动脚本会打开带启动令牌的地址；直接手输干净地址可能先得到 401。启动令牌不等于 DeepSeek 密钥。

## 固定版本与模型

| 组件 | 当前版本 |
|---|---|
| 项目专用 Node | 24.22.1，Windows x64 |
| pnpm | 11.28.5 |
| DSH | 0.2.1-rc.3，官方 npm 发布包 |
| dsh-mnemon | 0.5.36 |
| Mnemon Native | 0.2.13 |
| 模型路由 | deepseek-official / deepseek-flash |

官方模型目录中 `deepseek-flash` 显示为 DeepSeek-V4.1-Flash。`deepseek-v4.1-flash` 已实际请求验证，官方 API 返回不支持该模型 ID；已根据用户确认改用 `deepseek-flash`。

工具链在 `.tools`，不会修改全局 Node。Native 可执行文件由锁定的官方 npm 包复制到 `.tools/mnemon-0.2.13/mnemon.exe`。上游源码快照保留在 `upstream/deepseek-harness`，本阶段未修改或构建它。

## 数据在哪里

```text
runtime/dev/
  credentials.local.json        本地模型凭据，不进 Git
  bootstrap.json                实例初始化版本与路径
  dsh-home/
    profiles/web/               插件配置、安装记录与锁文件
    sessions/                   DSH 原始会话、工具调用等记录
  memory/
    runtime/                    memories.json 与 USER/MEMORY 展示投影
    documents/                  使用文档能力后按需生成
    data/default/mnemon.db      “陪伴记忆”长期空间
    state/                      插件控制状态，按需生成
  companion/companion.sqlite    个人插件自我状态、成长审核、历史和纠错日志
  workspace/                    该实例的工作目录
  exports/                      执行导出后生成
  logs/                         本地启动诊断
```

这些是实际开发实例的数据。`runtime/prod` 没有创建；启动器目前只管理 dev，不会部署或替换家中的长期实例。当前 companion 数据库已保存唯一角色标识、第一版自我状态、成长提案、审核、历史和纠错。自我状态通过 DSH 提示上下文读取；Mnemon 自定义 Source 尚未开发。

本阶段关闭了 Idle Review、技能自进化、Git 同步和 Native 自动条目裁剪。保留 Mnemon 的基础工具和容量维护；常驻资料达到容量后仍可能触发整理，需要与后续统一后台策略继续衔接。

未配置独立嵌入服务，目前使用 Native 的关键词与图结构检索。一次中文召回成功不能代表改述、反讽、矛盾和多年记忆质量已通过验收。

## 备份和导出

先运行 `Stop-Dev.cmd`，等待成功，再运行：

- `Backup-Dev.cmd`：生成 `backups/dev/<UTC时间>/runtime` 和校验清单。
- `Export-Memory.cmd`：先生成同样的离线快照，再输出 `runtime/dev/exports/<UTC时间>`。

运行中的实例或项目内其他 Node/Native 命令会使包装脚本拒绝备份。还应关闭自行启动的外部写者。快照保留实例状态、会话、凭据、Native 数据库及实际存在的 WAL 等文件，排除可重装的 profile `node_modules`、控制管道记录和已派生的 exports；包版本与 profile 锁文件保留。备份包含密钥和私人聊天，不要公开上传。

导出包包括 Runtime JSON、Documents（实际存在时）、Native 各表原始行、关系与现存元数据，以及便于检查的 `memories.jsonl`。它不是其他记忆产品的现成导入包；目标后端转换、字段对应与检索重建仍需开发。Runtime 没有原生稳定业务 ID，导出的 Runtime ID 由内容派生，不能当作人格事件 ID。

已对真实实例完成校验和检查和独立目录的离线恢复核验，SQLite 完整性为 ok，关键测试记忆存在。没有宣称跨机器启动、跨后端转换或长期人格一致性已验证。

新增的 `companion` 目录和 profile `.friend-packages` 也会被完整备份包含。删除或只复制 `memory` 会丢失个人插件的纠错历史。

## 另一台电脑

1. 带走项目代码、根目录锁文件和需要迁移的离线数据快照；全局 Node、`node_modules` 和缓存不必复制。
2. 在 Windows x64 目标机准备相同目录，运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup.ps1`，安装固定版工具和依赖。
3. 停止实例，在独立目录中恢复并核对数据。当前启动器仅支持 dev；首次迁移先使用相同路径，变化路径时还需要显式重绑配置和会话工作目录。
4. 按保存的 profile package/lock 文件恢复依赖，验证旧会话、关键记忆、凭据和后台设置，再投入使用。不要将公司 dev 目录覆盖已有家用 prod。

`Setup.ps1` 可重复执行，会保留已经初始化的实例设置。它不会自动搬迁旧数据或重写旧会话中的路径，也不会覆盖已经存在的运行实例。

## 本轮验收

- 真实 DeepSeek 对话成功，模型目录和实际请求均使用 `deepseek-flash`。
- 模型通过 Mnemon 工具完成 Runtime 写入和 Native 长期写入。
- 清除热记忆中的测试代号后，新会话实际调用 `mnemon_recall`，正确找回长期测试记忆。
- 正常停机、再次启动、旧会话和记忆恢复通过。
- 独立测试库导入 1002 条旧记录，自动裁剪数为 0；精确重复写入被跳过。
- 备份/导出的 3 项行为测试通过，覆盖篡改检测、运行中拒绝备份、路径越界，以及纠错历史、软删除和关系保留。
- 真实实例快照与离线恢复通过；验收记忆已从活跃记忆中移除，测试对话有明确标题，已建立新的空白会话。

已安装外部陪伴适配 0.6.0，支持纠错和第一版 [自我成长](08-growth.md)。新增 [只读增量整理预演](10-memory-preview.md)，已接 [可恢复提案应用](11-memory-application.md)，已接 [夜间整理](12-nightly-memory.md)，支持聊天中查询、暂停、恢复及排队运行一次。新增[记忆保护及停机撤销](13-memory-protection.md)；QQ、B 站、抖音尚未接入。


## 全局行为状态查看

运行根目录的 `Attention-Status.cmd`，或 `node scripts/attention.mjs`，只读查看未完意图、当前运行事项、延后条件与选择结果，不向AI发送消息。平台事件入库后还会由同一角色选择是否关注；没有回复不一定是故障，failed/error状态与dismissed分开。B站仍按原有轮询周期接收，不把技术接收延迟当作模型自主选择。
