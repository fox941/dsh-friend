# @ai-friend/attention-scheduler

独立 DSH 插件，提供 `friendScheduler` 服务。版本 0.3.0，依赖固定为 XState 5.33.3 稳定版。

0.2.0：由消费方注入可选 `host.repair`，对带明确 repairable 标记的完整JSON/决策协议错误最多纠正一次；在原时间窗内执行，前后校验事件版本和自身状态。每次初始/纠正请求单独写入 `attention_attempts`，聚合用量，不保存原始模型输出，只保留摘要错误和输出哈希。网络失败、超时、max-tokens及敏感输出不额外纠正。`status().decisionState` 与只读 `offline` 导出区分安静、暂缓、等待资源、执行和错误；`Attention.cmd` 是本地只读查看入口。

- XState Actor 管理一次决策调用的生命周期与并发合并。
- XState 邮箱串行处理执行准入，某一项失败后可继续下一项；关闭时取消当前调用并拒绝尚未开始的准入。
- 任务状态由 XState 纯转换校验，数据库保持唯一事实来源，事务回滚不会留下另一份活动快照。已结束事项不能由晚到回调复活；恢复未完请求必须明确核对。
- `SchedulerController` 管理候选、选择、资源等待、唤醒与派发。语义验证器、模型调用、人格和执行器由消费插件注入。
- 沿用原 `attention_*` 表、事项ID、检查点及事件版本；不创建新角色，不读平台凭据，不直接发送消息或写长期记忆。

调用方式：DSH 插件声明 `inject=['friendScheduler']`，使用 `ctx.friendScheduler.create({journal,validateDecision,validateData,...})`，再用 `bind(host)` 注入快照、模型审核、执行器及现有钩子。消费方销毁时关闭 controller；服务销毁也会关闭其剩余实例。

代码：`controller.js` 为通用协调；`runtime.js` 为 XState 决策Actor与准入邮箱；`intent-machine.js` 为任务状态契约；`store.js` 兼容原持久化表；`index.js` 提供 DSH 服务。

持久化不使用自动恢复的 XState invoke 快照。重启后未完事项先进入待核对状态，再由原平台执行器检查原会话、任务检查点和发送回执。通用调度无法保证平台操作恰好一次，防重复发送、unknown 回执保护和记忆审核仍由原执行器负责。

安装由 `scripts/install-adapter.mjs` 协调：先安装本插件，再安装陪伴适配插件，分别生成本地 tgz 和哈希记录。源代码位于 `plugins/attention-scheduler`；执行状态仍在 `runtime/dev/companion/companion.sqlite`，数据迁移继续使用完整 runtime 快照。

0.2.1：增加可选captureSuggestions宿主端口，保留原持久队列、XState及串行选择。端口失败保留实际行为决定并报告lastEffectError，不回退为无条件新建；未接端口的宿主沿原行为。

0.3.0：增加可选纯函数 `host.availability(row)` 和 `host.routing(row)` 端口。在调用模型前将资源不可用项停放到原等待条件，不消耗一次行为模型调用；其他可用候选仍交由原模型自主选择。检查期间的新事件使结果失效，执行前仍通过原 `beforeStart` 再查一次。检查错误只影响该事项并有界退避。消费方提供执行对象契约与语义校验，本插件不硬编码平台/关键词；资源等待独立展示，最近一次模型选择仍保留。沿用原表，无存储迁移。
