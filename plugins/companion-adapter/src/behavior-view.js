import {replyStatusView} from './reply-status-view.js';
import {UUID} from './validation.js';
import {viewText as clean} from './view-text.js';
import {readDiagnosticCalls} from './diagnostics-state.js';
import {readToolDiagnostics} from './diagnostics-tools.js';
const json=s=>{try{return s?JSON.parse(s):null;}catch{return null;}};
const updates=d=>Array.isArray(d?.updates)?d.updates.filter(u=>u&&typeof u==='object'&&!Array.isArray(u)):[];
const moment=value=>{const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)?new Date(n).toISOString():null;};
const kindLabel={message:'聊天消息',browse:'浏览与探索',bilibili:'B站消息',recall:'回忆',reflect:'内部反思',nightly:'记忆整理',proactive:'主动联系',goal:'目标规划'};
const phaseLabel={started:'任务开始',target_selected:'已选定视频',observation_saved:'实际观察已保存',reflection_saved:'反思记录已保存',memory_processed:'记忆处理已完成',growth_processed:'自我认识处理已完成','video:choose-window':'选择观察片段','video:language':'读取片段语言','video:frames':'采样画面','video:vision':'理解采样画面','video:segment-saved':'片段观察已保存'};
const callLabel={selection:'行为选择',expression:'表达',emotion:'感受审核',reflection:'反思',growth:'成长审核',memory:'记忆处理',activity:'浏览活动',goal:'目标规划',proactive:'主动联系',session_other:'会话调用'};

/** A bounded read view of saved choices and live metadata. Never asks readiness,
 * polls a platform, advances a clock/wake, or runs the scheduler. */
