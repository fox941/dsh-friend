# 视频采样在线配置 0.7.0

工作台新增四项受控视频设置：单窗5–120秒、每批1–3窗、普通观察每窗1–6张、连续观看每窗4–24张。保存后无需重启，继承实例原配置、只覆盖明确修改的字段；日额度、超时、证据容量和原人格记忆保持原机制。

新参数用于后续批次；批次在准入时取得参数快照，观察检查点也保存同一快照。运行中修改、暂停或进程恢复不改变这批已开始的窗口计划或采样数；连续任务的下一批读取最新设置。设置、版本与管理回执复用原 companion.sqlite，不建立新的数据库。详见项目 docs/video-settings.md。

# DSH 内的 B站工作台 0.6.0

在 DSH 左侧提供「B站工作台」，包含总览、观看任务、收件与回应、账号操作和设置。页面复用原 companion.sqlite、观察原件和 DSH 图片附件，不建立第二份记忆。连续观看可按版本暂停／恢复；配置仍使用原白名单，修改与回执在同一事务提交。恢复只重新开放调度选择，不强制马上执行。

数据面改用 DSH 已认证的 connection.fetch 精确路由，不再依赖旧 RPC 的 webServer 上下文，也不挂载原始诊断 HTTP 路由。仅 owner 可查看与管理；写操作要求同源和版本核对。页面每20秒只读更新，不运行模型或平台操作；关注列表仅手动读取。静态 Bilibili-Console.cmd 保留。详见项目 docs/bilibili-workbench.md。下方是历史记录。

# 搜索候选的观察历史 0.4.11

搜索及其他选片候选在交给模型前，统一补入实际观察原件、同BV/分P/CID的采样进度和现有待看状态；审计索引也保留这些字段。复用原观察库和推荐流标记，不按关键词预设兴趣、不强制排除旧片，仍由模型选择新内容、合理续看或休息。外部候选不能伪造历史，元数据缺失不等于从未见过，采样覆盖不等于完整理解。详见项目docs/search-observation-history.md。

# 搜索选片的首窗时长契约修复 0.4.10

修复真实QQ后台搜索请求携带durationSeconds=60却因没有预选video而被拒绝的问题。首窗时长适用于搜索、目录和模型选片后的观察，仍受当前windowSeconds上限约束；固定startSeconds仍要求明确视频。显式片段在媒体工具未就绪时拒绝无时间范围的字幕降级。旧失败请求、原额度与角色数据保留；不自动重发、不强制记忆或人格变化。详见项目docs/browse-duration-contract.md。

# @ai-friend/bilibili-tool

# 活动面板与配置受控写通道 0.3.0

新增 `console.js`（快照/HTML/关注列表/写盘/白名单应用）与 `Bilibili-Console.cmd`、`Bilibili-Config.cmd` 入口：静态 HTML 面板汇总今日观看、交流回复、私信与事件、账号操作、点赞/投币/动态回执、配置开关与关注列表；配置表单生成变更请求文件，经 `config-apply` 白名单校验后单事务应用并记 `config-audit.jsonl` 审计。关注列表是唯一新增数据面（AI 账号自身关注关系只读，已对真实账号读取成功）；凭据零出现在页面与审计。详见项目docs/50-bilibili-console.md；下方为历史版本记录。

# 首次拆分 0.1.0–0.2.0

0.2.0：面板只读版 + `./console-offline` 导出。0.1.0：B站功能自 companion-adapter 0.32.x 整体迁入（收件箱、社交回复、账号操作、观看活动、待看续看、视频理解、内容发现、扫码登录、vendor 三包、platforms 的 bili_* 写操作与统一注意力注册条目）。

独立 DSH 插件，承载B站平台功能。由 companion-adapter 拆出；本包不依赖 companion-adapter，不保存人格副本，不另建记忆引擎。

## 负责什么

