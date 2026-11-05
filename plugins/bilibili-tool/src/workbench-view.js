import {hash,noSecret,UUID} from './util.js';
import {activityConfig} from './activity-config.js';
import {accountPolicy} from './bilibili-account-store.js';
import {applyConfigRequest,configFields,configRequestSchema} from './console.js';
import {videoCoverage,mergeRanges} from './video-coverage.js';
import {effectiveVideoConfig,readVideoSettings,videoSettingFields} from './video-config.js';
const parse=v=>{try{return v?JSON.parse(v):null;}catch{return null;}};
export function visibleText(v,max=1200){if(typeof v!=='string')return '';try{noSecret(v);if(/(?:cookie|authorization|sessdata|bili_jct|access_token|api_key)\s*[:=]|[?&](?:token|auth|secret|signature)=|[A-Z]:[\\/]/i.test(v))return '【包含凭据或本机路径，已隐藏】';}catch{return '【包含凭据，已隐藏】';}return v.slice(0,max)+(v.length>max?'…':'');}
const integer=(n,max=100000000)=>Number.isFinite(n)&&n>=0&&n<=max?n:null;
const validId=id=>typeof id==='string'&&UUID.test(id);
const terminal=new Set(['completed','completed_with_gaps','stopped','cancelled','failed']);
const commandKey='bili-workbench:commands:v1';
const at=r=>r.updated_at??r.created_at??null;
function issue(status,message){return Object.assign(Error(message),{status});}
function readCommands(db){const value=db.prepare('SELECT value FROM platform_meta WHERE key=?').get(commandKey)?.value;if(!value)return [];const rows=parse(value);if(!Array.isArray(rows)||rows.length>100)throw issue(503,'管理回执暂不可用');return rows;}
function replay(db,request){const old=readCommands(db).find(r=>r.requestId===request.requestId);if(!old)return null;if(old.fingerprint!==hash(JSON.stringify(request)))throw issue(409,'该请求编号已有不同操作');return {...old.result,replayed:true};}
function saveCommand(db,request,result){const rows=readCommands(db);rows.push({requestId:request.requestId,fingerprint:hash(JSON.stringify(request)),at:new Date().toISOString(),result});db.prepare('INSERT INTO platform_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(commandKey,JSON.stringify(rows.slice(-100)));if(request.kind==='settings'){const key='bili-workbench:config-epoch',old=db.prepare('SELECT value FROM platform_meta WHERE key=?').get(key)?.value??'0';if(!/^\d{1,14}$/.test(old))throw issue(503,'配置版本暂不可核验');db.prepare('INSERT INTO platform_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(Number(old)+1));}}

