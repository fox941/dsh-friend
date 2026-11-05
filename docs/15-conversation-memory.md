当前验收（2026-10-28）：插件 0.9.0 / 架构 v0.11，主用户与 AI QQ 已在本地绑定；真实 AI 账号登录、主用户私聊、DeepSeek 回复、OneBot 发送回执及用户收到回复均已验证。安装后232项测试通过；隔离真实模型/本机协议验收13项通过。首版仅文字私聊；不代表长期在线或多媒体能力已验证。

当前插件 0.9.0 / 架构 v0.11：已实现主用户 QQ 文字通道、可核验原话、持久收发及与 Web 共用的记忆/成长/情绪/夜间整理。复用 dsh-onebot 的传输源码，未安装其完整插件。已通过本机协议模拟与真实 DeepSeek 隔离验收，真实 QQ 登录和单轮私聊收发已通过；更早阶段说明保留为历史。当前边界及入口以 [16-qq.md](16-qq.md) 为准，下文旧阶段描述保留为历史。

# 日常聊天的统一记忆写入

更新：2026-10-28。companion-adapter 0.8.0，架构 v0.10。适用于本实例“陪伴（空白起点）”预设内的直接主用户交流。DSH Web 已接入；QQ 尚未连接和绑定身份，之后可以复用同一管理层。

## 使用与行为

照常聊天。模型发现值得保留的明确用户事实、可重复使用的偏好或今后约定时，可以直接提案，无需先预演、无需再次征求批准。每句话不必记忆，无提案不增加审核请求。自我描述、兴趣、性格与情绪继续使用原来的独立提案工具。

```text
DSH 原始主用户消息
  → 模型选择是否保存，或先读取旧条目
  → friend_memory_write（每批1–4项）
  → 核验身份、原话、完整来源和旧版本
  → 一次独立无工具审核：应用 / 无需改动 / 暂缓
  → 复用应用计划、Runtime CAS、Native 纠错与软删除
  → 必要快照、逐步意图、读回核验、变更回执
```

同一消息最多两批，失败的审核也计持久预算。支持先读取再提案，不将普通读取自动锁成整个回合只读。预演与正式应用工具已有的回合保护仍有效，不能在只读预演后偷偷写入。

## 操作入口

| 工具 | 负责什么 |
|---|---|
| `friend_memory_read` | 返回有界 Runtime、相关 Native 候选、指定 Native 原件和当前自我引用；提供 `id`、`text`、`version` |
| `friend_memory_write` | `add / replace / remove`；目标为 `user / memory / long_term`；每项须带本轮逐字原话和理由 |
| `friend_memory_write_retry` | 用户明确要求后继续指定失败批次的固定计划，不重新调用审核模型 |
| `friend_memory_apply_read` | 复用原入口读取日常批次回执、当前核验与待处理步骤 |
| `friend_memory_changes` | 复用原入口查看原话、旧值、新值、关联状态、快照与离线撤销条件 |

更正或撤回必须先读取旧条目，传 `referenceId`、`expectedContent`、`expectedVersion`。不能按模糊片段覆盖一组记忆。已由 `mnemon_recall` 查到的 UUID，可转成 `native:空间ID:UUID`，用 `references` 精确读取。

`target=user` 只存主用户本人的资料/偏好；`memory` 保存有复用价值的当前约定；`long_term` 保存有明确持久价值的真实经历或明确要求长期保留的事实。模型的推测、自己的兴趣、别人说的话不能直接变成用户画像。

替换后的正文必须保留未被更改的信息。已知完全相同的 Runtime / Native 旧副本由程序同步更正或撤回，至多8步；不把所有相似内容自动当作同一事实。审核可以让确实依赖旧事实的自我状态进入 `needs_review`，继而暂停已有的个人提示和情绪依赖；不直接改写性格、不增加独立证据。

## 来源、去重与旧事实防复活

当前来源包含渠道标记 `dsh-direct`、主用户标记、会话/消息/事件序号、时间、原文摘要和完整的有界原话；最近前文只用于消歧。完整当前消息超过10000字符或含疑似凭据时拒绝复制到写入记录，不截掉否定和条件后继续保存。子代理、派生/注入消息、其他 principal、种子会话、其他预设及其他工作区不接受。

引用、假设、否定、未来生效条件和“不要记录”由独立请求结合整段原文核对。单独请求仍使用同一个 DeepSeek 模型，不能保证语义永远正确。

完全相同且已经存在的新增不再调用审核、不生成快照。语义改写由审核比较已读候选。读取、复述和整理报告不会因此成为新的独立证据。

