import {socialProfileSource} from './profile-social-source.js';
import {hash,noSecret} from './validation.js';
import {eligibleHeader} from './preview-sessions.js';
import {ownerIdentity} from './source-identity.js';
import {verifyReportSources} from './apply-evidence.js';
import {noSocialLearning} from '@ai-friend/qq-bridge/social-memory-store';
const words=e=>(e?.data?.content??[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n');
export const changeCue=text=>/(?:更正|纠正|改成|改为|改叫|改回|换成|换个称呼|别叫|不要叫|不叫我|不再|不喜欢|不爱|撤回|作废|别再|不要再|不算了|取消.{0,12}(?:称呼|偏好|约定)|忘掉|忘记.{0,12}(?:这条|偏好|称呼)|以后.{0,12}叫我|以后.{0,12}称呼我)/.test(text);
export const sceneChange=text=>/(?:这个群|本群|在群[里内]|这个平台|本平台|这个评论区|本评论区|这里|这儿|仅限|只在|仅在|这次|本次|临时)/.test(text);
export class ProfileChangeSources{
 constructor(adapter,host=()=>null){Object.assign(this,{a:adapter,host});}
 async qq(row,signal){
  const a=this.a,q=a.qq?.binding,persistence=this.host()?.persistence;if(!q||!persistence?.open||row.binding_id!==q.id||row.event_seq==null||!['replied','silent'].includes(row.status))return null;
  const handle=await persistence.open(row.session_id,'read',{signal});try{
   if(!eligibleHeader(handle.header,a.workspace)||handle.header.id!==q.session_id)return null;const e=(await handle.read(row.event_seq,1,{signal})).events[0],identity=ownerIdentity(e,handle.header);
   if(!identity||identity.channel!=='qq'||identity.qq?.recovery||identity.qq?.senderQQ!==q.owner_qq||identity.qq?.botQQ!==q.bot_qq||e.data.id!==row.message_id||e.sourceEventSeqs?.length||words(e)!==row.body)return null;
   const proof={id:'event:'+hash(row.session_id+':'+e.seq+':user_message'),kind:'user_message',sessionId:row.session_id,seq:e.seq,messageId:e.data.id,occurredAt:new Date(e.time).toISOString(),text:row.body,contentHash:hash(row.body),...identity};
   return this.seal({key:'qq:'+row.message_id,channel:'qq',eventId:row.id,scene:'qq-private:'+q.bot_qq+':'+q.owner_qq,subject:'main-user:'+a.growth.read().identityId,text:row.body,occurredAt:row.platform_time>0?new Date(row.platform_time*1000).toISOString():proof.occurredAt,proof});
  }finally{await handle.close();}
 }
 bili(event){const a=this.a,b=a.bilibiliSocial,q=b?.store;if(!b||!event||event.kind!=='private'||event.sender!==b.config.ownerUid||String(event.payload.account)!==String(b.inbox.store.control().account_id)||event.status==='withdrawn')return null;
  const r=q.db.prepare("SELECT id FROM bili_social_turns WHERE status IN ('published','ignored') AND EXISTS(SELECT 1 FROM json_each(event_ids) WHERE value=?) ORDER BY rowid DESC LIMIT 1").get(event.id);if(!r)return null;const turn=q.turn(r.id),events=q.events(turn);if(events.some(e=>!e||noSocialLearning(e.payload.text))||events.at(-1)?.sender!==b.config.ownerUid)return null;
  return this.seal({key:'bili:'+event.id,channel:'bilibili',eventId:event.id,turnId:turn.id,scene:'bilibili:'+turn.thread_key,subject:'main-user:'+a.growth.read().identityId,text:event.payload.text,occurredAt:new Date(event.occurred_at*1000).toISOString(),proof:q.source(turn.id)});
 }
 seal(source){if(!source.text.trim()||noSocialLearning(source.text))return null;noSecret(JSON.stringify(source));return {...source,hash:hash(JSON.stringify(source))};}
 async verify(source,signal){
  if(!source||source.subject!=='main-user:'+this.a.growth.read().identityId)throw Error('画像更正不属于当前主用户');let actual;
  if(source.transport==='qq-social')actual=await socialProfileSource(this.a,this.a.platforms?.socialMemory?.readEvent(source.eventId),s=>this.seal(s),signal);
  else if(source.channel==='qq'){const row=this.a.qq?.store.get(source.eventId);actual=await this.qq(row??{},signal);}
  else if(source.channel==='bilibili')actual=this.bili(this.a.bilibiliSocial?.inbox.store.event(source.eventId));
  if(!actual||actual.hash!==source.hash)throw Error('更正原话、账号、消息状态或范围已经变化');
  if(source.transport!=='qq-social')await verifyReportSources([actual.proof],this.host()?.persistence,this.a.workspace,signal);return actual;
 }
 async collect(store,signal){
  const a=this.a,db=a.journal.db,q=a.qq?.binding;
  if(q&&store.has('qq_inbox'))for(const r of db.prepare("SELECT * FROM qq_inbox WHERE rowid>? AND binding_id=? AND status IN ('replied','silent') AND NOT EXISTS(SELECT 1 FROM profile_change_jobs j WHERE j.source_key='qq:'||qq_inbox.message_id) ORDER BY rowid LIMIT 16").all(store.cutoff('qq-cutoff'),q.id)){
   if(noSocialLearning(r.body)||!changeCue(r.body)){store.enqueue({key:'qq:'+r.message_id,text:'',channel:'qq'},'ignored','不是更正候选，或本轮禁止保存');continue;}let source;try{source=await this.qq(r,signal);}catch{signal.throwIfAborted();continue;}if(source)store.enqueue(source);else store.enqueue({key:'qq:'+r.message_id,text:'',channel:'qq'},'ignored','不是可核验的主用户原始文字会话');
  }
  if(q&&store.has('platform_events'))for(const r of db.prepare("SELECT id FROM platform_events e WHERE rowid>? AND account=? AND sender=? AND kind IN ('group','qzone_comment') AND status IN ('sent','ignored','proposed') AND NOT EXISTS(SELECT 1 FROM profile_change_jobs j WHERE j.source_key='qq-social:'||e.id) ORDER BY rowid LIMIT 16").all(store.cutoff('qq-social-cutoff'),q.bot_qq,q.owner_qq)){
   const e=a.platforms?.socialMemory?.readEvent(r.id);if(!e)continue;if(noSocialLearning(e.body)||!changeCue(e.body)){store.enqueue({key:'qq-social:'+e.id,text:'',channel:'qq'},'ignored','非画像更正或禁止保存');continue;}let source;try{source=await socialProfileSource(a,e,s=>this.seal(s),signal);}catch{signal.throwIfAborted();continue;}if(source)store.enqueue(source);else store.enqueue({key:'qq-social:'+e.id,text:'',channel:'qq'},'ignored','原话、身份或公开范围已失效，不作为新更正来源');
  }
  const b=a.bilibiliSocial;if(b&&store.has('bili_inbox_events'))for(const r of db.prepare("SELECT id FROM bili_inbox_events e WHERE rowid>? AND sender=? AND kind='private' AND status='processed' AND EXISTS(SELECT 1 FROM bili_social_turns t WHERE t.status IN ('published','ignored') AND EXISTS(SELECT 1 FROM json_each(t.event_ids) WHERE value=e.id)) AND NOT EXISTS(SELECT 1 FROM profile_change_jobs j WHERE j.source_key='bili:'||e.id) ORDER BY rowid LIMIT 16").all(store.cutoff('bili-cutoff'),b.config.ownerUid)){
   const e=b.inbox.store.event(r.id);if(noSocialLearning(e.payload.text)||!changeCue(e.payload.text)){store.enqueue({key:'bili:'+e.id,text:'',channel:'bilibili'},'ignored','不是更正候选，或本轮禁止保存');continue;}let source;try{source=this.bili(e);}catch{signal.throwIfAborted();continue;}if(source)store.enqueue(source);else store.enqueue({key:'bili:'+e.id,text:'',channel:'bilibili'},'ignored','不是可核验的主用户私信');
  }
 }
}
