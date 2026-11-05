# 自主收藏与关注（0.26.0）

本次薄适配自研；收藏夹与操作字段参考 [dsh-bili-whale fav.mjs](https://github.com/Alterssss/dsh-bili-whale/blob/main/tools/commands/fav.mjs)、[收藏夹信息](https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/fav/info.md)、[关注关系](https://github.com/realysy/bili-apis/blob/master/docs/user/relation.md) 与 [bilibili_go](https://github.com/PastGone/bilibili_go/blob/master/user.go)。只参考协议，未引入其依赖、固定每日操作次数或人格行为。继续复用已带MIT许可的本地流量保护，无新增第三方源码。

账号操作与观看、记忆证据分离，使用既有统一调度；没有播放上报、投币或任意关系修改。真实平台仅做只读接口核验；写边界及真实DSH/DeepSeek验收在隔离平台模拟中完成。下方为此前参考。

# 首页推荐与关注动态 0.25.0

新增自有只读bilibili-feeds适配，复用原BilibiliInboxClient登录核验、MIT WBI签名及跨进程请求保护；不修改第三方包。读取AI账号首页推荐和关注动态，一页最多20条视频/动态，过滤广告与直播，按BV和动态ID去重，分页游标仅用于同账号同来源、15分钟内的有限去重。转发者不作为视频作者；未知视频发布时间保留未知，动态发布时间另列。

friend_bilibili_discover与friend_bilibili_explore增加home/following，原自动活动也能选用。历史范围、待看状态和最近候选作为提示，角色仍可不看、补看或留待以后；不按推荐生成稳定兴趣。没有增加决策循环、数据库表或长期记忆入口，保留现有日限额、无保存及证据审核。

接口形状对照项目维护者的端点文档，具体代码自研：[NextPili视频端点](https://github.com/rownix101/NextPili/blob/main/docs/api/endpoints/video.md)、[bpi-rs动态接口索引](https://github.com/Yuelioi/bpi-rs/blob/main/docs/api-index.md)。本地实测用于确认当前返回结构；签名和流量保护仍来自已保留许可证的vendor/dsh-bili-whale。未引入这些项目的运行依赖。详见项目docs/34-bilibili-feeds.md。下方为历史版本。

# 待看、续看与未解疑问 0.24.0

沿用原统一注意力、活动和视频模块，在同一个companion.sqlite新增activity_browsing_items一张操作状态表。角色可从真实候选中最多留两项待看，或根据实际观察提出继续/搁置/结束/放弃及最多三项疑问；这些不是事实、长期记忆或人格。原活动账本保留来源与变更回执，版本检查防止覆盖后来的主用户操作，重复处理不重复强化。

自动活动可选择watchlist，仍共用原探索/决策/手动额度。QQ续看仍排队并沿用原绑定；历史原件按BV、分P、CID核验后进入观看上下文。进度按实际观察区间并集计算，跳看末尾不代表全片看完。不保存请求不会创建持久浏览意图。主用户通过friend_browsing_read/change查看、暂停、恢复、结束或放弃。

没有新增框架、常驻服务、人格或第二份记忆，也没有修改第三方包。详见项目docs/33-browsing-continuity.md。下方为历史版本。

# B站只读内容发现 0.23.0

复用 @xzxzzx/bilibili-mcp 1.14.5 的UP主搜索、动态、合集/系列和AI账号收藏；投稿与资料目录使用现有 vendor/dsh-bili-whale 的MIT WBI签名及BilibiliInboxClient限速读取，修复上游使用timestamp及签名构造导致的投稿拒绝，不修改第三方包。

friend_bilibili_discover只返回一页元数据，不形成观看经历；friend_bilibili_explore增加主用户最新投稿、指定UID候选和AI收藏入口。最新是指定UID空间投稿首页按发布时间选出的可见候选，可能含联合投稿。QQ仍持久排队、检查点固定BV、同一角色决定何时看和何时回应；原手动/自动额度、记忆审核、人格与情绪沿用。无首页推荐和关注全量流，无新增点赞/关注操作。

# 自主活动的复用与边界

2026-10-28，companion-adapter 0.10.0。

- 实际依赖：[@xzxzzx/bilibili-mcp 1.14.5](https://github.com/XZXZZX-Ai/bilibili-mcp)，Apache-2.0。通过标准 stdio MCP 调用其登录状态、搜索、元数据、字幕；未修改安装包。ASR、下载模型和其他工具未开放。
- MCP 客户端：[@modelcontextprotocol/sdk 1.30.0](https://github.com/modelcontextprotocol/typescript-sdk)，使用公开 Client / StdioClientTransport，复用现有 Node，不引入 Python 常驻服务。
- 本地扫码：vendor/bilibili-mcp 包含该固定发布包 dist 的 qr-login.js、bounded-response.js、errors.js、operation-context.js 及 Apache 许可证。仅在 loginWithQr 加入 onQr 回调：把原来的终端二维码改为本机随机口令页面显示，Cookie 仍由原有受限响应/Set-Cookie 校验生成。保存路径和已有账号保护由本插件负责。使用 qrcode-generator 2.0.4。
- 调度设计参考：[Kanadego/dsh-heartbeat](https://github.com/Kanadego/dsh-heartbeat) 的素材来源、先闸门后模型、沉默选择及独立活动原则；没有安装或复制它的用户画像、屏幕采集、加密存储或人格系统。
- 对照：[c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) 的字幕优先、去重、活动限额和读取范围；未安装其完整插件，没有开启评论或其他外部写操作。

自研部分：活动预算和状态机、主用户工具入口、原件账本与核验、同一份成长/情绪状态衔接、仅新增经历的审核计划、可恢复应用与旧保护复用。不是直接安装一个完整人格插件，也不是自行重写B站搜索/字幕协议。
