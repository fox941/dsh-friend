# 独立 QQ 桥接

companion-adapter 0.32.0 通过公开服务 friendQQBridge 使用 @ai-friend/qq-bridge 0.2.0。源码位于 plugins/qq-bridge；NapCat 内部辅助扩展源码已归并到 plugins/qq-bridge/napcat/qq-social-helper，仍在 NapCat 进程独立加载，负责群查询和申请加群，不是长期社交记忆。

QQ → NapCat → OneBot → qq-bridge → 陪伴系统的身份/注意力/模型/记忆接口 → qq-bridge → QQ。

桥接负责通信、媒体、群友话题输入、QQ 账号执行及回执；陪伴插件负责持续人格、情绪、记忆审核、统一活动选择和模型调用。B站实现保留在陪伴插件，未搬入 QQ 桥接。主用户 Agent 预设和来源核验注册仍由陪伴宿主提供。

本次没有数据格式迁移，既有 qq_* 表原样使用；platform_* 仍由跨平台操作协调层持有并作为存储接口提供。安装包独立版本化，更新与整机迁移校验新增 qq-bridge-install.json。辅助扩展运行安装路径与本机配置、申请台账保持原位，源码随桥接包打包；旧目录已移除。旧 qq*.js 路径保留兼容导出，避免脚本、诊断和调用者同时更改。

本插件是本项目自行拆分，不是安装 Derpyu520/qq-bridge。群友/好友长期社交记忆现已接入，见 [QQ 社交记忆](49-qq-social-memory.md)；使用隔离的 Native 话题索引与版本账本，不在 NapCat 加群辅助扩展中实现。

旧版升级工具只认识顶层 `plugins/qq-social-helper`。使用 0.31.0 或更早程序的电脑，首次应用此目录调整的代码更新包前，需要先同步新版 `scripts/update-package.mjs` 与新增的 `scripts/qq-helper-source.mjs`，再按原来的预演、应用流程操作；否则旧校验器会拒绝新目录。新版工具同时能读取旧布局的更新包，辅助扩展摘要的校验没有取消。首次整机迁移直接使用新版完整迁移工具即可。
