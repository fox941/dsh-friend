# @ai-friend/qq-bridge

本项目自己的 DSH QQ 插件；与 Derpyu520/qq-bridge 无依赖或从属关系。

## 负责什么

- 经核验的 OneBot 连接、主用户收发、去重、持久回执和未知结果不重发。
- 群聊/其他好友的事件解析、话题上下文和回复执行；处理好友申请、群邀请、撤回通知。
- 图片、语音、引用、合并转发解析；语音转写、文本合成语音、受作用域约束的媒体资产。
- QQ 头像、好友/群操作与纯文字空间发布/评论的协议执行及可用的读回。

## 宿主接口

Cordis 服务 friendQQBridge 提供 createChannel、createMedia、status；插件加载本身不会登录或发送消息。createChannel 接收 journal、workspace、settings，以及可信 authority（register、ownerIdentity、ownerMessage）端口。通道 start(host) 由宿主提供 ensureAgent/getAgent/flush/close；是否与何时处理仍由宿主统一注意力决定。QQSocialController 接收 store、channel、call、media、conversation、self、offerEvent、offerOperation、defer、isEnabled 端口；QQAccountClient 接收 channel、instance、store、media、request。

不依赖 companion-adapter，不保存人格副本，不另建记忆引擎，不自带第二套回复调度；独立包不等于可以脱离 DSH、数据库宿主和媒体环境单独双击运行。宿主须保证每个工作区只创建一个通道，并先关闭通道再关闭 journal。

## 数据与迁移

继续使用 runtime/dev/channels/qq、companion/companion.sqlite 的 qq_* / platform_* 表，以及 cache/qq-media。未移动或清空数据库，绑定和会话 ID 不变。原 adapter 的 qq-store.js / qq-replies.js 原样搬入本包；原模块路径保留兼容导出。主程序的迁移/更新工具包含此插件的源码、固定安装包和校验记录；只复制此插件目录不包含记忆、登录状态或 FFmpeg/Whisper/EdgeTTS。

## 依赖

OneBot WebSocket 复用 dsh-onebot；空间解析复用 onebot-qzone。语音转写暂复用现有 bilibili-mcp 的本地 ASR 运行组件（不读取 B站账号，也不调用 B站接口），FFmpeg/模型和 TTS 使用原有 .tools/video 与 .tools/voice；可注入 transcribe/run 替换实现。依赖来源见 REFERENCES.md 及 vendor 的许可文件。QQ 桥接重构没有增加签名修改等新功能，也不保证解决 QQ 平台登录或账号限制。

## 组件目录

- `src/`：DSH 进程中的桥接服务。
- `napcat/qq-social-helper/`：NapCat 进程中的本机辅助扩展，负责群资料查询与申请加群，不是社交记忆模块。随本包打包，保持自己的插件名称与版本。

安装器把辅助扩展部署到 `runtime/dev/channels/qq/napcat/plugins/ai-friend-social-helper`。归并源码目录不会移动已有登录配置、加群防重复台账或记忆数据，也不需要重新扫码。QQ 群友/好友长期社交记忆已通过 src/social-memory*.js 与宿主审核接口实现，复用 Mnemon Native，不在辅助扩展中实现。

## 长期社交记忆

`social-memory.js` 负责按群/好友话题召回、提案、后台审核和索引协调；`social-memory-store.js` 在宿主 journal 追加来源、别名和记忆版本；`social-native.js` 复用现有 Native 可执行程序建立隔离话题索引。宿主传入当前账号、读写政策、空闲检查和工具禁用的审核回调；本模块不直接调用提供商 API，不读取主用户默认记忆空间。详情见主项目 docs/49-qq-social-memory.md。

0.11.3 为宿主提供可选 profileCurrent(note) 只读过滤端口，默认允许原行为。宿主可据已审核的通用画像更正关系抑制旧画像族的召回，原 QQ 社交条目和索引不删除。

0.12.0 增加可选 `profileHandoff(event)`，将主用户对已有画像的更正交给宿主统一协调器，避免同一原话被两套写入器重复处理。`profileCurrent(note,event)` 可按目标群或原说说过滤已被局部覆盖的旧用法。没有接入宿主端口时沿用原行为；其他好友的社交记忆不因此获得主用户权限。详情见主项目 `docs/qq-scoped-profiles.md`。


0.13.0 为实际媒体读取缓存增加 v2 输入指纹、观察时间和语音波形摘要。相同图片的资产记录按会话范围隔离，文件继续按内容复用；宿主可复用观察做有来源的自身经历评价。桥接本身不决定性格或情绪，不重跑旧缓存。详见主项目 docs/qq-social-media-experience.md。


0.13.1 增加有界的同会话媒体时间线：已读解读、等待观察的新媒体、随后到达消息及有回执的自身回复分开标记，防止紧接新图的问题误用旧图。沿用实际缓存，无额外识别或发送；群/好友范围及来源指纹复查保留。

0.14.0：通过可选宿主端口提供当前感受依据并提交临时感受提案，桥接本身不承担情绪存储或人格修改。无效可选提案不阻断原回复。

0.14.1：把已实际召回的 scoped memory frame 交给可选情绪上下文端口，桥接不自行批准记忆或情绪。

0.15.0：空间收件提供可选情绪上下文/提案端口，桥接不自行存情绪；当前页核验与轮询观察已知文字编辑，缺失的预览不推定删除。

0.15.1：QQ空间回复读回兼容页面省略段落换行，保留逐字正文、原根评论、AI作者和接收者的核验，不能仅凭同文认定提交归属；旧操作只读核验，不重发。

### 0.15.3：可注入的主用户文字回复核实端口

宿主可提供verifyReply，在最终草稿进入出站队列前及实际网络发送前检查原回合事实。校验阻止提交时保留原草稿并记录reply_integrity_blocked，不当成网络结果不明或自动重发。原沉默选择、分段目标、/stop宿主确认及实际发送结果不明的语义保留。

### 0.16.0：场景回复检查端口

群/好友在准备媒体前和发送前调用宿主checkReply；空间自动回应提出候选前调用检查；QQ账号写入前可调用宿主checkReply，包括待发语音正文。检查失败不进入网络提交，既有媒体失败回退、沉默、原目标和结果不明禁止重发语义保留。

QQ表情扩展：0.17.1在runtime内复用固定提交dsh-meme的图库/检索，独立适配自主收藏、原会话发送与QQ收藏读回；上游源码、MIT许可证和摘要位于vendor/dsh-meme。不启用第二套人格或调度。详见docs/qq-stickers.md。

0.68.0 / QQ桥0.18.0：同一AI共用已收藏表情，按哈希去重并保留内部来源；选图只暴露图片描述/标签。旧会话库保留，首次初始化或停机迁移入口可续接，无QQ写入或额外模型。详见项目docs/qq-shared-stickers.md。

0.19.0：GIF按时间提取最多3帧，一轮最多4个原件/6个视觉附件，复用一次识图调用；旧收藏按需派生分析，不改原观察与收藏来源。见主项目 docs/qq-gif-sampling.md。

修正版0.19.1：逐帧观察与采样差异单独返回，允许无可靠变化；分析缓存升级v2，保留首轮仅整体外观的旧结果，不冒充动作理解通过。

0.20.0：提供owner表情目录DTO和独立停用开关；模型候选、读取及平台提交前复查停用状态。原图预览保持只读，来源、分析、QQ收藏回执独立保留。见主项目docs/qq-sticker-library-ui.md。