export class BehaviorView {
 constructor(adapter){this.a=adapter;this.db=adapter.journal.db;}
 has(table){return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));}
 now(){return this.a.growth.store.now().valueOf();}
 row(id){if(!this.has('attention_intents'))return null;const r=this.db.prepare('SELECT * FROM attention_intents WHERE id=?').get(id);return r&&{...r,payload:json(r.payload_json)??{},wake:json(r.wake_json),result:json(r.result_json)};}
 label(row){const p=row.payload??{};if(p.platformEventId)return 'QQ消息或空间评论';if(p.platformActionId)return '平台操作与回执';if(p.socialExperienceId)return '社交经历评价';if(p.profileNoticeId)return '画像结果告知';if(p.requestId&&row.kind==='browse')return '主用户后台阅读';if(p.runId&&row.kind==='browse')return '视频阅读任务';return kindLabel[row.kind]??'已记录事项';}
 state(row){
 const r=row.result??{},error=clean(row.error,500),reason=error||clean(r.reason??r.summary,700);let code='unknown',label='未分类状态';
 if(row.status==='waiting'){
  if(error){code='error';label='执行错误后等待';}
  else if(r.waitSource==='model'){code='model_defer';label='模型选择暂缓';}
  else if(r.waitSource==='resource'){code='resource';label='等待执行资源';}
  else {code='condition';label='等待条件，原因未分类';}
 }else if(row.status==='dismissed'){
  const known=r.waitSource==='dismissed';code=known?'model_dismiss':'dismissed_unknown';label=known?'模型选择不处理':'已放下，来源未分类';
 }else if(row.status==='failed'||row.status==='completed'&&r.status==='failed'){code='error';label='执行失败';}
 else if(row.status==='completed'){code=r.status==='silent'?'silent':'processed';label=r.status==='silent'?'表达阶段选择沉默':'已处理，送达以渠道回执为准';}
 else if(row.status==='cancelled'){code='cancelled';label='已取消';}
 else if(row.status==='paused'){code='paused';label='任务已暂停';}
 else if(row.status==='selected'){code='selected';label='已选定，尚未证明执行';}
 else if(['admitting','waking'].includes(row.status)){code='admitting';label='正在准备执行';}
 else if(row.status==='running'){code='running';label='执行阶段';}
 else if(row.status==='pending'){code='pending';label='等待选择';}
 return {code,label,reason:reason||'没有可确认的简短原因记录',reasonRecorded:Boolean(reason),notice:'只按保存的状态归类；没有回复不能据此推断心情或动机'};
 }
 wake(row){const w=row.wake;if(!w)return null;const labels={event:'新事件',task_end:'任务结束',state_change:'状态变化',change:'条件变化',qq_ready:'QQ连接就绪',activity_policy:'活动策略可用',proactive_resume:'主动联系可继续'};const at=w.kind==='time'?moment(w.at):null;return {kind:clean(w.kind,40),label:w.kind==='time'?'记录的重新考虑时间':labels[w.kind]??'其他已记录条件',at,due:at?Date.parse(at)<=this.now():null,notice:'到期或条件出现只允许重新选择，不保证届时一定回复'};}
 brief(row){return {id:row.id,kind:row.kind,label:this.label(row),scope:row.scope,summary:clean(row.summary,700),status:row.status,state:this.state(row),wake:this.wake(row),at:row.updated_at,createdAt:row.created_at};}
 decision(r){
 const d=json(r.decision_json),adopted=r.status==='committed',target=typeof d?.targetId==='string'&&UUID.test(d.targetId)?this.row(d.targetId):null;
 return {id:r.id,status:r.status,adopted,action:['start','continue','rest'].includes(d?.action)?d.action:null,reason:clean(d?.reason??r.error,700)||'没有保存的简短选择依据',error:clean(r.error,500),at:r.created_at,target:target?{id:target.id,label:this.label(target),summary:clean(target.summary,400)}:d?.targetId?{id:null,label:'目标记录当前不可用',summary:''}:null,updates:updates(d).slice(0,32).map(u=>({id:UUID.test(u.id??'')?u.id:null,action:u.action==='defer'?'defer':u.action==='dismiss'?'dismiss':'unknown',reason:clean(u.reason,700)})),notice:adopted?'已提交的行为选择；仍不证明执行或送达':'这条选择未生效，不当作已经执行或主动沉默的证据'};
 }
 connections(){
  let qq=null;try{const q=this.a.qq?.status?.();if(q){const r=q.reliability;qq={configured:q.configured===true,enabled:q.enabled===true,connected:q.connected===true,accountVerified:q.accountVerified===true,classification:clean(r?.classification,50)||'unknown',checkedAt:moment(r?.checkedAt),lastInboundAt:moment(r?.lastInboundAt),lastHeartbeatAt:moment(r?.lastHeartbeatAt),issue:clean(r?.lastIssue??q.lastError,500),notice:'连接、账号核验与入站记录分别展示；在线不证明某条消息已收件或送达'};}}catch{}
  let bilibili=null;try{const i=this.a.bilibiliInbox,c=i?.store.control();if(c)bilibili={bound:Boolean(c.account_id),polling:Boolean(i.polling),recordUpdatedAt:moment(c.updated_at),nextPollAt:moment(c.next_poll_at),failures:Number.isSafeInteger(c.failures)?c.failures:null,issue:clean(c.last_error,500),notice:'只读最近收件服务记录，本页没有主动验证B站登录有效性'};}catch{}
  return {qq,bilibili};
 }
 resources(){
  let video=null;try{const r=this.a.activities?.resources?.();if(r)video={enabled:r.enabled,automaticEnabled:r.automaticEnabled,automatic:r.automatic?{decisions:r.automatic.decisions,decisionLimit:r.automatic.decisionLimit,explorations:r.automatic.explorations,explorationLimit:r.automatic.explorationLimit,nextAfterCooldown:moment(r.automatic.nextAfterCooldown)}:null,manual:r.manual?{used:r.manual.used,limit:r.manual.limit,nextAfterCooldown:moment(r.manual.nextAfterCooldown)}:null};}catch{}
  const used=this.a.growth.store.budget(),limit=this.a.growth.config.dailyReviewLimit;return {video,growth:{used,limit,remaining:Math.max(0,limit-used)},notice:'资源数值与已记录的等待原因分别看待；额度不足不自动证明某条消息因此未处理'};
 }
 runFor(row){const p=row.payload??{};if(UUID.test(p.runId??''))return p.runId;if(UUID.test(p.requestId??'')&&this.has('activity_requests'))return this.db.prepare('SELECT run_id FROM activity_requests WHERE id=?').get(p.requestId)?.run_id??null;if(UUID.test(row.result?.activityId??''))return row.result.activityId;const active=this.a.activities?.active;return active?.attentionId===row.id?active.id??null:null;}
 video(runId){
 if(!UUID.test(runId??'')||!this.has('activity_runs'))return null;const r=this.db.prepare('SELECT id,status,decision_json,observation_id FROM activity_runs WHERE id=?').get(runId);if(!r)return null;
 const active=this.a.activities?.active,live=active?.id===runId,c=this.has('attention_checkpoints')?json(this.db.prepare('SELECT value_json FROM attention_checkpoints WHERE task_id=?').get('activity:'+runId)?.value_json):null,d=json(r.decision_json),v=this.has('activity_video_sessions')?json(this.db.prepare('SELECT state_json FROM activity_video_sessions WHERE run_id=?').get(runId)?.state_json):null;
 const o=r.observation_id&&this.has('activity_observations')?json(this.db.prepare('SELECT payload_json FROM activity_observations WHERE id=?').get(r.observation_id)?.payload_json):null,target=(live?active.target:null)??c?.target??d?.selectedTarget;
 const rows=this.has('activity_video_segments')?this.db.prepare('SELECT start_seconds,end_seconds FROM activity_video_segments WHERE run_id=? ORDER BY start_seconds LIMIT 16').all(runId):[],ranges=[];for(const s of rows){if(!Number.isFinite(s.start_seconds)||!Number.isFinite(s.end_seconds)||s.start_seconds<0||s.end_seconds<=s.start_seconds)continue;const last=ranges.at(-1);if(last&&s.start_seconds<=last[1])last[1]=Math.max(last[1],s.end_seconds);else ranges.push([s.start_seconds,s.end_seconds]);}
 return {id:runId,status:r.status,live,paused:live?Boolean(active.paused):r.status==='paused',phase:clean((live?active.phase:null)??c?.phase,100),phaseLabel:phaseLabel[(live?active.phase:null)??c?.phase]??'最近记录的检查点',phaseAt:moment(c?.updatedAt),bvid:/^BV[0-9A-Za-z]{10}$/.test(target?.bvid??'')?target.bvid:null,title:clean(v?.info?.title??o?.title,300),durationSeconds:Number.isFinite(v?.info?.durationSeconds)?v.info.durationSeconds:Number.isFinite(o?.video?.durationSeconds)?o.video.durationSeconds:null,ranges,coveredSeconds:ranges.reduce((n,[a,b])=>n+b-a,0),observerComplete:v?.complete===true,notice:'仅表示本轮已保存的抽样区间与最近检查点；不是播放器进度，也不证明看完整片'};
 }
 models(){
  let progress=null;try{progress=this.a.diagnostics?.progress?.();}catch{}
  const active=(progress?.active??[]).slice(0,8).map(r=>({stage:clean(r.stage,40),label:callLabel[r.stage]??'模型调用',elapsedMs:Number.isFinite(r.elapsedMs)?r.elapsedMs:null,idleMs:Number.isFinite(r.idleMs)?r.idleMs:null})),map=r=>({...r,stage:callLabel[r.stage]??'模型调用',at:moment(r.startedAt),kind:clean(r.kind,80)}),recent=this.has('diagnostic_model_calls')?readDiagnosticCalls(this.db).map(map):[],errors=this.has('diagnostic_model_calls')?readDiagnosticCalls(this.db,{anomalies:true}).map(map):[];
  return {available:progress?.available===true,active,recentCalls:recent,recentErrors:errors,tools:readToolDiagnostics(this.db,{since:this.now()-24*3600000,limit:12}),notice:'模型交接、工具结果和对外送达分别核对；没有调用不等于没有想法，旧错误也不代表当前仍故障。旧tool-calls只校正分类，原记录保留，工具结果未知时不推定成功'};
 }

 sourceSQL(alias='i'){
  const p="(CASE WHEN json_valid("+alias+".payload_json) THEN "+alias+".payload_json ELSE '{}' END)",j=key=>"json_extract("+p+",'$."+key+"')";
  const channels=(this.consoleSources?.()??[{id:'qq'},{id:'web'},{id:'bilibili'}]).map(s=>s.id).filter(id=>/^[a-z][a-z0-9_-]{0,59}$/.test(id));
  return "CASE WHEN "+j('channel')+" IN ("+channels.map(id=>"'"+id+"'").join(',')+") THEN "+j('channel')+" WHEN "+j('platformEventId')+" IS NOT NULL OR "+j('socialExperienceId')+" IS NOT NULL THEN 'qq' WHEN "+j('platformActionId')+" IS NOT NULL THEN "+(this.has('platform_operations')?"coalesce((SELECT CASE WHEN substr(action,1,3)='qq_' THEN 'qq' WHEN substr(action,1,5)='bili_' THEN 'bilibili' ELSE 'unknown' END FROM platform_operations WHERE id="+j('platformActionId')+"),'unknown')":"'unknown'")+" WHEN "+alias+".kind IN ('browse','bilibili') THEN 'bilibili' WHEN "+j('profileNoticeId')+" IS NOT NULL THEN 'unknown' WHEN "+alias+".kind='proactive' THEN 'qq' WHEN "+alias+".kind IN ('reflect','recall','nightly','goal') THEN 'internal' ELSE 'unknown' END";
 }
 consoleTask(row){const out=this.brief(row),source=this.db.prepare('SELECT '+this.sourceSQL()+' source FROM attention_intents i WHERE i.id=?').get(row.id)?.source??'unknown',run=this.runFor(row);return {...out,source,link:source==='bilibili'?{panel:'bilibili',kind:run?'task':'overview',id:run}:null};}
 consoleSnapshot({section='overview',source='all',kind='all',status='all',limit=24,offset=0,refKind,refId}={}){
  const available=this.has('attention_intents')&&this.has('attention_decisions');
  if(!available)return {schema:'ai-friend/activity-console/1',available:false,generatedAt:new Date(this.now()).toISOString(),notice:'当前尚无统一调度记录'};
  const catalog={sources:this.consoleSources?.()??[{id:'qq',label:'QQ'},{id:'bilibili',label:'B站'},{id:'web',label:'Web聊天'},{id:'internal',label:'内部活动'},{id:'unknown',label:'来源未分类'}],kinds:this.db.prepare('SELECT DISTINCT kind FROM attention_intents ORDER BY kind').all().filter(r=>/^[a-z][a-z0-9_-]{0,59}$/.test(r.kind)).map(r=>({id:r.kind,label:kindLabel[r.kind]??r.kind})),statuses:this.db.prepare('SELECT DISTINCT status FROM attention_intents ORDER BY status').all().map(r=>r.status)};
  const output={schema:'ai-friend/activity-console/1',available:true,section,generatedAt:new Date(this.now()).toISOString(),catalog,notice:'同一份全局活动记录；页面只读，不唤醒、不调用模型或平台。选择、执行与送达分别核对。'};
  if(section==='overview'||section==='resources'){output.overview=this.snapshot();for(const list of ['current','queue'])output.overview[list]=output.overview[list].map(t=>this.consoleTask(this.row(t.id)));return output;}
  const clauses=[],args=[],a=section==='choices'?'d':'i',src=this.sourceSQL();
  if(source!=='all'){clauses.push((section==='choices'?"CASE WHEN i.id IS NULL THEN 'global' ELSE "+src+' END':src)+'=?');args.push(source);}
  if(kind!=='all'){clauses.push('i.kind=?');args.push(kind);}
  if(status!=='all'){clauses.push(a+'.status=?');args.push(status);}
  if(refKind){
   const p="(CASE WHEN json_valid(i.payload_json) THEN i.payload_json ELSE '{}' END)",parts=[],values=[];
   const add=(sql,value)=>{parts.push(sql);values.push(value);};
   if(refKind==='event'){add("json_extract("+p+",'$.eventId')=?",refId);add("json_extract("+p+",'$.platformEventId')=?",refId);}
   if(refKind==='run'){
    add("json_extract("+p+",'$.runId')=?",refId);add("json_extract(CASE WHEN json_valid(i.result_json) THEN i.result_json ELSE '{}' END,'$.activityId')=?",refId);
    if(this.has('activity_requests'))add("json_extract("+p+",'$.requestId') IN (SELECT id FROM activity_requests WHERE run_id=?)",refId);
    if(this.has('activity_video_readings'))add("json_extract("+p+",'$.readingId') IN (SELECT id FROM activity_video_readings WHERE root_run=?)",refId);
   }
   if(refKind==='reading'){
    add("json_extract(CASE WHEN json_valid(i.result_json) THEN i.result_json ELSE '{}' END,'$.readingId')=?",refId);
    const reading=this.a.activities?.readings?.get(refId);if(UUID.test(reading?.intentId??''))add('i.id=?',reading.intentId);if(UUID.test(reading?.backgroundRequestId??''))add("json_extract("+p+",'$.requestId')=?",reading.backgroundRequestId);

    add("json_extract("+p+",'$.readingId')=?",refId);
    if(this.has('activity_runs')){add("json_extract("+p+",'$.runId') IN (SELECT id FROM activity_runs WHERE json_valid(request_json) AND json_extract(request_json,'$.continuousReadingId')=?)",refId);}
    if(this.has('activity_video_readings'))add("json_extract("+p+",'$.runId') IN (SELECT root_run FROM activity_video_readings WHERE id=?)",refId);
   }
   clauses.push('('+parts.join(' OR ')+')');args.push(...values);
  }
  const table=section==='choices'?"attention_decisions d LEFT JOIN attention_intents i ON i.id=json_extract(CASE WHEN json_valid(d.decision_json) THEN d.decision_json ELSE '{}' END,'$.targetId')":"attention_intents i",where=clauses.length?' WHERE '+clauses.join(' AND '):'',total=this.db.prepare('SELECT count(*) n FROM '+table+where).get(...args).n;
  const rows=this.db.prepare('SELECT '+a+'.* FROM '+table+where+' ORDER BY '+a+'.rowid DESC LIMIT ? OFFSET ?').all(...args,limit,offset);
  output.items=rows.map(r=>section==='choices'?this.decision(r):this.consoleTask(this.row(r.id)));output.paging={offset,limit,total,hasMore:offset+rows.length<total};output.filters={source,kind,status,refKind:refKind??null,refId:refId??null};
  return output;
 }
 consoleDetail(kind,id){const result=this.detail(kind,id);if(!result)return null;if(kind==='intent')result.task=this.consoleTask(this.row(id));return result;}

 snapshot(){
 if(!this.has('attention_intents')||!this.has('attention_decisions'))return {available:false,notice:'当前实例尚无可读取的统一调度记录'};
 let status=null;try{status=this.a.attention?.status?.();}catch{}
 const enabled=Boolean(this.a.attention?.config?.enabled&&!this.a.attention?.closed),ready=Boolean(this.a.attention?.host),deciding=Boolean(this.a.attention?.choosing);
 const counts=Object.fromEntries(this.db.prepare('SELECT status,count(*) n FROM attention_intents GROUP BY status').all().map(r=>[r.status,r.n]));
 const rows=statuses=>this.db.prepare(`SELECT id FROM attention_intents WHERE status IN (${statuses.map(()=>'?').join(',')}) ORDER BY updated_at DESC,rowid DESC LIMIT ?`).all(...statuses,statuses.includes('pending')?32:12).map(r=>this.row(r.id)).filter(Boolean).map(r=>this.brief(r));
 const decisions=this.db.prepare('SELECT * FROM attention_decisions ORDER BY rowid DESC LIMIT 20').all().map(r=>this.decision(r));
 const active=this.a.activities?.active,current=deciding?{label:'正在作出选择',reason:null}:!enabled?{label:'统一调度未启用',reason:null}:!ready?{label:'调度执行端尚未就绪',reason:null}:status?.decisionState?.current?{label:clean(status.decisionState.current.label,100),reason:clean(status.decisionState.current.reason,700),retryAt:status.decisionState.current.retryAt??null}:{label:'当前执行状态未知',reason:'缺少可确认的运行状态记录'};
 return {available:true,generatedAt:new Date(this.now()).toISOString(),scheduler:{enabled,ready,deciding,current,lastError:clean(this.a.attention?.lastError,500)},counts,current:rows(['selected','admitting','waking','running','paused']),queue:rows(['pending','waiting']),decisions,video:active?.id?this.video(active.id):null,connections:this.connections(),resources:this.resources(),models:this.models(),replies:replyStatusView(this.a),coverage:'最多12条执行事项、32条待办和最近20条选择；详情中的历史转换与关联选择也有窗口上限。',notice:'页面只展示已保存的简短理由与运行事实，不改变优先级、唤醒任务或试发消息；没有记录时保持未知。'};
 }
 detail(kind,id){if(!UUID.test(id??''))return null;if(kind==='decision'){const r=this.has('attention_decisions')?this.db.prepare('SELECT * FROM attention_decisions WHERE id=?').get(id):null;return r?{kind,title:'行为选择的实际记录',decision:this.decision(r)}:null;}
 if(kind!=='intent')return null;const row=this.row(id);if(!row)return null;
 const history=this.has('diagnostic_intent_events')?this.db.prepare('SELECT from_state,to_state,wake_kind,wake_at,reason,at FROM diagnostic_intent_events WHERE intent_id=? ORDER BY at DESC,id DESC LIMIT 20').all(id).reverse().map(r=>({from:r.from_state,to:r.to_state,wakeKind:clean(r.wake_kind,40),wakeAt:moment(r.wake_at),reason:clean(r.reason,700),at:moment(r.at)})):[];
 const choices=this.db.prepare('SELECT * FROM attention_decisions ORDER BY rowid DESC LIMIT 100').all().filter(r=>{const d=json(r.decision_json);return d?.targetId===id||updates(d).some(u=>u.id===id);}).slice(0,8).map(r=>this.decision(r));
 const result=row.result,operationId=row.payload?.platformActionId??result?.operationId,op=UUID.test(operationId??'')?this.a.platforms?.store.operation(operationId):null;
 const receipt=op?{status:clean(op.status,50),apiAccepted:op.receipt?.apiAccepted===true,observed:op.verification?.observed===true,verified:op.verification?.verified===true,notice:'平台受理、原件观察、提交核验及对方已读是不同证据；本页不会重新发送或探测'}:null;
 return {kind,title:'活动与待办的记录',task:this.brief(row),video:this.video(this.runFor(row)),choices,history,result:result?{status:clean(result.status,80),summary:clean(result.summary??result.reason,1000)}:null,receipt,coverage:'最多20条已保存状态转换；关联选择扫描最近100条并展示最多8条。诊断清理或缺少旧记录时不能还原完整历史。'};
 }
}