- 经核验的 OneBot 之外的 B站读写：登录凭据校验、限速读取、WBI 签名、发送前后读回与未知结果不重发。
- 观看活动的分段媒体获取（字幕/抽帧/音轨按 Range）、三段式观察、反思与记忆应用调用、持久预算与检查点。
- 统一注意力的B站能力条目：候选 offer、决策帧字段（bilibiliAccountOperations/browsingAgenda/browsingResources/currentActivity）、preview/dismiss/readiness/execute/collect 的B站分支。
- friend_bilibili_*、friend_activity_*、friend_browsing_*、friend_video_* 工具注册（/agent 子模块，preset 挂载 id `friend-bilibili-interaction`）。
- `bili_*` 平台写操作实现（BiliPlatformOperations），由宿主 Platforms 控制器经 `clientFor(action)` 注册分发；候选、额度与核验流程仍在宿主。

## 宿主接口

DSH 服务 `friendBilibili` 提供 `create(options)`（异步，返回控制器）、`current()`、`status()`。companion-adapter 声明 `inject=['friendScheduler','friendQQBridge','friendBilibili']` 并传入：

- 数据与路径：`journal`（共享 companion.sqlite 句柄）、`workspace`、`instance`、`config`（activities/video/bilibiliInbox/bilibiliSocial/accountActions）、`authority`（活动授权令牌）、`writeEnabled()`。
- 宿主对象：`growth`、`applications`、`memoryReader`、`native`（NativeClient）。
- `host`：晚绑定访问器 `()=>adapterController`，仅在需要 qq/proactive/platforms/attention/goals 运行状态时读取。
- `ports`（宿主自有行为，包间零 import）：`evidence`（ownerMessage/userEvidence）、`identity`（ownerIdentity/originalOwnerEvent/registerBilibiliAuthority）、`eligibleHeader`、`goalNoSave`、`reviewStructured`、`reviewers`（growth/emotion 审核器）、`observationSource`（registerObservationAuthority/sealObservationSource）、`memory`（verifyReportSources/validateApplyPlan）。

控制器暴露 `activities`、`activityRequests`、`accountActions`、`bilibiliInbox`、`bilibiliSocial`、`capability`（注意力注册条目）、`perceptionSource`（情绪感知来源）、`platformOperations()`；宿主将其挂到自身属性与 `attentionCapabilities` 注册表。轮询与驱动循环由本包根入口在 friendAdapter 就绪后挂载；工具由 /agent 子模块在 preset 内注册。

## 数据与迁移

继续使用宿主传入的同一 `companion.sqlite`（activity_*、activity_video_*、activity_browsing_items、bili_inbox_*、bili_social_*、bili_account_* 表全部原名保留），无表迁移。凭据路径不变：`channels/bilibili/credentials.local.json`、`web-session.local.json`、`social.local.json`、`inbox-traffic/`、`work/`，媒体缓存在 `cache/video/`，FFmpeg/ASR 工具在 `.tools/video`、`.tools/voice`。迁移仍按完整 runtime 快照进行。

`validation.js` 的纯函数以 `util.js` 名义复制进本包，`noLearning` 在本包与宿主 attention-affect 各有一份逐字相同实现，由共享回归钉住。vendor（bilibili-mcp、dsh-bili-whale、dsh-bilibili）随包迁移，许可证见 REFERENCES.md 与各 -REFERENCES.md。

## 安装

由 `scripts/install-bilibili-tool.mjs` 打包安装（tgz + SHA256 + 幂等记录 `.friend-packages/bilibili-tool-install.json`），`scripts/install-adapter.mjs` 统一编排；同时补写 profile `dsh.profile.bundles` 与 preset 挂载点。更新/迁移工具按 companion-adapter peerDependencies 中的 `@ai-friend/bilibili-tool` 枚举本包。

0.4.9 新增已绑定主用户原私信的任务结果发送端口 sendPrivateResult，复用同一发送锁、来源核验、风控间隔及精确读回，不创建额外用户消息或社交回合。支持实际 POST 前的异步状态核验；其他正常私信和评论继续沿原发布路径。

0.5.1：新增可选连续分段观看、真实PTS密集图片与字幕编号联合时序理解、跨批次检查点和整片章节。每批沿用原活动额度与注意力；派生总结不自动成为新独立证据。新增activity_video_readings操作状态表，完整runtime迁移。见主项目docs/video-continuous-understanding.md。
