import {UUID} from './validation.js';
import {viewText as clean} from './view-text.js';
import {BehaviorView} from './behavior-view.js';
import {projectEmotion,levelText} from './emotion-state.js';

const json=(s,fallback=null)=>{try{return s?(JSON.parse(s)??fallback):fallback;}catch{return fallback;}};
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,180}$/.test(value);
const kindLabels={self_description:'自我描述',interest:'兴趣',trait:'性格认识',personal_prompt:'个人表达',emotion:'旧版情绪'};
export class SelfStateView {
 constructor(adapter){this.a=adapter;this.g=adapter.growth;this.db=adapter.journal.db;this.behavior=new BehaviorView(adapter);}
 has(table){return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));}
 sourceMeta(event){const o=event?.origin??{},channel=o.channel??o.platform??'local';return {id:event?.id??null,channel:clean(channel,50),label:({'qq_social':'QQ交流','qq_social_media':'QQ图片或语音','bilibili':'B站观看','bilibili_social':'B站交流','attention_perception':'消息预览','qq':'QQ主会话','web':'本地会话'})[channel]??'本地交流',privacy:clean(o.privacy??(o.space?'space':'private'),30),at:event?.occurredAt??null,previewOnly:o.previewOnly===true,notice:'保存的来源记录；本页不会重新读取平台原件'};}
 source(sourceId){const e=this.g.store.event(sourceId);if(!e)return {id:sourceId,missing:true,notice:'此来源原文未收录在成长事件表，不能据此断言从未发生'};return {...this.sourceMeta(e),content:clean(e.content,12000),truncated:e.content.length>12000,context:(e.context??[]).slice(0,6).map(c=>({role:clean(c.role,20),content:clean(c.content,1200),kind:clean(c.source?.kind??(typeof c.source==='string'?c.source:''),180)})),linkedEvents:(e.origin?.experienceContext?.linkedEvents??[]).slice(0,3),meaning:'原话、自述、模型观察及自己的感受按来源区分；记录存在不证明现实主张为真'};}
 state(row){return {id:row.id,key:clean(row.key,100),kind:row.kind,label:kindLabels[row.kind]??'自我认识',statement:clean(row.statement,1200),status:row.effectiveStatus??row.status,recordedStatus:row.status,reason:clean(row.reason),supportCount:row.supports?.length??0,supports:(row.supports??[]).slice(0,12),dependencies:(row.dependsOn??[]).slice(0,6),at:row.at,expiresAt:row.expiresAt??null,batchId:row.batchId??null};}
 emotion(row){return {id:row.episodeId,versionId:row.versionId,label:clean(row.label,60),topic:clean(row.topic,160),statement:clean(row.statement,800),reason:clean(row.reason),appraisal:clean(row.appraisal),status:row.effectiveStatus??row.status,recordedStatus:row.status,current:row.currentIntensity??0,background:row.backgroundIntensity??0,degree:levelText(row.currentIntensity??0),confidence:row.confidence,supportCount:row.supportingEvents??0,at:row.createdAt??row.changedAt,anchorAt:row.anchorAt,sourceId:row.sourceId,batchId:row.batchId??null};}
 reviews(){
 const growth=this.db.prepare('SELECT id,status,source_id,created_at,updated_at,last_error FROM growth_batches ORDER BY rowid DESC LIMIT 20').all().map(r=>({id:r.id,kind:'audit-growth',label:'自我认识审核',status:r.status,sourceId:r.source_id,at:r.updated_at??r.created_at,error:clean(r.last_error,300)}));
 const emotion=this.db.prepare('SELECT id,status,source_id,created_at,updated_at,error FROM emotion_batches ORDER BY rowid DESC LIMIT 20').all().map(r=>({id:r.id,kind:'audit-emotion',label:'感受审核',status:r.status,sourceId:r.source_id,at:r.updated_at??r.created_at,error:clean(r.error,300)}));
 return [...growth,...emotion].sort((a,b)=>b.at.localeCompare(a.at));
 }
 experiences(){
 const out=[];
 if(this.has('social_experience_jobs'))for(const r of this.db.prepare('SELECT id,event_id,source_id,status,value_json,updated_at FROM social_experience_jobs ORDER BY rowid DESC LIMIT 15').all()){
  const v=json(r.value_json),event=this.a.platforms?.store.event(r.event_id);
  out.push({id:r.id,kind:'social',label:event?.kind==='qzone_comment'?'QQ空间经历':event?.kind==='group'?'QQ群经历':'QQ好友经历',status:r.status,at:r.updated_at,summary:clean(v?.reason??v?.proposal?.reason??'尚无已记录的评价结果',500),preview:clean(event?.body,240),sourceId:r.source_id,changes:(v?.receipts??[]).filter(x=>x.receipt?.status==='applied').length});
 }
 if(this.has('activity_runs'))for(const r of this.db.prepare('SELECT id,status,result_json,observation_id,updated_at FROM activity_runs ORDER BY rowid DESC LIMIT 15').all()){
  const v=json(r.result_json);out.push({id:r.id,kind:'activity',label:'B站活动',status:r.status,at:r.updated_at,summary:clean(v?.summary??'尚无已记录的活动总结',500),preview:'',observationId:r.observation_id,changes:[v?.growth,v?.emotion].filter(x=>x?.status==='applied').length});
 }
 return out.sort((a,b)=>b.at.localeCompare(a.at));
 }
 snapshot(){
 const s=this.g.read(),affect=this.g.emotions.read(),states=s.states.filter(r=>r.kind!=='emotion');
 return {schema:'ai-friend/self-state-view/1',generatedAt:affect.asOf,identity:s.identityId,revision:s.revision,emotionRevision:affect.revision,enabled:s.enabled,
  self:{blank:states.every(r=>!['tentative','established','current'].includes(r.effectiveStatus)),states:states.slice(0,80).map(r=>this.state(r)),omitted:Math.max(0,states.length-80)},
  emotions:{summary:clean(affect.summary,3000),moodSummary:clean(affect.moodSummary,2000),current:affect.current.map(x=>({id:x.episodeId,label:clean(x.label,60),value:x.value,degree:levelText(x.value),reason:clean(x.reason,400)})),background:affect.background.map(x=>({id:x.episodeId,label:clean(x.label,60),value:x.value,degree:levelText(x.value),reason:clean(x.reason,400)})),episodes:affect.episodes.map(r=>this.emotion(r)),omitted:affect.omittedEpisodes,method:clean(affect.method,1500)},
  reviews:this.reviews(),experiences:this.experiences(),behavior:{available:false,movedTo:'activity-console',notice:'完整活动与选择已移到独立活动中心'},coverage:'当前自我最多80项、感受最多128项；最近20条自我审核、20条感受审核，最近各15条QQ经历和B站活动；均为有限窗口。',meaning:'同一份角色状态的只读视图。查看、筛选和刷新不会调用模型、写入记忆或改变状态。工程强度和审核把握并非心理测量。'};
 }
 detail(kind,key){
 if(kind==='intent'||kind==='decision')return this.behavior.detail(kind,key);
 if(kind==='state'){
  if(typeof key!=='string'||key.length>100||!this.g.store.head(key))return null;
  const rows=this.g.history(key,20).versions;return {kind,title:'自我认识历史',items:rows.map(r=>this.state(r)),coverage:'最近20个版本，旧版本不代表当前仍有效'};
 }
 if(kind==='emotion'){
  if(!UUID.test(key??''))return null;const head=this.g.emotions.store.head(key);if(!head)return null;
  const available=this.g.emotions.ready(head)&&head.confidence!=='low',now=this.g.store.now().valueOf();
  return {kind,title:'感受的依据与变化',items:this.g.emotions.history(key,20).map(r=>({id:r.versionId,status:r.status,statement:clean(r.statement),reason:clean(r.reason),at:r.createdAt,sourceId:r.sourceId,batchId:r.batchId,source:this.source(r.sourceId)})),projection:available?[0,15,30,60,120,240].map(minutes=>{const p=projectEmotion(head,now+minutes*60000);return {minutes,current:p.current,background:p.background};}):[],projectionMeaning:'假定没有新事件或状态变化时的工程时间投影，不预测她未来实际的情绪',coverage:'最近20版；当前使用状态以总览为准'};
 }
 if(kind==='source')return id(key)?{kind,title:'保存的经历来源',source:this.source(key)}:null;
 if(kind==='audit-growth'||kind==='audit-emotion')return id(key)?this.audit(kind,key):null;
 if(kind==='social')return UUID.test(key??'')?this.social(key):null;
 if(kind==='activity')return UUID.test(key??'')?this.activity(key):null;
 return null;
 }
 audit(kind,key){
 const emotional=kind==='audit-emotion',r=this.db.prepare(emotional?'SELECT * FROM emotion_batches WHERE id=?':'SELECT * FROM growth_batches WHERE id=?').get(key);if(!r)return null;
 const attempts=this.db.prepare(emotional?'SELECT status,request_json,review_json,error,created_at,finished_at FROM emotion_review_attempts WHERE batch_id=? ORDER BY id DESC LIMIT 2':'SELECT status,request_json,result_json,at FROM growth_review_attempts WHERE batch_id=? ORDER BY attempt DESC LIMIT 2').all(key);
 const request=json(attempts[0]?.request_json,{}),review=json(emotional?r.review_json:r.review),receipt=json(emotional?r.receipt_json:r.receipt),proposals=emotional?request.proposals??json(r.request_json,{})?.proposals??[]:json(r.proposals,[]);
 const decisions=review?.decision?.decisions??review?.decisions??[],before=emotional?request.currentEmotion?.episodes??[]:request.currentStates??[];
 return {kind,title:emotional?'感受审核记录':'自我认识审核记录',status:r.status,at:r.updated_at,source:this.source(r.source_id),error:clean(r.error??r.last_error,600),items:proposals.slice(0,4).map((p,index)=>{const decision=decisions.find(d=>d.index===index),result=receipt?.changes?.find(c=>emotional?c.index===index:c.key===p.key),old=before.find(v=>emotional?v.episodeId===p.episodeId:v.key===p.key);return {id:String(index),label:clean(p.label??p.key??p.kind,100),action:p.action??'set',old:old?clean(old.statement):'审核材料中没有对应旧值',proposed:clean(p.statement??(p.action==='retract'?'撤回当前认识':'')??'',1200),verdict:result?.verdict??decision?.verdict??'pending',reason:clean(result?.reason??decision?.reason??'',1200),evidenceQuote:clean(p.quote??p.evidenceQuote,1500),versionId:result?.versionId??null};}),receipt:receipt?{status:receipt.status,revision:receipt.revision,summary:clean(receipt.summary,1000)}:null,coverage:'只展示该批次的提案、实际审核结论和提交结果，不将审核接受等同于已经写入'};
 }
 social(key){
 if(!this.has('social_experience_jobs'))return null;const r=this.db.prepare('SELECT * FROM social_experience_jobs WHERE id=?').get(key);if(!r)return null;
 const v=this.a.socialExperience?.read(key)??json(r.value_json),e=this.a.platforms?.store.event(r.event_id);if(!v)return null;
 return {kind:'social',title:'QQ经历的处理记录',status:r.status,at:r.updated_at,summary:clean(v.reason??v.proposal?.reason),source:this.source(r.source_id),original:e?{content:clean(e.body,4000),at:e.created_at,notice:'保存的收件原文；不是平台当前页面的重新核验'}:null,association:v.episodeLink?{accepted:v.episodeLink.accepted,reason:clean(v.episodeLink.reason),relatedCount:v.episodeLink.members?.length??0,corrections:(v.episodeLink.corrections??[]).slice(0,3).map(c=>({old:clean(c.oldQuote,500),new:clean(c.newQuote,500),reason:clean(c.reason,700)}))}:null,reviews:(v.receipts??[]).filter(x=>x.batchId).map(x=>({id:x.batchId,kind:x.kind==='emotion'?'audit-emotion':'audit-growth',status:x.receipt?.status??'unknown'})),error:clean(v.error,500),coverage:'交流、关联、提案、独立审核及实际变化分别记录；completed不保证有状态变化'};
 }
 activity(key){
 if(!this.has('activity_runs'))return null;const r=this.db.prepare('SELECT * FROM activity_runs WHERE id=?').get(key);if(!r)return null;
 const result=json(r.result_json,{}),o=r.observation_id&&this.a.activities?.store.observation(r.observation_id),payload=o?.payload;
 return {kind:'activity',title:'观看活动的实际记录',status:r.status,at:r.updated_at,summary:clean(result.summary,2000),observation:payload?{title:clean(payload.title,300),content:clean(payload.text,5000),scope:clean(payload.scope,2000),notice:'仅代表原观察实际覆盖的部分，不能据此声称看完整条视频'}:null,results:['memory','growth','emotion'].map(k=>({label:k,status:result[k]?.status??'未记录',verified:k==='memory'?result[k]?.verified===true:null})),error:clean(r.error,600),coverage:'本页只读保存的活动记录，不下载视频、不重新识别画面或补做反思'};
 }
}
