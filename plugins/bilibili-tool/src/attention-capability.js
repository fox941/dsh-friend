// B站分支从宿主 attention-host 迁出的统一注意力能力条目。
// 语义与迁移前逐字一致；由宿主在 platform 内建分支之后按注册表分发。
const yieldingVideoParent=(current,target,activity)=>Boolean(activity?.id&&activity.phase&&activity.parentMessage&&current.kind==='message'&&current.payload.sessionId===activity.parentMessage.sessionId&&current.payload.message?.id===activity.parentMessage.messageId&&!(target.kind==='message'&&target.payload.sessionId===activity.parentMessage.sessionId));

const plainBrowse=row=>row.kind==='browse'&&!['platformActionId','platformEventId','biliActionId','requestId','runId'].some(k=>row.payload[k]!==undefined);
const unsupportedDocument={waiting:true,resource:'external_document',wake:{kind:'capability_change'},reason:'本任务需要网页或论文原文读取；当前自主浏览只接入B站视频，保留待办等待相应能力，不以教程视频代替，也未消耗观看额度'};
export function bilibiliAttentionCapability(c){
 return {
  routing(row){return plainBrowse(row)?{required:true,supported:['bilibili_video'],unavailable:['external_document'],meaning:'必须按真实任务选择执行对象：B站视频或网页/论文文档；不能用检索教程替代真实文档'}:undefined;},
  availability(row){if(!plainBrowse(row))return;if(row.result?.executionTarget==='external_document')return unsupportedDocument;if(!c.activities.active)return c.activities.readiness?.('automatic');},
  stateKey(){return `${c.activities.readings?.revisionKey()??'0'}:${c.activities.browsing?.revisionKey()??'0'}:${c.accountActions?.store.revisionKey()??'0'}`;},
  frame(){const activity=c.activities.active;return {continuousVideoReadings:c.activities.readings?.status()??null,bilibiliAccountOperations:c.accountActions?.status()??null,browsingAgenda:c.activities.browsing?.context()??null,browsingResources:c.activities.resources?.()??null,currentActivity:activity?{id:activity.id,trigger:activity.trigger,paused:Boolean(activity.paused),phase:activity.phase??null,canPauseAtCheckpoint:true,parentWaitingForVideo:Boolean(activity.parentMessage)}:null};},
  capabilities(){return ['bilibili','browse'];},
  boundary:'browse中明确标记biliActionId的事项是收藏/关注账号操作或只读核验，并非观看；可执行、暂缓或放弃，不能把候选当作已提交；其余browse可从待看/续看与未解疑问中选择继续，也可按关键词、精确UP主UID的投稿首页、AI账号收藏、首页推荐或关注动态发现视频；浏览意图不是事实，finished不代表看完整片，主用户暂停项不能自动恢复；主用户最新投稿请求绑定已有B站UID，不能用昵称或泛搜索冒充。目录只是一页元数据，可能包含联合投稿，不证明唯一作者，也不代表已观看。可以暂缓、休息或先做其他事。B站观察可能包含字幕、语音转写及抽样画面，实际范围以回执为准，不等于逐帧看完整片；',
  busyKinds:['bilibili'],
  busyPayloadKeys:['biliActionId'],
  yieldException(running,row){return yieldingVideoParent(running,row,c.activities.active);},
  preview(row){const runId=row.payload.runId??(row.payload.requestId?c.activityRequests.get(row.payload.requestId)?.run_id:null),reading=runId?c.activities.readings?.get(runId):null;if(reading)return JSON.stringify(c.activities.readings.public(reading));
   if(row.payload.biliActionId)return JSON.stringify({biliActionId:row.payload.biliActionId,action:c.accountActions.store.get(row.payload.biliActionId)?.action,readOnlyCheck:row.payload.readOnlyCheck===true});
   if(row.kind==='bilibili')return c.bilibiliInbox.store.event(row.payload.eventId)?.payload.text.slice(0,700)??null;
   return undefined;
  },
  dismiss(row){
   if(row.payload.biliActionId){c.accountActions?.dismiss(row);return true;}
   if(row.kind==='bilibili'){c.bilibiliInbox.store.db.prepare("UPDATE bili_inbox_events SET status='attention_ignored',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(),row.payload.eventId);return true;}
   return false;
  },
  readiness(row,signal){
   if(plainBrowse(row)&&row.result?.executionTarget==='external_document')return unsupportedDocument;
   if(row.payload.biliActionId){const ready=c.accountActions.readiness(row);if(ready?.waiting)return ready;}
   if(row.kind==='browse'&&row.payload.runId){const reading=c.activities.readings?.get(row.payload.runId),ready=reading?c.activities.readings.readiness(reading):null;if(ready?.waiting)return ready;}
   if(row.kind==='browse'&&row.payload.requestId){const request=c.activityRequests.get(row.payload.requestId),reading=request?.run_id?c.activities.readings?.get(request.run_id):null;const ready=reading?c.activities.readings.readiness(reading):c.activityRequests.readiness(row);if(ready?.waiting)return ready;}
   if(row.kind==='browse'&&!row.payload.platformActionId&&!row.payload.platformEventId&&!row.payload.biliActionId&&!row.payload.requestId&&!row.payload.runId&&!c.activities.active){const ready=c.activities.readiness?.('automatic');if(ready?.waiting)return ready;}
   return undefined;
  },
  pausesActivity(row){return Boolean(row.payload.biliActionId);},
  resume(row){if(row.kind==='browse'&&!row.payload.biliActionId&&!row.payload.platformActionId&&!row.payload.platformEventId){c.activities.resumeForAttention();return true;}return false;},
  claims(row){return row.kind==='bilibili'||row.kind==='browse';},
  async execute(row,signal){
   if(plainBrowse(row)&&row.result?.executionTarget!=='bilibili_video')throw Error('自主浏览缺少已核验的视频执行目标，未开始B站发现或观看');
   if(row.kind==='bilibili'){
    c.bilibiliSocial.store.due({unlimited:true});
    const event=c.bilibiliInbox.store.event(row.payload.eventId);if(!event||event.status!=='queued')return {status:'source_changed'};
    c.bilibiliSocial.attentionGrant=row.payload.eventId;
    try{await c.bilibiliSocial.drive();const turn=c.bilibiliSocial.store.db.prepare("SELECT status,due_at FROM bili_social_turns WHERE EXISTS(SELECT 1 FROM json_each(event_ids) WHERE value=?) ORDER BY rowid DESC LIMIT 1").get(event.id);if(c.bilibiliInbox.store.event(event.id)?.status==='queued'){c.attention.store.patch(row.id,'waiting',{wake:{kind:'time',at:Date.now()+30000},result:{waitSource:'resource',reason:'交流执行器尚忙，原件未开始处理，稍后重新选择'}});return {pending:true};}if(turn?.status==='deferred'){c.attention.store.patch(row.id,'waiting',{wake:{kind:'time',at:Math.max(Date.now()+30000,turn.due_at)}});return {pending:true};}return {status:'processed',eventId:event.id};}finally{c.bilibiliSocial.attentionGrant=null;}
   }
   if(row.kind==='browse'){
    if(row.payload.biliActionId)return c.accountActions.execute(row,signal);
    if(row.payload.requestId)return c.activityRequests.execute(row,signal);
    const active=c.activities.active;
    if(active){if(active.attentionId!==row.id&&row.payload.runId!==active.id){c.attention.store.patch(row.id,'waiting',{wake:{kind:'task_end'},result:{waitSource:'resource',reason:'同一个浏览执行器已有未完任务，完成后重新判断'}});return {pending:true};}c.activities.resumeForAttention();return active.promise;}
    const resume=row.payload.runId?c.activities.store.get(row.payload.runId):null;
    const reading=resume?c.activities.readings?.get(resume.id):null;if(reading)return c.activities.readings.execute(reading.id,signal);
    if(resume&&!['paused','interrupted'].includes(resume.status))return {status:resume.status,activityId:resume.id,result:resume.result};
    const promise=c.activities.run(resume?.request??(row.payload.topic?{query:row.payload.topic}:{}),resume?.trigger??'automatic',signal,{resume});
    if(c.activities.active)c.activities.active.attentionId=row.id;
    const result=await promise;if(result?.status==='busy'){c.attention.store.patch(row.id,'waiting',{wake:{kind:'time',at:Date.now()+30000},result:{...result,waitSource:'resource'}});return {pending:true};}return result;
   }
   return undefined;
  },
  collect(){c.activityRequests?.collect();c.accountActions?.collect();},
 };
}
