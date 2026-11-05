# 跨平台长期目标：0.17.0 / 架构 v0.19

本模块接在现有 companion-adapter 中，继续使用同一 DSH、SQLite、记忆、情绪和统一注意力。没有新增服务、模型供应商或规划框架，也没有修改 DSH/Mnemon 源码。

## 目标如何产生与执行

借鉴 BDI 的认知、愿望、意图分层。聊天原件、现有兴趣或内部反思可以提供候选愿望；proposed 不表示已经决定投入，更不证明承诺。模型重新考虑后可 adopt，再安排一个具体步骤。目标和步骤仍与所有平台消息共用注意力：可以继续其他事、等待、暂停、修订或放弃，没有聊天或目标的固定优先级。

状态：proposed、active、waiting、paused、completed、abandoned。adopt 保留采纳时间；revise 保留原目标和新标准；wait 记录时间或事件条件（时间范围一分钟至七天）；到期只提供重新考虑机会。paused 不会被普通事件自动恢复。已完成/放弃的目标不能静默复活。

每次只安排一个未完步骤，复用现有 browse、recall、reflect 执行器。可在结果之后再规划下一步，而非提前固定整天的虚构生活。执行中的非浏览步骤完成后保留真实结果；暂停/放弃所属浏览任务会终止当前执行，已有原件、检查点和写入回执保留。恢复目标后重新决定下一步，不重放旧发送或假装之前未发生。

## 完成与真实进展

目标内容、完成标准和所需结果类型分开记录。默认要求 observation，即真实工具观察；检索目标可明确选 retrieval，内部思考目标可选 internal_reflection。完成须引用该目标已完成的步骤ID，程序重新对照原 attention 结果、活动执行和实际观察原件。内部反思不能满足要求观察的目标。休息、失败、没有原件或编造活动ID均不算实际读取。

程序核实执行真实性和结果类型；模型仍需判断结果在语义上是否满足标准。它不独立证明理解正确，也不保证每次规划合理。字幕阅读不表示完整观看画面；检索与反思不构成新的独立事实证据。目标/反思记录不会直接写入 Mnemon、人格或情绪；真实执行后的既有记忆流程继续按原规则审核。

## 来源与平台范围

统一选择阶段可以提出目标，也可依据已核验主用户的 Web/QQ 或 B站私信改变既有目标。引用必须逐字匹配本次实际呈现的来源；不保存、测试、只临时使用的限制会检查完整原件，不能用短预览绕过。公开评论和陌生人可以提供候选话题，不能通过这个入口直接控制私密目标。

Web/QQ 主用户聊天可使用 friend_goals_read、friend_goal_change；B站主用户私信会提供同一份目标摘要，公开评论和他人私信不注入私密目标。B站没有额外一套目标工具或目标库，变更通过统一选择阶段的来源核验。所有目标都保存在本地，不因公开话题来源自动变成公开资料。

## 数据与恢复

仍存 runtime/dev/companion/companion.sqlite，新增五张表：goal_meta、companion_goals、goal_steps、goal_changes、goal_operations。没有第二个数据库。变化使用 SQLite 原子事务和精确版本校验，重复操作返回当前状态及历史回执标记。步骤事件键稳定；崩溃后先核对旧执行回执，不重复创建步骤或盲重放。

默认并存最多12项未结束目标、同时投入最多3项，是控制上下文和执行资源的可配置上限，不是性格、情绪阈值或消息回合额度。没有新增固定频率的目标模型轮询：只有现有注意力选择关注目标时才规划；失败记录真实错误，60秒后仅允许重新选择。

查看：Goals.cmd；或 node scripts/goals.mjs [目标UUID]。聊天中可直接问“你现在有什么想继续做的事，哪些暂停了？”工具只读查看不调用额外模型；聊天表达本身仍消耗正常模型调用。诊断将规划请求计入 goal 阶段。

迁移包含完整停机 runtime/dev 和对应插件源码/安装包，目标随 companion.sqlite 一起走。不要单独覆盖运行中的数据库。没有为这次升级清空旧人格、记忆或会话。

## 参考及复用边界

- [BDI / Jason](https://jason-lang.github.io/)：借鉴愿望与已采纳意图分离，不引入 Java 解释器。
- [DSH Goal](https://github.com/deepseek-ai/deepseek-harness/tree/1f81c047fc48fa190a683e469daa699857e9afe8/packages/goal)：参考精确版本与持久状态。原生每会话单目标、工具要求人类直接请求，不将内部事件伪装成人类请求，也不启用第二套全局目标记录。
- [DSH Schedule](https://github.com/deepseek-ai/deepseek-harness/tree/1f81c047fc48fa190a683e469daa699857e9afe8/packages/schedule)：复用宿主运行环境；目标唤醒沿用现有持久注意力等待机制，没有另起定时器。
- [MaiBot自主规划插件](https://github.com/xuqian13/autonomous_planning_plugin)：参考未来事项与当前活动的区分；没有移植虚构吃饭/睡眠和“排进日程即完成”的语义。
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[XState persistence](https://stately.ai/docs/persistence)：参考跨执行恢复和显式状态；未添加相关依赖或另一套运行时。

当前不包含主动QQ发送、抖音、完整视频感知、复杂目标依赖树或自动跨电脑迁移。模拟时钟和隔离真实模型验收只覆盖相应机制；真实多日目标选择质量仍需通过已上线诊断和实际使用观察。
