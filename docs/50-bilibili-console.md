# B站活动面板（静态控制台）

2026-10-31：bilibili-tool 0.3.0，companion-adapter 0.32.3（仅同随 peer 版本），架构 v0.39。为B站功能提供可视化入口：一个自包含的静态 HTML 面板，汇总 AI 账号的今日观看、交流回复、私信与事件、收藏/关注、点赞/投币/动态回执，以及当前配置开关与关注列表；0.3.0 起配置区块支持**页面生成变更请求 → 受控应用**的写路径。零运行时依赖、零新表、零新权限。

## 生成与查看

- 双击 `Bilibili-Console.cmd`（或 `pnpm bilibili:console`）：从 `companion.sqlite` 只读汇总生成 `runtime/dev/companion/console/bilibili-console.html` 并自动打开。
- `--no-live` 跳过关注列表的真实读取（`node scripts/bilibili.mjs console --no-live`）。
- 页面是生成时刻的静态快照；新活动需要重新生成。每页顶部都标注生成时间与"不等于完整看过或发送成功"。

## 配置修改（0.3.0 受控写通道）

页面"配置与开关"区块的表单覆盖与在线 `control()` 工具完全相同的白名单：自主观看开关与四项额度/冷却、收件箱开关、社交回复发送、账号操作开关/自主提案/每日上限/写入间隔/收藏夹ID。流程是**页面生成请求、命令行受控应用**，页面本身没有任何写入口：

1. 页面上修改字段、点"生成变更请求"：页面构造 `{schema:'ai-friend-bili-config-request/1',requestedAt,changes}`，优先经浏览器 `showSaveFilePicker` 另存，剪贴板兜底。
2. 把请求保存为 `runtime/dev/companion/console/config-request.json`，双击 `Bilibili-Config.cmd`（或 `node scripts/bilibili.mjs config-apply`）。
3. 应用端做完整校验后单事务写入：未知分组/字段、越界数值、坏版本号在写入前整体拒绝；`activity` 数值经 `activityConfig` 校验合并，`account` 经 `accountPolicy` 校验合并并递增 revision；`inbox` 恢复时同步清零 `next_poll_at`（与在线 control 一致）；`social.outgoing` 写入 `bili_social_meta`。
4. 每次应用追加一行 `companion/console/config-audit.jsonl` 审计（时间、来源、请求内容、逐项结果），请求文件归档为 `config-request.applied-<时间戳>.json`，面板自动重新生成。

应用与实例运行中可并发（WAL + 5 秒 busy timeout，与 `setActivityAutomatic` 等既有离线控制同一技术）。白名单之外没有任何写入路径；已暂缓的统一注意力候选在下一次巡检时按新策略重新判断。

## 数据来源与边界

- 全部数据来自既有表的只读查询：`activity_runs/activity_observations`（今日观看，按上海日期过滤，近期记录作后备展示）、`bili_social_turns/bili_social_outbox`（回复与读回）、`bili_inbox_events/attempts`（私信与事件及处理结果）、`bili_account_actions` + `platform_operations`（收藏/关注与点赞/投币/动态，含读回核验状态）、各 `*_control/meta`（配置只读展示）。
- **关注列表是唯一新增的数据面**：`fetchFollowing` 用 AI 账号自己的登录态只读拉取 `x/relation/followings` 的前 N 个关注（生成时实时读取，失败降级为"不可用+原因"，不影响其余区块）。它只读取AI账号自身的关注关系，不读取黑名单、悄悄关注或他人列表。
- **凭据零出现**：生成过程只读凭据用于构造请求头，页面与原始 JSON 永不包含 SESSDATA/bili_jct；由回归测试断言。
- 页面所有插值经 HTML 转义（注入测试覆盖）；配置表单的当前值以 JSON 注入时转义 `</`，防脚本逃逸。

## 实现与验证

- 新文件仅 `plugins/bilibili-tool/src/console.js`（快照/HTML/关注列表/写盘/白名单应用）+ `Bilibili-Console.cmd`、`Bilibili-Config.cmd` 入口 + `scripts/bilibili.mjs` 的 `console [--no-live]`、`config-apply` 动作；`Bilibili.ps1` 增加 `Console`、`Config` 动作。
- `tests/bilibili-console.test.mjs` 8 项：日期过滤、空库/未初始化降级、HTML 转义与凭据零出现、关注列表请求/映射/降级、写盘路径、**白名单应用与审计、整体拒绝与无审计留痕、表单覆盖白名单**。
- 静态页模式沿用 `friend_memory_changes` 报告先例；不做常驻服务、不引前端构建链。挂进 DSH Web 应用内页（client bundle）需要逆向其预构建 UI 契约，留待确认官方文档后另行评估。

