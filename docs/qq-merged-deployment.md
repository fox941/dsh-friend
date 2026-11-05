# QQ 两批功能合并部署

2026-11-01，companion-adapter 0.33.1 / qq-bridge 0.3.1。已部署到原 runtime/dev，原角色 UUID 保留，默认记忆库可读。B站插件保持 0.4.1，源码与安装摘要均未变化。

已上线：QQ 群／好友社交记忆增量夜间整理、时效排序、变更检查与停机安全撤销；QQ 昵称、签名、头像和1–4图空间发布。既有后台审核与统一注意力继续使用，未预设新人格或把各群私聊混入主用户记忆池。

完整隔离回归1038项、实际安装包专项141项通过。升级先停机一致性备份，新增4个社交维护表；全部原 companion.sqlite 表逐行逻辑哈希及数量一致。备份：

`D:/ai friend/backups/dev/2026-11-01T05-34-04-130Z-qq-merged`

代码备份：

`D:/ai friend/backups/dev/2026-11-01T05-34-04-130Z-qq-merged-code`

发布记录：`.work/qq-merged-release.json`。首次启动就绪检查跑得过早，已在保留现场后重新读回确认原角色和记忆服务正常；没有因此覆盖恢复数据库或另建角色。

QQ 当前是否登录以 QQ-Status.cmd 为准；本次未向真实 QQ 发测试消息、修改资料或发布说说。真实平台修改、可见性及多日记忆效果仍待验收。B站内嵌页面的数据通道问题仍属于另一窗口任务，本次不将其记作已经修复。

## 查看和撤销

- Social-Memory.cmd status：记忆计数。
- Social-Memory.cmd changes：最近记忆批次。
- Social-Memory.cmd changes <完整批次ID>：原话、旧值、新值、审核与结果。
- Stop-Main.cmd 后使用 Social-Memory.cmd undo <完整批次ID>，成功后 Start-Main.cmd。后续有修改的目标会拒绝撤销；不回滚整个记忆库。

QQ资料与图文使用说明见 [QQ账号与空间](qq-account-profile-and-space.md)，维护设计见 [社交记忆维护](qq-social-memory-lifecycle.md)。头像可能被QQ重编码，未通过字节读回时不报告完全核验；图文正文和图片数量读回不等于公开可见或图片像素逐一核对。

此次有数据库新增表，旧版本普通代码更新门禁继续拒绝无评估跨版本更新；迁移应使用完整停机实例及匹配代码，不只拷贝一个db或旧的tgz。
