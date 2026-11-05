当前实现（2026-10-28）：companion-adapter 0.10.0 / 架构 v0.12，新增只读B站内容工具与有预算的自主活动协调层；活动经历、兴趣和情绪复用现有唯一状态与保护。使用、来源和限制见 [17-activities.md](17-activities.md)，运行验收见根目录verification.json。下文旧版本描述保留为历史。

当前插件 0.7.0 / 架构 v0.9，新增[多项情绪及背景心境](14-emotion.md)。旧版单条情绪说明作为历史保留，新情绪使用独立事件与版本表。

当前运行版本：companion-adapter 0.6.0 / 架构 v0.8。新增[批次快照、变更查看及停机撤销](13-memory-protection.md)。本文旧版比较和阶段验收保留为历史。

当前实现补充（2026-10-27）：现已采用外部自研陪伴适配 0.5.0（含预演、可恢复应用及夜间增量协调），成长机制及公开设计参考见 [08-growth.md](08-growth.md)。下文保留初次第三方选型研究，候选人格/情绪插件未直接安装。

# 插件选型：优秀且轻量如何判断

核查日期：2026-10-27。结合作者仓库、依赖、部分源码及独立使用者反馈调整，当前以 v0.2 架构为准。现已安装 dsh-mnemon 0.5.36 + Native 0.2.13，通过小规模真实写入、跨会话召回、重启与离线恢复检查；其他候选未安装。这不是中文复杂语义或长期陪伴质量测评，目录评分、Star 数和作者 benchmark 也不能代替验收。

选型同时看：是否符合空白养成需求、是否支持固定 DSH 版本、完整依赖是否轻、中文效果、数据导出/删除/恢复、失败处理与持续维护。没有同时满足全部要求的现成“人格总插件”。

## 第一轮建议

