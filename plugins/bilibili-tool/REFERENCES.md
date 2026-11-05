# REFERENCES

本包复用的第三方来源与许可证索引；各项详情见同目录的分册（自 companion-adapter 迁入）。

- `vendor/bilibili-mcp/`、运行依赖 `@xzxzzx/bilibili-mcp@1.14.5`、`@modelcontextprotocol/sdk@1.30.0`：只读 MCP 工具与本地 ASR/播放组件，详见 ACTIVITY-REFERENCES.md。
- `vendor/dsh-bili-whale/`：MIT，WBI 签名、精确 JSON 解析、私信/消息端点封装，详见 BILIBILI-INBOX-REFERENCES.md 与 SOCIAL-REFERENCES.md。
- `vendor/dsh-bilibili/`：视频关键帧与媒体选择辅助，详见 VIDEO-REFERENCES.md。
- 运行依赖 `qrcode-generator@2.0.4`：扫码登录二维码（bilibili-login.js）。

所有 vendor 目录保留上游 LICENSE；固定版本与来源约束同 companion-adapter 0.31.x 时期，未修改第三方源码。本包不含人格、记忆或调度逻辑；与宿主的边界见 README.md。
