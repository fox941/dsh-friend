# B站视频感知实现来源

- 0.28.0模糊视频回忆：直接复用已安装dsh-mnemon的mnemon_recall与Mnemon Native，不复制其检索算法，不修改第三方源码。组合调用遵循固定DSH公开ToolRuntime.execute、parent token、rootCallId、取消与附加上下文契约；来源映射复用自己的应用回执。参考：https://github.com/mnemon-dev/mnemon/blob/master/docs/USAGE.md ；DSH固定源码upstream/deepseek-harness/packages/core/tools/src/index.ts。向量增强由现有Mnemon配置决定，本次不增加或更换嵌入服务。

- 0.27.0视频工作笔记与检索：设计参考LlamaIndex的summary/question node references、Document Summary Index与原件回查；未复制源码或安装LlamaIndex。实现使用现有SQLite、运行时Intl.Segmenter与原活动反思调用，不增加模型服务。https://developers.llamaindex.ai/python/framework/integrations/retrievers/recursive_retriever_nodes/ ；https://developers.llamaindex.ai/python/examples/index_structs/doc_summary/docsummary/

- `@xzxzzx/bilibili-mcp@1.14.5`：继续复用既有字幕接口；通过固定版本的 ASR 扩展接口复用安装、CPU 自检与受限转写进程。https://github.com/XZXZZX-Ai/bilibili-mcp
- `CZX2244/dsh-bilibili`，MIT，提交 `c53af9dee30cf04ee759ac6857d5803196fb2a95`：仅复用纯函数 `lib/keyframes.js`，保留 `vendor/dsh-bilibili/LICENSE` 和 SOURCE.json。没有安装其工具注册、系统提示词、登录或必剪接口，避免重复入口。
- FFmpeg 6.1.1：通过 ffmpeg-static 固定发布工件取得 Windows x64 解码器；作为独立进程使用，记录二进制 SHA256。https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- faster-whisper 1.2.1、CTranslate2 4.8.0、PyAV 18.1.0；完整依赖版本见 `scripts/video-requirements.lock.txt`。PyAV 19 移除 metadata_errors，现用 faster-whisper 尚不兼容，实际自检复现后固定兼容版本，未修改其安装源码。https://github.com/SYSTRAN/faster-whisper/issues/1589
- 模型 Systran/faster-whisper-base，固定 revision `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66`；下载大文件验证作者 LFS SHA256。
- 便携 Python 3.12.10：官方 NuGet 构建包，安装时核对官方目录 SHA512。不改系统 Python、PATH 或 CUDA 驱动。
- DeepSeek 官方图像接口：https://api-docs.deepseek.com/guides/vision/ 。实际通过 DSH 公开附件和 llm.stream 服务发送图片，沿用当前模型选择，不另存 API 密钥。

自研部分是来源与区间管理、统一活动适配、分段观察、暂停接续、缓存/证据额度与真实回执；没有自研语音识别、视频解码或视觉基础模型。

0.19.1：大视频改用受限的本机Range转发与FFmpeg原生HTTP seekable/multiple_requests能力，保持原预算和来源白名单；不新增常驻服务。已核验随项目固定的6.1.1参数。参考：https://ffmpeg.org/ffmpeg-protocols.html#http 。

0.20.0：音频复用本插件受限Range relay，用FFmpeg输入seek裁出有界PCM窗口，再调用固定faster-whisper运行时；不下载完整音轨。实际43,179,110字节音轨抽取1800–1820秒读取404,531字节。
