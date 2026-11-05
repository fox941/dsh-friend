import {hash,text,noSecret} from './validation.js';

const kinds=new Set(['browse','recall','reflect']);
const open=new Set(['pending','waiting','paused','selected','running','admitting','waking']);
const editable=new Set(['pending','waiting']);
const clone=value=>structuredClone(value);
export const ideaRevision=row=>hash(JSON.stringify([row.id,row.status,row.summary,row.payload,row.wake,row.result,row.error,row.updated_at]));
const eligible=row=>row?.event_key?.startsWith('idea:')&&row.scope==='internal'&&kinds.has(row.kind)&&open.has(row.status)&&row.payload&&typeof row.payload==='object'&&!['goalId','goalStepId','platformActionId','platformEventId','biliActionId','biliEventId','profileNoticeId','sessionId','message'].some(k=>row.payload[k]!==undefined);
const hasProgress=row=>Boolean(row.payload.runId||row.payload.activityId||row.payload.checkpoint||row.result?.activityId||row.result?.observationId);

/** Operational planning only. No new model, memory/growth write or execution loop. */
export class IntentReuse {
 constructor(attention){
  this.attention=attention;this.store=attention.store;this.db=this.store.db;this.journal=attention.journal;
  this.db.exec(`CREATE TABLE IF NOT EXISTS planning_idea_changes(operation_key TEXT PRIMARY KEY,decision_id TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,source_json TEXT,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS planning_idea_target ON planning_idea_changes(target_id,created_at);`);
 }
 hasProgress(row){return hasProgress(row)||this.store.readCheckpoint(row.id)!==null;}
 context(){
  const rows=this.db.prepare("SELECT * FROM attention_intents WHERE event_key LIKE 'idea:%' AND scope='internal' AND kind IN ('browse','recall','reflect') AND status IN ('pending','waiting','paused','selected','running','admitting','waking') ORDER BY updated_at DESC,rowid DESC LIMIT 33").all().map(r=>this.store.decode(r)).filter(eligible);
  return {items:rows.slice(0,32).map(row=>({id:row.id,revision:ideaRevision(row),kind:row.kind,status:row.status,topic:row.payload.topic??row.summary,reason:row.payload.reason??null,wake:row.wake,canSupplement:editable.has(row.status)&&!this.hasProgress(row),canMerge:editable.has(row.status)&&!this.hasProgress(row)})),truncated:rows.length>32,boundary:'仅自由探索待办；版本标记不是记忆版本。同视频不等于同问题。保留正在执行的任务、检查点和原等待条件；合并不代表完成或观察。'};
 }
 read(limit=12){return {context:this.context(),changes:this.db.prepare('SELECT action,target_id,decision_id,source_json,receipt_json,created_at FROM planning_idea_changes ORDER BY rowid DESC LIMIT ?').all(Math.max(1,Math.min(30,limit))).map(r=>({...r,source:r.source_json?JSON.parse(r.source_json):null,receipt:JSON.parse(r.receipt_json),source_json:undefined,receipt_json:undefined}))};}
 apply({frame,decision,call}){
  const results=[];
  for(const [index,proposal]of decision.suggestions.entries())results.push(this.capture(proposal,frame.relatedIdeas,call,index));
  return results;
 }
 capture(proposal,snapshot,call,index=0){
  if(!snapshot||!Array.isArray(snapshot.items)||typeof call!=='string')throw Error('自由待办缺少本轮实际呈现的索引');
  const operation=hash(JSON.stringify([call,index])),previous=this.db.prepare('SELECT receipt_json FROM planning_idea_changes WHERE operation_key=?').get(operation);
  if(previous)return {...JSON.parse(previous.receipt_json),replayed:true};
  if(!proposal||Object.keys(proposal).some(k=>!['kind','topic','reason','resolution','targetId','expectedRevision','mergeFrom'].includes(k))||!kinds.has(proposal.kind))throw Error('自由待办提案字段无效');
  const topic=text(proposal.topic,'探索主题',proposal.kind==='browse'?80:160),reason=text(proposal.reason,'探索复用理由',700),action=proposal.resolution??(snapshot.items.length===0?'new':null);
  if(!['new','reuse','supplement'].includes(action))throw Error('已有自由待办，请明确比较后选择new/reuse/supplement');
  if(action==='new'&&(proposal.targetId||proposal.expectedRevision||proposal.mergeFrom))throw Error('新建待办不能夹带旧任务修改');
  if(action!=='new'&&(!proposal.targetId||!proposal.expectedRevision))throw Error('复用待办需要本轮目标ID和版本');
  noSecret(JSON.stringify({proposal,call}));let material=false;
  // Creation uses the scheduler's original durable key/offer. If interrupted
  // before the audit insert, retry finds that same item and cannot enqueue twice.
  let created=null,newWasPresent=false;
  if(action==='new'){const key='idea:'+hash(JSON.stringify([proposal.kind,topic]));newWasPresent=Boolean(this.store.byKey(key));created=this.attention.offer({key,kind:proposal.kind,scope:'internal',summary:topic,payload:{topic,reason,planningOrigin:{decisionId:call,independentEvidence:false}}});}
  const receipt=this.journal.transaction(()=>{
   let before=null,after,source=null,result;
   const current=(id,revision)=>{
    const shown=snapshot.items.find(r=>r.id===id);if(!shown||shown.revision!==revision||shown.kind!==proposal.kind)throw Error('待办引用不属于本轮呈现的同类事项');
    const row=this.store.get(id);if(!eligible(row)||ideaRevision(row)!==revision)throw Error('待办版本或状态已变化，未覆盖');return row;
   };
   if(action==='new'){
    after=created;result={status:newWasPresent?(open.has(after.status)?'existing':'closed_preserved'):'created',itemId:after.id};
   }else{
    before=current(proposal.targetId,proposal.expectedRevision);after=clone(before);
    if(action==='supplement'){
     if(!editable.has(before.status)||this.hasProgress(before))throw Error('执行中或已有检查点的任务不能改写主题；可复用或为新问题另建事项');
     const prior=before.payload.planningTopics??[];
     if(prior.length>=8&&!prior.includes(before.payload.topic))throw Error('待办主题修订已达保留上限，请明确结束或另建不同任务');
     const payload={...before.payload,topic,reason,planningTopics:[...new Set([...prior,before.payload.topic??before.summary])],planningOrigin:before.payload.planningOrigin??null};
     // Keep status, wake, result and all progress fields; only the queued topic changes.
     this.store.updatePayload(before.id,payload);this.db.prepare('UPDATE attention_intents SET summary=? WHERE id=?').run(topic,before.id);after=this.store.get(before.id);material=true;
    }
    if(proposal.mergeFrom){
     const from=proposal.mergeFrom;if(!from||Object.keys(from).some(k=>!['id','revision'].includes(k))||from.id===before.id)throw Error('合并来源需要不同的本轮事项ID和版本');
     source=current(from.id,from.revision);
     if(!editable.has(before.status)||!editable.has(source.status)||this.hasProgress(before)||this.hasProgress(source))throw Error('已有执行进度的事项不能合并取消');
     this.store.patch(source.id,'cancelled',{result:{...source.result,planningMergedInto:before.id,reason:'模型判断为重复待办并合并，原件和旧等待条件保留于规划历史：'+reason}});material=true;
    }
    result={status:action==='reuse'?'reused':'supplemented',itemId:before.id,...source?{mergedFrom:source.id}:{}};
   }
   this.db.prepare('INSERT INTO planning_idea_changes VALUES(?,?,?,?,?,?,?,?,?)').run(operation,call,action,after.id,before?JSON.stringify(before):null,JSON.stringify(after),source?JSON.stringify(source):null,JSON.stringify({...result,proposal,independentEvidence:false}),this.store.time());
   if(material)this.db.prepare('UPDATE attention_meta SET epoch=epoch+1 WHERE id=1').run();
   return result;
  });
  // Do not wake up a voluntarily deferred task merely because it was mentioned again.
  // The scheduler stamps its post-effect epoch; real future events still invalidate it.
  return receipt;
 }
}

