# QQ 文字通道的来源与分工

本包 0.9.0 的连接层复用 `mario841859784/dsh-onebot` 0.9.6：

- 仓库：https://github.com/mario841859784/dsh-onebot
- 固定提交：`bc3aa23fcf7a11f9be7440ce2539a0a8889da3f7`
- 源码归档 SHA256：`5ddf0c38a3bb88e5b7d7ad59b6301563d839b278d5dc8e012006e7407273dd01`
- 复用文件：发布目录中的 `lib/connection.js`、`lib/errors.js`，保存在本包 `vendor/dsh-onebot/`。
- 原 BSD-3-Clause 许可证完整保留在该目录的 `LICENSE` 中。

复用的是有认证、echo 回执、心跳和退避重连的 OneBot WebSocket 传输。没有把第三方包的私有路径作为运行时接口，也没有改写已安装的第三方包。当前部署不声称安装或运行了它完整的 QQ 插件。

完整上游的媒体、canvas、语音、任意 NapCat 操作、群聊和预设管理不随本包加载。原桥把输入登记为 `plugin:dsh-onebot`，没有在该 source 内包含我们需要核验的发送者和平台消息 ID；因此主用户绑定、原话凭据、会话恢复、私聊文字路由、发送检查点以及自我/夜间整理适配由本包维护。

原包的 `engines.dsh` 与各 DSH peer 范围也不完全一致，不能仅凭大版本范围宣称兼容当前 `0.2.1-rc.3`。我们通过该版本公开的 agent registry、preset、session persistence、source 与工具限制接口集成，实际用隔离 Host 验收。

本地变更：传输的单帧上限由64 MiB降至1 MiB；用途限制在本机正向WS文字通道。错误日志通过本包的脱敏出口，不记录主用户消息或访问令牌。运行依赖仅 `ws@8.22.0`，当前 DSH 已使用此版本，不增加 canvas、额外模型服务或机器人框架。

协议与部署说明：

- https://11.onebot.dev/
- https://napneko.github.io/guide/boot/Shell

NapCat 是另行部署的 QQ 协议端；其实际登录和账号状态必须真实验证，模拟 OneBot 测试不能冒充已登录 QQ。
