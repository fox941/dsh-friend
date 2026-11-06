import path from 'node:path';

const readers=new Map();
const key=root=>process.platform==='win32'?path.resolve(root).toLowerCase():path.resolve(root);
export function registerRuntimeHealth(root,read){const id=key(root);if(readers.has(id))throw Error('本实例已有运行健康提供器');readers.set(id,read);return ()=>{if(readers.get(id)===read)readers.delete(id);};}
export function readRuntimeHealth(root){const read=readers.get(key(root));if(!read)return {available:false,reason:'插件尚未完成加载'};try{return {available:true,...read()};}catch{return {available:false,reason:'运行快照暂不可用'};}}

/** Metadata only. No model/network requests, queue mutations, or message text. */
export function companionRuntimeHealth(adapter,now=Date.now()){
 const policy=adapter.policy(),spaces=policy.spaces.filter(s=>s.active),qq=adapter.qq.status(),inbox=adapter.bilibiliInbox;
 const bili=inbox?.store.control();
 return {schema:'ai-friend/runtime-health/1',checkedAt:new Date(now).toISOString(),identity:adapter.growth.store.meta('identity'),
  ...adapter.nightly?.materials?{nightlyMaterials:adapter.nightly.materials.health()}:{},
  memory:{configured:policy.enabled,writeEnabled:policy.writeEnabled,activeSpaces:spaces.length,
    stores:spaces.slice(0,4).map(s=>({id:s.id,readable:adapter.client.presence(s.id)!==null})),partial:spaces.length>4},
  qq:{enabled:qq.enabled,connected:qq.connected,accountVerified:qq.accountVerified,issue:Boolean(qq.lastError),reliability:qq.reliability??null,socialMemory:adapter.platforms?.socialMemory?.status()??null},
  bilibili:{enabled:Boolean(inbox?.store.enabled(inbox.config.enabled)),accountBound:Boolean(bili?.account_id),
    inboxHostReady:Boolean(inbox?.host)&&!inbox?.closed,socialHostReady:Boolean(adapter.bilibiliSocial?.host)&&!adapter.bilibiliSocial?.closed,activityHostReady:Boolean(adapter.activities?.host)&&!adapter.activities?.closed,lastPollAt:bili?.updated_at??null,
    polling:Boolean(inbox?.polling),nextPollAt:bili?.next_poll_at??null,failures:bili?.failures??0,issue:Boolean(bili?.last_error)},
  socialExperience:adapter.socialExperience?.status()??null,
  profileChanges:{hostReady:Boolean(adapter.profileChanges?.host),running:Boolean(adapter.profileChanges?.active),issue:Boolean(adapter.profileChanges?.lastError)},
  profileNotices:{hostReady:Boolean(adapter.profileNotices?.host),running:Boolean(adapter.profileNotices?.active),issue:Boolean(adapter.profileNotices?.lastError)},
  workshop:adapter.workshop?{enabled:adapter.workshop.status().enabled,running:Boolean(adapter.workshop.running),registeredTools:adapter.workshop.status().registered.length,autonomy:adapter.workshopAutonomy?.resources()??null}:null,
  models:adapter.diagnostics.progress(),
  activity:{running:Boolean(adapter.activities.active),paused:Boolean(adapter.activities.active?.paused)},
  scope:'只读技术状态；主动沉默、安静、暂停或等待不属于故障，不修改行为优先级、记忆或发送回执'};
}
