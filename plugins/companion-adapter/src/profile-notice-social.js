import {hash} from './validation.js';
export const isSocialNotice=source=>source?.destination?.transport==='qq-social';
export function socialNoticeDestination(a,source){
 const e=a.platforms?.store.event(source.eventId),q=a.qq?.binding,p=a.platforms?.store.policy();
 if(!q||!a.qq.ready||q.active===false||q.active===0||!e||!a.platforms.socialMemory.live(e,{processed:true})||e.raw_hash!==source.proof.rawHash||e.sender!==q.owner_qq||e.account!==q.bot_qq||!a.platforms.enabled()||!p.enabled)return null;
 if(e.kind==='group'&&!p.groups.includes(String(e.raw.group_id)))return null;
 if(e.kind==='qzone_comment'&&!a.platforms.qzoneInbox.policy().enabled)return null;
 if(!['group','qzone_comment'].includes(e.kind))return null;
 const stop=a.journal.db.prepare("SELECT body FROM platform_events WHERE thread_key=? AND sender=? AND rowid>(SELECT rowid FROM platform_events WHERE id=?) ORDER BY rowid").all(e.thread_key,e.sender,e.id);
 if(stop.some(r=>r.body.trim()==='/stop'||/不要再通知/.test(r.body)))return null;
 return {channel:'qq',transport:'qq-social',kind:e.kind,eventId:e.id,account:e.account,peer:e.sender,scene:source.scene,thread:e.thread_key,...e.kind==='group'?{groupId:String(e.raw.group_id)}:{postTid:e.raw.postTid,commentSequence:e.raw.comment.sequenceId,visibility:e.raw.postVisibility}};
}
export function socialResult(job,execution){return {status:job.status,scope:job.source.mode==='scene'?'仅原群或原帖':'通用人物画像；保留既有局部约定',changes:job.status==='completed'?(job.proposal?.changes??[]).map(c=>({action:c.action,current:c.action==='replace'?c.statement:null})):[],execution:execution?{status:execution.status,applied:execution.applied,pending:execution.pending}:null,boundary:'公开结果不包含后台旧值、理由、其他画像或私聊。未完成时仅说明处理状态。'};}
export function socialOriginalResponse(a,source){const e=a.platforms.store.event(source.destination.eventId);if(!e)return [];if(e.kind==='group')return e.status==='sent'&&e.receipt?.platformId&&e.reply?[{body:e.reply,platformId:e.receipt.platformId,receipt:'OneBot返回消息ID，不代表已读'}]:[];const evidence=a.platforms.spaceMemorySource?.replyEvidence(e);return evidence?[{body:evidence.text,receipt:evidence.attribution}]:[];}
/** Same platform clients and durable operation receipts; no synthetic incoming event. */
export async function sendSocialNotice(a,source,body,{itemId,attemptId,signal,beforeSend,onDispatch,check}){
 const d=source.destination,platform=a.platforms,client=platform.clients;
 if(JSON.stringify(socialNoticeDestination(a,a.profileChanges.store.job(source.jobId).source))!==JSON.stringify(d))throw Error('原社交目标已变化');
 if(d.kind==='group'){
  const groups=await client.qq('get_group_list',{no_cache:true});if(!Array.isArray(groups)||!groups.some(g=>String(g.group_id)===d.groupId))throw Error('AI已不在原群');
  await beforeSend();check();onDispatch();const e=platform.store.event(d.eventId),ack=await client.qq('send_group_msg',{group_id:Number(d.groupId),message:[{type:'reply',data:{id:String(e.raw.message_id)}},{type:'at',data:{qq:d.peer}},{type:'text',data:{text:body}}]});
  if(!ack?.message_id)throw Object.assign(Error('群回报未取得消息ID'),{dispatched:true});return {platformId:String(ack.message_id),apiAccepted:true};
 }
 const store=platform.store,key='profile-notice-space:'+itemId+':'+attemptId,op=store.offer('qq_space_reply',{args:{userId:d.account,tid:d.postTid,commentSequence:d.commentSequence,text:body},source:{kind:'profile_notice',itemId,jobId:source.jobId},reason:'已审核的原评论画像结果回报'},key,d.account);
 if(op.dispatched||op.status!=='queued')throw Object.assign(Error('已有空间提交记录，禁止重发'),{dispatched:true});
 if(store.budget().operations>=store.policy().operationsDaily)throw Error('空间操作额度暂不可用');
 store.patch(op.id,'notice_preparing');
 const prepared=await client.prepare(op,signal);if(prepared.target.replyToQQ!==d.peer||prepared.state.visibility!==d.visibility)throw Error('原评论作者或公开范围变化');
 if(prepared.state.existingCommentId){store.patch(op.id,'noop');return {observed:true,duplicate:true,commentReference:{postAuthorQQ:d.account,postTid:d.postTid,sequenceId:prepared.state.existingCommentId},notice:'原页已有同文回复，不再次提交'};}
 await beforeSend();check();store.patch(op.id,'sending',{before:{target:prepared.target,state:prepared.state}});
 try{const receipt=await client.write(op,prepared,signal,()=>{check();store.dispatch(op.id);onDispatch();});store.patch(op.id,'accepted',{receipt});const current=store.operation(op.id);let verified;try{verified=await client.verify(current,signal);}catch{signal.throwIfAborted();}
  if(verified){platform.confirmOperation(current,verified);return {...receipt,...verified,operationId:op.id};}store.patch(op.id,'unconfirmed');return {...receipt,operationId:op.id,readBackVerified:false};
 }catch(error){const dispatched=store.operation(op.id).dispatched;store.patch(op.id,dispatched?'unknown':'failed',{error:'结果回报提交未完整核验'});if(dispatched)error.dispatched=true;throw error;}
}
export const socialNoticeRevision=a=>a.platforms?.store?hash(JSON.stringify([a.platforms.store.policy(),a.platforms.qzoneInbox?.policy(),a.qq.binding?.bot_qq,a.qq.binding?.owner_qq,a.journal.db.prepare('SELECT max(rowid) n FROM platform_events').get().n])):null;
