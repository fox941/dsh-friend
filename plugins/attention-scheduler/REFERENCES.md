# 复用与边界

- XState（MIT）：https://github.com/statelyai/xstate ，npm 稳定标签已于 2026-10-29 核对为 5.33.3；使用正式依赖，不复制到 vendor，也不修改依赖源码。
- Actor/mailbox：https://stately.ai/docs/actors
- invoke 生命周期：https://stately.ai/docs/invoke
- 纯状态转换：https://stately.ai/docs/pure-transitions
- 持久化与恢复限制：https://stately.ai/docs/persistence

XState 复用的是状态机与 Actor 运行机制；模型行为决策、已有事件版本保护、数据适配和 DSH 插件封装由本项目维护。没有集成 Cortico 或 LangGraph，没有另建人格或记忆库。状态机不能自动修复模型理解、语义规则或平台接口问题。

0.2.0 的单次纠正钩子不依赖某个模型协议，不隐式吞掉无效决定。消费方提供协议与纠正请求；通用调度负责次数、时限、原件新鲜度和分次请求记录。陪伴模块复用 Zod 4.6.7 生成 JSON Schema 与校验器：https://zod.dev/json-schema 。此 Schema 作为模型输入，并在本地校验，不宣称上游 API 强制保证结构化输出。
