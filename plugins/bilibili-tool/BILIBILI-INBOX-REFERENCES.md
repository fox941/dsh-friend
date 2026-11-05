# B站事件接入复用

固定参考：Alterssss/dsh-bili-whale 8b0009f8ce2ebdc421afcb2e727b19ac18912ec6，MIT，vendor内保留许可证。直接提取其lossless JSON、WBI签名及私信消息规范化；请求保护去掉全局目录与配置，改为显式runtime目录和上海日期。msgfeed的来源坐标、私信分页思路参考同一提交，接口发现与队列由本项目适配。

没有安装整套whale，没有引入其默认兴趣、称呼、日记、人设、公开分享或其他写工具。事件来源为外部账号，不能取得主用户权限。