export const ideaReusePolicy=`
relatedIdeas列出已存在的自由探索待办（包含等待中的事项，不包含消息、发送操作、夜间任务或目标步骤）。提出suggestions前逐项比较已有目标，先决定是同一个问题还是不同疑问。同一视频/BV不必然同问题；关注对象、问题、片段或内容版本不同，可以new。每项suggestion保留kind/topic/reason，并填写resolution为new、reuse或supplement。reuse复用同一问题的事项；supplement把一个尚未执行的旧主题重述为涵盖原问题和补充内容的主题，不能偷偷丢掉原问题。后两者须用relatedIdeas实际targetId和expectedRevision。browse的topic最多80字，recall/reflect最多160字。正在执行或有检查点时只可reuse，不重写其主题。
已有两个真正重复的未执行事项时，可在reuse/supplement附mergeFrom:{id,revision}指向另一条本轮可合并事项；这将保留目标的状态和等待条件，把重复项标记合并并保留旧原件，不代表完成。不能合并不同问题、不同内容版本或互相矛盾的目标。无需为了整理每轮强行提案，通常suggestions仍为空；reuse不自动唤醒、不重复执行或发送，也不增加兴趣/人格支持。没有拿到目标的实际版本就不改。索引truncated时不假定已看全所有历史。`;
