import {QQAccountClient,opaque} from '@ai-friend/qq-bridge/accounts';
export {opaque};
// bili_* 操作的 prepare/write/verify 已随 B站功能迁入 @ai-friend/bilibili-tool，
// 由 Platforms.clientFor(action) 分发到注册的 BiliPlatformOperations。
export class PlatformClients extends QQAccountClient{
 constructor({adapter,media,request=fetch}){super({channel:adapter.qq,instance:adapter.activities.instance,store:adapter.platforms?.store,media,request,checkReply:(...args)=>adapter.qqReplyIntegrity?.operation(...args)});this.adapter=adapter;}
 async prepare(op,signal){this.store=this.adapter.platforms.store;return super.prepare(op,signal);}
 async verify(op,signal){this.store=this.adapter.platforms.store;return super.verify(op,signal);}
}
