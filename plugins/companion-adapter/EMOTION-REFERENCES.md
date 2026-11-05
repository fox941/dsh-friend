# 情绪模块源码参考与实现边界

审阅日期：2026-10-28。模块为独立 JavaScript 实现，随 companion-adapter 0.7.0 分发；没有安装、运行或复制下列项目的完整框架、提示词或角色资料，也没有把其他角色状态导入本实例。

## 实际审阅的源码

- **dsh-feiyu-mood**，作者 Yuuyuko-uu，MIT，固定提交 `4e21024445127b2218a2a3bfa5bdb2f067e3890c`：[lib/index.js](https://github.com/Yuuyuko-uu/dsh-feiyu-mood/blob/4e21024445127b2218a2a3bfa5bdb2f067e3890c/lib/index.js)。审阅 blankState、decay、noteDecay、判断结果应用与注入接口。借鉴多分量、时序变化和判断把握的分工。未采用 moodBase=70、固定七类、关系导向与特定负面归因限制；未采用把自然衰减记为满置信度的新“感受事件”。源码默认心境半衰期12小时，README部分说明不同；本实现参数单独列明。
- **FAtiMA Toolkit**，GAIPS，Apache-2.0，固定提交 `56b7cbd992f953cfe21a7b12cb1a0e6cdf6ccf9f`：[ActiveEmotion.cs](https://github.com/GAIPS/FAtiMA-Toolkit/blob/56b7cbd992f953cfe21a7b12cb1a0e6cdf6ccf9f/Assets/EmotionalAppraisal/ActiveEmotion.cs)、[ConcreteEmotionalState.cs](https://github.com/GAIPS/FAtiMA-Toolkit/blob/56b7cbd992f953cfe21a7b12cb1a0e6cdf6ccf9f/Assets/EmotionalAppraisal/ConcreteEmotionalState.cs)、[Mood.cs](https://github.com/GAIPS/FAtiMA-Toolkit/blob/56b7cbd992f953cfe21a7b12cb1a0e6cdf6ccf9f/Assets/EmotionalAppraisal/Mood.cs)。审阅 CauseId、情绪池、按时间锚点衰减、情绪/心境分开维护。未移植 C# 实现、OCC 固定规则、signed mood 累加或 reinforcement 算法。
- **ALMA**，Patrick Gebhard / DFKI，固定提交 `db82ac314c70d0a79fa8846d04b84b0ab688872c`：[EmotionEngine.java](https://github.com/A-L-M-A/ALMA/blob/db82ac314c70d0a79fa8846d04b84b0ab688872c/src/de/affect/compute/EmotionEngine.java)、[MoodEngine.java](https://github.com/A-L-M-A/ALMA/blob/db82ac314c70d0a79fa8846d04b84b0ab688872c/src/de/affect/compute/MoodEngine.java)、[ExponentialDecayFunction.java](https://github.com/A-L-M-A/ALMA/blob/db82ac314c70d0a79fa8846d04b84b0ab688872c/src/de/affect/compute/ExponentialDecayFunction.java)。借鉴情绪、心境、性格分层及不同时间尺度；未移植 Java、PAD 映射、预写人格与角色规则。仓库总许可证和部分文件头的许可表述不同，本项目仅参考设计，不分发其源码。

## 理论与表示参考

- Marsella & Gratch，EMA：[作者论文](https://people.ict.usc.edu/~gratch/CSCI534/Readings/COGSYS-RS-EMOTION-2008-6.pdf)。事件意义、已有关注、期待与不确定性，随新进展重新评价。本实现由一次有界 LLM 审核作语义判断，没有复刻规划器，也不宣称实现完整 EMA 或获得其心理学验证。
- W3C [EmotionML 1.0](https://www.w3.org/TR/emotionml/)：感受、强度、判断把握、时间和来源分开表示。采用自己的版本化 JSON/SQLite 结构，不宣称兼容 EmotionML XML 导入导出。

## 自有实现

`emotion-state.js` 为可复算的时间投影；`emotion-store.js` 保存事件关联、不可变版本、当前指针与审核尝试；`emotion.js` 处理提案、并发、证据去重和事务；`emotion-reviewer.js` 作事件评价；`emotion-agent.js` 提供只读查询、历史与受审核提交。

快分量使用按已提交锚点计算的半衰期；慢分量使用快慢两个时间核形成余留。该慢分量是本项目工程近似，不是 ALMA/FAtiMA 原算法。同标签取最明显者，正负不相减。读取不更新计时、不新增支持；新事件重评采用绝对程度，重复来源不能加深或延长。强度和置信度不是对真实主观感受的测量值。无数据时没有预设幸福、快乐或中性基线。