| 用途 | 候选 | 推荐程度 | 需要先验证的内容 |
|---|---|---|---|
| 记忆组织与本地后端 | [`dsh-mnemon`](https://github.com/omdsh-dev/dsh-mnemon) + [Mnemon Native](https://github.com/mnemon-dev/mnemon) | 已落地功能基线 | 基础链路与本机离线恢复通过；复杂中文语义、纠错和长期消耗仍需测试；CLI 已按固定版本安装 |
| 自动整理对照 | [Mneme](https://github.com/slow-stack/mneme) | 对照，不同时启用 | 模型格式遵循、失败重试、后台消耗；0.9.4 仍有用户后续报障 |
| 最简记忆对照 | [`@tr1v3r/dsh-ltm`](https://github.com/tr1v3r/dsh-ltm) `0.3.4` | 最简基线 | 中文改写召回、项目作用域迁移、包装写入口、数据恢复 |
| QQ | [`dsh-onebot-qq`](https://github.com/mario841859784/dsh-onebot) `0.9.6` | 优先验证的完整通道 | 固定 rc.3 实例、会话恢复、关闭多余功能、身份和权限路由 |
| B 站 | [`bilibili-cli`](https://github.com/public-clis/bilibili-cli) `0.6.2` | 推荐作为只读工具候选 | Windows、登录存储、字幕可用性、失败处理；它不是 DSH 原生插件 |
| 调度 | DSH 官方 [`dsh-schedule`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/schedule) | 直接复用官方能力 | 夜间任务的业务游标和幂等仍需开发 |
| 情绪 | [`dsh-feiyu-mood`](https://github.com/Yuuyuko-uu/dsh-feiyu-mood) `0.7.6` | 仅参考/隔离评估 | 去除固定关系、固定情绪基线和表达限制后，是否还有实际收益 |

首轮以 DSH Web + Mnemon/Native 验证为主。初期关闭 Idle Review 和技能自进化，核查容量维护等其他模型调用；QQ、B 站按阶段接入。实际安装固定版本，不以 README 徽章代替发布包元数据。

## 当前推荐依据及限制

Mnemon 已有 Source、Strategy 和可替换 Provider 分工，适合我们增加角色状态来源和陪伴用策略；原生后端为本地 CLI，不强制引入 PostgreSQL。它仍需要衔接状态演化、来源证据及可恢复业务任务，不是完整人格方案。

独立使用帖报告调整写入规则后跨会话工作衔接顺畅，也认为默认自动写入和空闲审查需约束；这是编程工作流经验，不能直接证明长期陪伴效果。[使用帖](https://linux.do/t/topic/3005835)

Mnemon 用户报告后台改写降低关键记忆重要度，其修复 PR 已合并。[报障](https://github.com/omdsh-dev/dsh-mnemon/issues/469)、[修复](https://github.com/omdsh-dev/dsh-mnemon/pull/479)

Mneme 有独立用户认可配置简单。[心流使用帖](https://vibex.iflow.cn/t/topic/6715)、[小众软件使用帖](https://meta.appinn.net/t/topic/91938)。但 0.9.3 同一窗口反复提炼失败，0.9.4 后仍有其他失败形态；截至本次查询 PR 503/504 尚未合并，不把旧问题和当前状态混为一谈。[报障与后续](https://github.com/slow-stack/mneme/issues/493)、[PR 503](https://github.com/slow-stack/mneme/pull/503)、[PR 504](https://github.com/slow-stack/mneme/pull/504)

dsh-ltm 用户在 0.3.3、40 条中文记忆的小样本中报告原词问法 12/12、改写问法 7/12。它不是全面 benchmark，但说明不能以词面命中代替语义召回验收。[用户测试](https://github.com/tr1v3r/dsh-ltm/issues/49)

## dsh-ltm 作为最简对照

本地 SQLite、中文分词检索、近重复候选、受限召回和导出导入，适合个人事实记忆；没有强制外部检索服务或后台模型调用。包的 peer 清单明确列出 `0.2.1-rc.3`。它比最简 FTS 记事本多一些实用治理，又不要求常驻 Python 服务或 PostgreSQL。

边界同样明确：其 CAS 只处理并发覆盖；没有完整语义冲突裁决、证据链历史或人格演化；近重复也不等于矛盾。去重扫描会随数据量增长。中文语义改写、讽刺、否定、长时间跨度仍须实测。可选 tokenizer 也要计入依赖，不能把“不启用嵌入模型”说成完全零依赖。

来源：[作者说明](https://github.com/tr1v3r/dsh-ltm)、[npm 发布元数据](https://registry.npmjs.org/@tr1v3r%2fdsh-ltm/0.3.4)。本次审查参考提交：`8a487c8cdb67e5bfbceaf070f85a5a227cd5d6a7`。

## 其他记忆方案

| 方案 | 优点 | 本次取舍 |
|---|---|---|
| [`dsh-memory-graph`](https://github.com/zmh2000829/dsh-memory-graph) `0.8.1` | Node SQLite，中文 trigram，时序图谱、来源记录、后台重试，嵌入可选 | 功能很值得比较；现有 peer 仍是 `^0.1.0-rc.6` 一组，不能据此认定兼容 rc.3。默认每轮摘要也增加模型成本。先等适配或隔离验证，不强制绕过版本门 |
| [`dsh-mnemosyne`](https://github.com/rebron1900/dsh-mnemosyne) `0.8.1` + [mnemosyne-oss](https://github.com/mnemosyne-oss/mnemosyne) | 已有工作/长期记忆与整理能力；本地 SQLite，无须 PostgreSQL | 更接近完整记忆后端，但 Node 桥 + Python CLI 的运维更多，向量 extras 另增模型和依赖；桥接 peer 多项精确锁 `0.2.0-rc.2`。列为升级比较项 |
| [`dsh-memoir`](https://github.com/Qinling-Melon-Farmers/dsh-memoir) `0.9.3` | 有界热记忆、BM25、来源引用与管理界面，不依赖向量服务 | 项目工作记忆导向，需验证转换为陪伴经历是否合适；不与首选并装产生双份注入 |
| [`ben7am1n/dsh-memory`](https://github.com/ben7am1n/dsh-memory) `0.1.0` | 小、简单、SQLite、无外部服务 | 可作基线对照，中文和复杂语义能力不足以承担完整需求，旧 peer 也须检查 |
| [`Hindsight`](https://github.com/vectorize-io/hindsight) | 完整记忆服务，有 retain/recall/reflect 和迁移接口 | 若轻量方案质量不够再比较；PostgreSQL、嵌入和服务运维不符合这轮最小部署目标，不因“成熟”就直接加入 |

这里的 Mnemosyne 与之前你指定的 [`lxfight/astrbot_plugin_mnemosyne`](https://github.com/lxfight/astrbot_plugin_mnemosyne) **不是同一个项目**。后者是 AstrBot 的 Python 插件，不是安装到 DSH 就能运行；为它同时部署 AstrBot、Chroma/嵌入链路会增加依赖。本轮不采用完整 AstrBot 作为侧挂记忆框架。

不论更换哪一个，先保留原始会话与经历、状态变更依据及可导出的业务记录，再转换后端索引。不能承诺插件数据格式天然通用，也不能承诺模型表现完全不变。

## QQ 的轻量取舍

`mario841859784/dsh-onebot` 的实际包名是 `dsh-onebot-qq`。它支持持久会话、两种 WebSocket 通道和更多消息类型；依赖含 `ws`、字体与原生 canvas，不能称为零依赖。先关闭文字转图片、语音转写、图片处理和中间消息等非必要功能；关闭功能未必消除安装依赖。QQ 客户端/OneBot 实现仍是单独的资源成本。

它的 `engines.dsh` 与各项 DSH peer 范围并不完全相同；不能仅凭引擎范围包含 `0.2.1` 预发布就认定所有依赖满足。QQ 阶段先检查版本门和宿主实例解析，再做实际收发；本次没有验证通过这一组合。

更小的 [`jackzo400/dsh-onebot`](https://github.com/jackzo400/dsh-onebot) `0.1.0` 无 npm 运行依赖，可作纯文字备选；但只支持正向 WS、无完整媒体理解、主动发送需其他模块调用，也没有超长回复自动分段。作者也提示有功能更完整的替代品。它的“轻”不能自动抵消会话恢复和现版 API 的验证工作。

只部署一个 QQ 桥。先主用户私聊白名单、群聊关闭、固定工作区与受限工具预设；以后接群聊前补齐按联系人隔离。不能用“受限用户”提示词替代执行层权限。

## 为什么不直接装情绪总插件

`dsh-feiyu-mood` 的可借鉴之处是：按真实回合做语义判断，记录理由、区分主动活动与被动任务，将状态持久化。它需要额外的模型判断请求。

其当前说明也预设七种情绪、回稳基线及亲密关系导向，并限制某些生气归因。这与“不预写性格和关系”不完全相符。不能只改名字就当成空白养成。先在测试角色中评估判断质量；若采用，须拆出中性状态/理由机制，再让我们的一份自我状态成为权威。

不推荐同时运行“情绪插件 + 自动好感插件 + 主动关心插件”，让三个系统各自改状态和塞提示词。也不推荐用关键词加减分控制工具权限，或按聊天轮数把陌生人自动变成依赖关系。

[`dsh-remembers`](https://github.com/derkinL/dsh-remembers) 的记忆分层、日志、日记和活动组合很值得参考；但默认关系增长、部分平台/Windows 适配和跨插件补丁不符合这轮直接复用目标。它是设计参考，暂不作为人格底座。

## B 站与抖音

B 站优先验证 `bilibili-cli` 的视频详情、字幕、搜索、关注动态和 JSON 输出。它有 Python 及网络/鉴权等依赖，先不安装 audio 可选项。适配只开放少量只读子命令，固定超时、结果大小与凭据目录，不把原始 shell 交给角色。

字幕缺失再考虑按需浏览器、音频或视觉工具。播放成功不代表模型理解了完整视频；所有经历须注明实际观察范围。不要混淆 B 站直播 API、推荐流和关注动态。

抖音保留接口，首轮不承诺现成个人推荐流插件稳定可用。以后根据登录态、可读取内容、Windows 和资源成本选择浏览器或具体 CLI 适配；先完成一个真实 B 站体验闭环再复制到抖音。

## 安装前的门槛

1. 固定 DSH 与插件包版本，禁止默认追踪 moving branch；不使用忽略 peer/强制接受风险来掩盖冲突。
2. 在 `runtime/dev` 验证安装、卸载、重启恢复、工具和提示词来源；确认没有加载第二份 DSH 核心依赖。
3. 用同一套中文记忆/迁移用例测候选；统计模型调用与完整依赖成本。
4. 记录插件实际数据路径，完成停机备份与新目录恢复。
5. 通过后才加入长期运行组合；每次只替换一个负责状态或记忆的组件。