/** Owner-only bounded projection. No collect(), readiness(), platform polling or model calls. */
export class BilibiliWorkbenchView{
 constructor(controller,{sourceFile='bilibili-workbench'}={}){this.sourceFile=sourceFile;this.c=controller;this.db=controller.journal.db;this.attachments=null;}
 has(table){return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));}
 rows(table,limit=24,offset=0,where='',args=[]){if(!this.has(table))return [];return this.db.prepare('SELECT * FROM '+table+' '+where+' ORDER BY rowid DESC LIMIT ? OFFSET ?').all(...args,limit,offset);}
 count(table,where='',args=[]){return this.has(table)?this.db.prepare('SELECT count(*) n FROM '+table+' '+where).get(...args).n:0;}
 settings(db=this.db){
  const a=db.prepare('SELECT * FROM activity_control WHERE id=1').get(),i=db.prepare('SELECT * FROM bili_inbox_control WHERE id=1').get(),s=db.prepare("SELECT value FROM bili_social_meta WHERE key='outgoing'").get(),ac=db.prepare('SELECT * FROM bili_account_control WHERE id=1').get();
  const values={activity:{automatic:a?.automatic==null?this.c.activities.config.automatic:a.automatic===1,...activityConfig({...this.c.activities.config,...parse(a?.policy_json)})},inbox:{enabled:i?.enabled==null?this.c.bilibiliInbox.config.enabled:i.enabled===1},social:{outgoing:s?s.value==='true':this.c.bilibiliSocial.config.outgoing},account:accountPolicy({...this.c.accountActions.store.config,...parse(ac?.policy_json)})};
  values.activity.automatic=a?.automatic==null?this.c.activities.config.automatic:a.automatic===1;
  const video=effectiveVideoConfig(db,this.c.activities.video?.baseConfig??this.c.activities.video?.config??{}),videoPolicy=readVideoSettings(db);
  values.video=Object.fromEntries(videoSettingFields.map(f=>[f.key,video[f.key]]));
  const active=this.c.activities.active,activeConfig=active?.videoConfigSnapshot??null,activeBatch=active?{id:active.id??null,settings:activeConfig?Object.fromEntries(videoSettingFields.map(f=>[f.key,activeConfig[f.key]])):null}:null;
  const groups=Object.fromEntries(configFields.map(g=>[g.group,Object.fromEntries(g.fields.map(f=>[f.key,values[g.group][f.key]??null]))]));
  const epoch=this.has('platform_meta')?db.prepare("SELECT value FROM platform_meta WHERE key='bili-workbench:config-epoch'").get()?.value??'0':'0';
  return {revision:hash(JSON.stringify({groups,epoch,videoRevision:videoPolicy.revision})),values:groups,fields:configFields,video:{...values.video,policyRevision:videoPolicy.revision,activeBatch},notice:'视频参数保存后用于新批次；正在执行及从检查点恢复的同一批次保留原采样设置，不重启项目。'};
 }
 reading(row){const r=this.c.activities.readings.get(row.id);if(!r)throw issue(404,'观看任务不存在');return r;}
 task(row,continuous=false){
  if(continuous){let r;try{r=this.reading(row);}catch{return {id:row.id,kind:'continuous',status:'unverified',title:'记录暂不可核验',at:at(row),controllable:false,ranges:[],frameCount:0};}
   const coverage=r.coverage;return {id:r.id,kind:'continuous',revision:r.revision,status:r.status,title:visibleText(r.video?.title,300)||r.video?.bvid||'连续观看',bvid:r.video?.bvid,page:r.video?.page??1,activityRef:{kind:'reading',id:r.id},durationSeconds:integer(r.video?.durationSeconds),processedSeconds:integer(coverage?.processedSeconds)??0,ranges:coverage?.processedRanges??[],frameCount:integer(coverage?.frameCount)??0,passes:r.passes.length,sourceGaps:coverage?Boolean(coverage.hasSourceGaps||coverage.hasInterpretationGaps):null,summary:visibleText(r.summary,1600),reason:visibleText(r.reason,700),at:r.updatedAt,controllable:!terminal.has(r.status),live:this.c.activities.active?.id===r.currentRunId};}
  const request=parse(row.request_json)??{},decision=parse(row.decision_json)??{},result=parse(row.result_json)??{},session=this.has('activity_video_sessions')?parse(this.db.prepare('SELECT state_json FROM activity_video_sessions WHERE run_id=?').get(row.id)?.state_json):null;
  let obs=null;try{if(row.observation_id)obs=this.c.activities.store.observation(row.observation_id)?.payload;}catch{}
  const info=session?.info??obs?.video??{},segments=this.has('activity_video_segments')?this.db.prepare('SELECT payload_json FROM activity_video_segments WHERE run_id=? ORDER BY ordinal LIMIT 48').all(row.id).map(s=>parse(s.payload_json)).filter(Boolean):[];
  const ranges=mergeRanges(segments.filter(s=>s.language?.text||s.frames?.length).map(s=>[s.startSeconds,s.endSeconds]),integer(info.durationSeconds)??1e8);
  const bvid=info.bvid??obs?.bvid??decision.selectedTarget?.bvid??request.video?.bvid;
  return {id:row.id,kind:'run',activityRef:{kind:'run',id:row.id},status:row.status,title:visibleText(info.title??obs?.title,300)||bvid||'浏览与探索任务',bvid:/^BV[a-zA-Z0-9]{10}$/.test(bvid??'')?bvid:null,page:info.page??obs?.page??1,durationSeconds:integer(info.durationSeconds),processedSeconds:ranges.reduce((n,[a,b])=>n+b-a,0),ranges,frameCount:segments.reduce((n,s)=>n+(s.frames?.length??0),0),summary:visibleText(result.summary,1600),reason:visibleText(row.error,700),at:at(row),controllable:false,live:this.c.activities.active?.id===row.id,observationId:row.observation_id??null};
 }
 tasks(limit=24,offset=0){
  const pieces=[];if(this.has('activity_video_readings'))pieces.push("SELECT 'continuous' kind,id,updated_at at FROM activity_video_readings");
  if(this.has('activity_runs'))pieces.push("SELECT 'run' kind,id,updated_at at FROM activity_runs"+(this.has('activity_video_readings')?" WHERE NOT EXISTS(SELECT 1 FROM activity_video_readings r WHERE r.root_run=activity_runs.id OR r.id=json_extract(activity_runs.request_json,'$.continuousReadingId'))":''));
  if(!pieces.length)return {items:[],total:0,hasMore:false};
  const sql=pieces.join(' UNION ALL '),total=this.db.prepare('SELECT count(*) n FROM ('+sql+')').get().n,rows=this.db.prepare('SELECT * FROM ('+sql+') ORDER BY at DESC,id DESC LIMIT ? OFFSET ?').all(limit,offset);
  return {items:rows.map(r=>this.task(this.db.prepare('SELECT * FROM '+(r.kind==='continuous'?'activity_video_readings':'activity_runs')+' WHERE id=?').get(r.id),r.kind==='continuous')),total,hasMore:offset+rows.length<total,notice:'按近期任务显示；目录发现不计为实际观看。'};
 }
 turnFor(event){if(!this.has('bili_social_turns'))return null;return this.db.prepare("SELECT * FROM bili_social_turns WHERE EXISTS(SELECT 1 FROM json_each(event_ids) WHERE value=?) ORDER BY rowid DESC LIMIT 1").get(event.id);}
 event(row){
  const p=parse(row.payload_json)??{},t=this.turnFor(row),d=parse(t?.decision_json)??{},out=t&&this.has('bili_social_outbox')?this.db.prepare('SELECT * FROM bili_social_outbox WHERE turn_id=?').get(t.id):null,receipt=parse(out?.receipt_json)??{};
  let status='待关注';if(out){status=out.status==='sent'?'已回应':['unknown','unconfirmed','rejected','failed'].includes(out.status)?'异常':'待发送';}else if(t?.status==='deferred'||row.status==='deferred')status='暂缓';else if(t?.status==='ignored'||d.disposition==='ignore')status='已放下';else if(['failed','quarantined','interrupted'].includes(row.status)||t?.error)status='异常';else if(['coalesced','superseded'].includes(row.status))status='已合并';else if(row.status==='withdrawn')status='已撤回';else if(t?.status==='thinking')status='处理中';
  const linked=this.has('attention_intents')?this.db.prepare("SELECT * FROM attention_intents WHERE kind='bilibili' AND (json_extract(payload_json,'$.eventId')=? OR json_extract(payload_json,'$.turnId')=?) ORDER BY rowid DESC LIMIT 1").get(row.id,t?.id??''):null,result=parse(linked?.result_json)??{};
  if(!out&&linked?.status==='waiting'&&result.waitSource==='model')status='暂缓';
  if(!out&&linked?.status==='dismissed'&&result.waitSource==='dismissed')status='已放下';
  return {id:row.id,kind:row.kind,sender:visibleText(row.sender,60),text:visibleText(p.text,2000),at:row.created_at,status,platformStatus:row.status,turnId:t?.id??null,disposition:visibleText(d.disposition,40),reason:visibleText(d.reason??d.summary??result.reason,900),error:visibleText(out?.error??t?.error??row.error,600),wakeAt:integer(t?.due_at,1e14),outbox:out?{id:out.id,status:out.status,body:visibleText(receipt.publishedBody??out.body,2000),readBackVerified:receipt.readBackVerified===true,at:at(out)}:null,scope:row.kind==='private'?'私信':'公开线程'};
 }
 action(row,platform=false){
  let v=platform?row:parse(row.value_json)??{};if(!platform&&this.c.accountActions?.store?.get)try{v=this.c.accountActions.store.get(row.id);}catch{return {id:row.id,kind:'account',status:'unverified',action:'记录暂不可核验',at:at(row)};}
  const args=platform?parse(row.args_json)??{}:v,receipt=platform?parse(row.receipt_json)??{}:v.receipt??{};
  const attempt=!platform&&this.has('bili_account_attempts')?this.db.prepare('SELECT dispatched FROM bili_account_attempts WHERE action_id=?').get(row.id):null;
  return {id:row.id,kind:platform?'platform':'account',action:visibleText(v.action,60),status:row.status,at:at(row)??v.createdAt,reason:visibleText(v.reason,900),target:visibleText(String(args.bvid??args.uid??args.targetUid??args.text??v.bvid??v.uid??''),400),dispatched:platform?Boolean(row.dispatched):Boolean(v.apiAccepted)||attempt?.dispatched===1,verified:platform?receipt.verified===true:row.status==='confirmed',receipt:visibleText(receipt.summary??receipt.message,700),error:visibleText(v.error,600)};
 }
 actions(limit=24,offset=0){const pieces=[];if(this.has('bili_account_actions'))pieces.push("SELECT 'account' kind,id,updated_at at FROM bili_account_actions");if(this.has('platform_operations'))pieces.push("SELECT 'platform' kind,id,created_at at FROM platform_operations WHERE substr(action,1,5)='bili_'");if(!pieces.length)return {items:[],hasMore:false};const sql=pieces.join(' UNION ALL '),rows=this.db.prepare('SELECT * FROM ('+sql+') ORDER BY at DESC,id DESC LIMIT ? OFFSET ?').all(limit,offset);return {items:rows.map(r=>this.action(this.db.prepare('SELECT * FROM '+(r.kind==='platform'?'platform_operations':'bili_account_actions')+' WHERE id=?').get(r.id),r.kind==='platform')),hasMore:offset+rows.length<this.db.prepare('SELECT count(*) n FROM ('+sql+')').get().n};}
 snapshot({section='overview',offset=0,limit=24}={}){
  if(!['overview','watch','inbox','actions','settings'].includes(section)||!Number.isSafeInteger(offset)||offset<0||offset>10000||!Number.isSafeInteger(limit)||limit<1||limit>48)throw issue(400,'分页参数无效');
  const ctl=this.has('bili_inbox_control')?this.db.prepare('SELECT * FROM bili_inbox_control WHERE id=1').get():null,day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const active=this.c.activities.active,choices=[],outstanding=this.count('bili_inbox_events',"WHERE status IN ('queued','processing','deferred')");
  const result={schema:'ai-friend/bilibili-workbench/1',generatedAt:new Date().toISOString(),section,day,connection:{accountId:visibleText(ctl?.account_id,40),bound:Boolean(ctl?.account_id),polling:Boolean(this.c.bilibiliInbox.polling),updatedAt:ctl?.updated_at??null,nextPollAt:ctl?.next_poll_at??null,failures:ctl?.failures??null,error:visibleText(ctl?.last_error,500),notice:'只读收件记录；本页未主动验证登录有效性。'},current:{activeId:active?.id??null,phase:visibleText(active?.phase,100),paused:Boolean(active?.paused),choice:choices[0]??null},counts:{outstanding,events:this.count('bili_inbox_events'),tasks:this.count('activity_video_readings')+this.count('activity_runs'),accountActions:this.count('bili_account_actions'),platformActions:this.count('platform_operations',"WHERE action LIKE 'bili_%'")},choices,paging:{offset,limit},notice:'只展示已有任务、简短选择依据和平台回执；刷新不会唤醒任务或调用模型。'};
  if(['overview','watch'].includes(section)){const tasks=this.tasks(section==='overview'?6:limit,offset);result.tasks=tasks.items;result.counts.tasks=tasks.total;result.paging.hasMore=tasks.hasMore;}
  if(['overview','inbox'].includes(section)){result.events=this.rows('bili_inbox_events',section==='overview'?6:limit,offset).map(r=>this.event(r));result.paging.hasMore=offset+result.events.length<result.counts.events;}
  if(['overview','actions'].includes(section)){const actions=this.actions(section==='overview'?6:limit,offset);result.actions=actions.items;if(section==='actions')result.paging.hasMore=actions.hasMore;}
  if(section==='settings')result.settings=this.settings();
  return result;
 }
 detail(id,kind='task'){
  if(!validId(id)||!['task','event','action','platform'].includes(kind))throw issue(400,'记录参数无效');
  if(kind==='event'){const r=this.has('bili_inbox_events')?this.db.prepare('SELECT * FROM bili_inbox_events WHERE id=?').get(id):null;if(!r)throw issue(404,'记录不存在');return {kind,event:this.event(r)};}
  if(kind==='action'||kind==='platform'){const table=kind==='action'?'bili_account_actions':'platform_operations',r=this.has(table)?this.db.prepare('SELECT * FROM '+table+' WHERE id=?').get(id):null;if(!r||kind==='platform'&&!String(r.action).startsWith('bili_'))throw issue(404,'记录不存在');return {kind,action:this.action(r,kind==='platform')};}
  const reading=this.has('activity_video_readings')?this.db.prepare('SELECT * FROM activity_video_readings WHERE id=?').get(id):null,run=this.db.prepare('SELECT * FROM activity_runs WHERE id=?').get(id);
  if(!reading&&!run)throw issue(404,'任务不存在');
  const r=reading?this.reading(reading):null,task=reading?this.task(reading,true):this.task(run),observations=r?this.c.activities.readings.observations(r):run?.observation_id?[this.c.activities.store.observation(run.observation_id)].filter(Boolean):[];
  const segments=observations.flatMap(o=>(o.payload.video?.segments??[]).map(s=>({...s,observationId:o.id}))),coverage=r?videoCoverage(r.video,segments):null;
  const frames=segments.flatMap(s=>(s.frames??[]).map(f=>({seconds:f.seconds,description:visibleText(f.description,700),sha256:/^[a-f0-9]{64}$/.test(f.sha256??'')?f.sha256:null,observationId:s.observationId}))).slice(0,48);
  const language=segments.slice(0,24).map(s=>({startSeconds:s.startSeconds,endSeconds:s.endSeconds,source:visibleText(s.language?.source,50),text:visibleText(s.language?.text,2500),truncated:s.language?.truncated===true,observationId:s.observationId,sequence:visibleText(s.sequence?.summary,1400)}));
  return {kind:'task',task,frames,language,coverage,chapters:(r?.chapters??[]).slice(0,32).map(c=>({startSeconds:c.startSeconds,endSeconds:c.endSeconds,summary:visibleText(c.summary,1200),observationIds:(c.observationIds??[]).filter(validId)})),unresolved:(r?.unresolved??[]).slice(0,16).map(v=>visibleText(v,600)),limits:'最多展示48张既存画面、24段语言原件和32个派生章节。字幕与画面是原件；章节与摘要是派生理解，不等于逐帧理解，也未直接理解声音语气与配乐。'};
 }
 async frame(taskId,observationId,sha,signal){
  if(!validId(taskId)||!validId(observationId)||!/^[a-f0-9]{64}$/.test(sha??''))throw issue(400,'画面参数无效');
  const detail=this.detail(taskId),frame=detail.frames.find(f=>f.sha256===sha&&f.observationId===observationId);if(!frame)throw issue(404,'画面不在当前任务的已显示原件中');
  const observation=this.c.activities.store.observation(observationId),f=observation.payload.video.segments.flatMap(s=>s.frames??[]).find(f=>f.sha256===sha);
  if(!f?.attachment||!this.attachments)throw issue(404,'画面附件暂不可用');
  const stored=await this.attachments.readImage(f.attachment,signal),data=Buffer.from(stored.data),mediaType=stored.ref?.mediaType??f.attachment.mediaType;
  if(!['image/jpeg','image/png','image/webp'].includes(mediaType)||data.length>4*1024*1024||hash(data)!==sha)throw issue(503,'画面原件校验未通过');
  return {data,mediaType};
 }
 writeAllowed(){const enabled=typeof this.c.writeEnabled==='function'?this.c.writeEnabled():this.c.writeEnabled;if(enabled!==true)throw issue(403,'当前实例未开放管理写入');}
 command(request){
  this.writeAllowed();if(!request||!validId(request.requestId))throw issue(400,'管理请求编号无效');
  const old=replay(this.db,request);if(old)return old;
  if(request.kind==='settings'){
   if(typeof request.expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(request.expectedRevision))throw issue(400,'配置版本无效');
   let previousValues;
   const result=applyConfigRequest(this.c.instance,{schema:configRequestSchema,source:'web-ui',changes:request.changes},{
    sourceFile:this.sourceFile,beforeApply:db=>{const previous=replay(db,request);if(previous)throw Object.assign(Error('replayed'),{replayedResult:previous});const current=this.settings(db);if(current.revision!==request.expectedRevision)throw issue(409,'配置已在其他窗口改变，请刷新后重新确认');previousValues=current.values;},
    recordApplied:(db,result)=>saveCommand(db,request,{ok:true,kind:'settings',applied:result.applied.map(a=>({...a,previous:previousValues[a.group][a.key]})),at:result.at})
   });
   const policy=this.c.activities.store.policy();this.c.activities.config=activityConfig({...this.c.activities.config,...policy});
   let resourceReconsideration='not_needed';if(result.applied.some(a=>a.group==='activity'))try{this.c.activities.wakeResources?.();resourceReconsideration='requested';}catch{resourceReconsideration='failed';}
   result.resourceReconsideration=resourceReconsideration;
   return {ok:true,kind:'settings',...result,notice:result.applied.some(a=>a.group==='video')?'设置已保存；视频新参数从后续批次生效，当前批次和已有观察保留，无需重启。':'设置已保存并生效，无需重启。'};
  }
  if(request.kind!=='reading'||!validId(request.id)||!['pause','resume'].includes(request.action)||!Number.isSafeInteger(request.expectedRevision))throw issue(400,'观看管理参数无效');
  return this.c.journal.transaction(()=>{
   const previous=replay(this.db,request);if(previous)return previous;
   const r=this.c.activities.readings.get(request.id);if(!r)throw issue(404,'观看任务不存在');if(r.revision!==request.expectedRevision)throw issue(409,'观看任务已有新进度，请刷新后再操作');if(terminal.has(r.status))throw issue(409,'已结束任务不会重新启动');if(request.action==='resume'&&r.status!=='paused'||request.action==='pause'&&r.status==='paused')throw issue(409,'任务状态已变化');
   const controlled=this.c.activities.readings.control(r.id,request.action,'主用户在DSH的B站工作台明确'+(request.action==='pause'?'暂停':'恢复')+'任务');
   const result={ok:true,kind:'reading',id:r.id,action:request.action,revision:controlled.reading.revision,status:controlled.reading.status,notice:request.action==='resume'?'已恢复为可选择事项；由她决定何时续看。':'已暂停，已有观察与记忆保留。'};saveCommand(this.db,request,result);return result;
  });
 }
}
