# B站功能拆为独立插件 bilibili-tool

2026-10-30：companion-adapter 0.32.1，bilibili-tool 0.1.0，架构 v0.37。本篇记录把B站功能从陪伴适配插件整体拆出为独立 DSH 插件的结构、接口与边界。原功能行为保持不变：收件箱（私信/@/回复）、社交回复与社交记忆、账号操作（收藏/关注/点赞/投币/文字动态）、自主观看活动、待看续看、视频理解与回忆、内容发现、扫码登录。为后续B站方向的拓展（可视化查看、自配置）提供独立承载点。

## 模块职责

```mermaid
flowchart TD
  HOST[companion-adapter 宿主<br/>统一装配与组合根] -->|inject friendBilibili + create(端口)| BILI[bilibili-tool 控制器<br/>activities / inbox / social / accountActions / activityRequests]
  BILI -->|capability 注册条目| ATT[统一注意力 attention-host 注册表分发]
  BILI -->|platformOperations 注册| PLAT[Platforms 控制器 clientFor 分发 bili_* 写操作]
  BILI -->|perceptionSource 委托| AFF[attention-affect 情绪感知]
  BILI -->|轮询与驱动循环| DSH[DSH services / jobs]
  AGENT[bilibili-tool /agent 子模块] -->|friend_bilibili_* 等工具| PRESET[陪伴预设]
  BILI -->|journal 共享句柄| DB[(companion.sqlite 原表)]
```

- 依赖方向与 attention-scheduler、qq-bridge 相同：新插件是被注入的服务提供方，不 import 宿主包；宿主经 `create()` 传入端口。宿主 `inject` 数组增加 `'friendBilibili'`。
- 宿主保留对控制器子对象的属性引用（`controller.activities/bilibiliInbox/bilibiliSocial/accountActions/activityRequests`），目标侧代码（goal-sources、proactive-source、runtime-health、capabilities 快照）无需改动即可继续工作。
- 统一注意力改为注册表分发：`adapter.attentionCapabilities` 中的条目提供 stateKey/frame/capabilities/boundary/busyKinds/busyPayloadKeys/yieldException/preview/dismiss/readiness/pausesActivity/resume/claims/execute/collect；宿主保留 platformActionId/platformEventId、message、proactive、goal、nightly、recall、reflect 的内建分支，分发顺序与拆分前逐字一致。
- 情绪感知的B站分支迁入本包 `perceptionSource`；宿主 `attention-affect` 保留消息与 platformEventId 分支及公共逐字校验、来源密封。
- B站工具（14 个）随功能迁入 `/agent` 子模块，安装器向 preset 增加 `friend-bilibili-interaction` 挂载点；测试实例的 sanitize 仍会把该挂载点过滤掉（B站工具不进测试实例）。

## 复用的能力和我们维护的规则

- 复用：DSH 插件/服务注入、companion.sqlite 单库事务、Mnemon/Native 记忆管线、统一注意力与决策协议、宿主的成长/情绪审核器、应用管线（apply_*）、证据核验与结构化审核。
- 本包维护：B站协议客户端与限速、WBI 签名调用、收件箱游标与去重、社交话题与发送读回、观看活动的媒体获取与预算、账号操作候选与回执、扫码登录。
- 纯函数处理：`validation.js` 以 `util.js` 复制进本包；`noLearning` 在本包与宿主各一份逐字相同实现，由共享回归钉住；`public-reply-match` 复制为本包文件。
- 端口注入的宿主行为：证据（ownerMessage/userEvidence）、身份（ownerIdentity/originalOwnerEvent/registerBilibiliAuthority）、eligibleHeader、goalNoSave、reviewStructured、成长/情绪审核器、观察来源密封与核验注册、应用管线的 verifyReportSources/validateApplyPlan。宿主运行状态（qq/proactive/platforms/attention/goals）经 `host()` 晚绑定访问器按需读取，不形成包级依赖。

## 持久化与迁移

数据仍在 `runtime/<实例>/companion/companion.sqlite`，全部表原名保留（activity_*、activity_video_*、activity_browsing_items、bili_inbox_*、bili_social_*、bili_account_*、platform_*），无格式迁移；本包 store 继续使用宿主注入的 journal 句柄，单库事务边界不变。凭据与缓存路径不变（`channels/bilibili/*`、`cache/video/`、`.tools/video|voice`）。迁移仍按停机后的完整 runtime 快照，单独复制本包目录不构成迁移。

安装链：新增 `scripts/install-bilibili-tool.mjs`（npm pack → `dsh plugin add` → `.friend-packages/bilibili-tool-install.json` → 幂等补写 profile `dsh.profile.bundles` 与 patch 条目 `friend-bilibili-tool`）；`install-adapter.mjs` 按 scheduler → qq-bridge → bilibili-tool → adapter 顺序编排，并向 preset 增加 `/agent` 挂载点。更新与迁移工具按 companion-adapter peerDependencies 中的 `@ai-friend/bilibili-tool` 枚举本包；`update-package.mjs` 的存储闸改为扫描 adapter、qq-bridge、bilibili-tool 三处源码。根目录 `Login-Bilibili.cmd`、`Bilibili-Status.cmd`、`Sync-Bilibili-Web-Session.cmd`、`Setup-Video.cmd`、`Video-Status.cmd` 入口不变，`scripts/bilibili.mjs`、`bilibili-web-session.mjs`、`video-tools.mjs` 改为解析 `@ai-friend/bilibili-tool` 的导出；adapter 的 `./bilibili-offline`、`./video-offline` 导出保留为指向新包的兼容 shim。

升级注意：本次拆分改变了携带 CREATE TABLE 的文件路径，`验证更新` 的存储一致性闸会拒绝从 0.31.x 及更早安装直接普通升级；需先在新代码上执行一次完整停机安装（Setup.ps1 或 install-adapter），或在旧电脑先同步新版 `scripts/update-package.mjs` 再评估。表结构本身没有变化，不需要数据迁移。

## 验收与限制

- 全量回归以拆分前基线（995 项）为准：`FRIEND_ADAPTER_SOURCE` 指向宿主源码、`FRIEND_BILIBILI_SOURCE` 指向本包源码，两项均支持安装目录覆盖；B站/活动/视频相关 20 个测试文件已改为双源加载，`attention-host` 注册表分发由 attention-activities 等既有测试覆盖。
- 停机安装验证与 DSH 启动状态检查见 `verification.json` 与 `.work/` 记录；真实B站账号的收发、观看与账号写操作此前已分别验收，本次拆分不改变其行为，但按惯例：结构重构的模拟回归不替代下一轮真实平台抽测。
- 已知边界：测试实例（runtime/test）的 profile 白名单补入 qq-bridge 与 bilibili-tool（服务必需），B站工具与平台配置在测试实例仍整体关闭；`noLearning`/`util.js` 的双份纯函数若未来改动，必须两处同步并由回归拦截。