更正与撤回记录还是旧事实的退出依据。公共应用流程提交前按已应用历史中的旧全文核对：更早的原始交流不能重新写回已作废的**完全相同文本**，夜间整理也受此检查；仅有更晚的真实主用户依据才可恢复。撤销成功的批次不继续产生退出限制。此机制复用 `apply_*` 历史和索引，不另建长期记忆库；不承诺识别所有语义改写的旧事实。

## 分级保护与恢复

| 本批动作 | 写前保护 |
|---|---|
| 不写入、重复、暂缓 | 不创建快照 |
| 日常仅新增 Runtime 条目 | `runtime_append`：Runtime 一致前像、自我版本引用；意图、原话和回执留在 companion.sqlite；不每次复制整个 companion/Native |
| 纠错、撤回、Native 新增或关联自我复核 | `full`：沿用相关 Native 全库/图、Runtime 与 companion 一致性快照 |

备份核验失败就暂停写入，不能换旧工具绕过。跨库不是原子事务，`partial / cancelled / interrupted` 可能已经写入部分步骤；未知结果先核对再继续。宿主启动不会独立恢复由应用批次拥有的 Native 纠错，避免绕过该批快照与检查点。

普通聊天无须报告技术字段。只有 `completed` 且确有应用、当前读回通过，才确认保存完成。`completed + applied=false` 表示无需改动；额度不足、`deferred / stale / busy / backup_blocked` 均不能说已保存。

查看批次后可沿用 `Stop-Dev.cmd → Undo-Memory.cmd 应用UUID → Start-Dev.cmd`。撤销仍按原有版本、完整性和 Native 全库指纹保守检查；有后续相关修改、自我变化、无法归因的 Native 写入等会拒绝覆盖。原始聊天、审计和保护副本继续保留，`remove` 是退出正常召回，不是擦除所有历史或备份。

## 配置、范围与迁移

根插件 `config.conversationMemory`：

```json
{"enabled":true,"dailyCallLimit":40,"timeoutMs":45000,"maxTokens":6144}
```

范围分别为 `dailyCallLimit: 0–200`、`timeoutMs: 1000–60000`、`maxTokens: 1024–8192`。预算按上海日期保存在 `apply_conversation_budget`，与夜间/手动应用预算分开，重启不清零。旧 `apply_*` 表增量复用，不重置原数据。

陪伴预设通过 DSH 的公开 `tools.restrict / tools.guard` 隐藏并拦截直接 Mnemon 写入及通用 View Action，也拦截 PTC 内部转调。原有召回和检索保留。Documents 写入、建/合并空间和图连边尚未纳入本流程，因此在陪伴模型的工具路径中一并限制，不能作为绕过入口。管理页与外部 CLI 仍可直接操作，不宣称已全局接管所有入口；其他预设不因这项预设内限制而统一接管。关闭日常写入开关不会自动开放旧写入口。

代码仍在 `plugins/companion-adapter`；事实仍在原 Runtime / Native，审计和配置仍在完整的 `runtime/dev`。不用另迁一套数据库。跨机器仍须停机迁移整个实例、代码、锁文件和 `.friend-packages`，重新安装匹配依赖，并按旧部署说明重绑路径。

## 复用与验收

复用固定版 Mnemon Runtime 的公开 factory/manage、maintenance-plan 与带 revision 的 compact-and-mutate；Native 沿用公开 CLI。没有修改 DSH、Mnemon 或安装目录源码，也没有增加运行依赖、数据库服务或向量服务。统一 CRUD 接口参考 [LangMem 的管理工具](https://langchain-ai.github.io/langmem/reference/tools/)，扩展边界遵循 [Mnemon 公开扩展接口](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/development/extensions.md)；没有引入 LangGraph。

工程测试与真实模型验收使用隔离的虚构资料，覆盖来源与引用、重复、版本冲突、跨层纠错/撤回、旧事实防复活、写前失败、回执丢失、共享并发门、预算、变更查看及离线撤销。真实模型脚本在 `tests/conversation/suite.mjs`，需设置 `AI_FRIEND_RUN_MODEL_TESTS=1`，使用实际 API 额度。结果与安装摘要记录在 `verification.json`，不能把小样本功能验收当成长期语义正确率保证。

后续重点是扩大中文语义对照资料集，再接 QQ 主用户绑定；独立冷归档、自动遗忘、其他 Provider 的纠错/保护适配和跨电脑启动验收仍待开展。
