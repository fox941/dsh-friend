import {randomUUID} from 'node:crypto';
import {ProfileCatalogue} from './profile-catalogue.js';
import {runtimeVersion} from './apply-runtime.js';
import {hash,noSecret,text} from './validation.js';

const parse=s=>s?JSON.parse(s):null;
const copy=x=>JSON.parse(JSON.stringify(x));
const freeze=x=>{if(x&&typeof x==='object'){Object.freeze(x);for(const v of Object.values(x))freeze(v);}return x;};
export const summaryContent=item=>'关于主用户：'+item.content;
const eligible=item=>item.status==='active'&&item.rule.scope==='person'&&!item.alreadyCore&&['address','habit','interest','preference'].includes(item.rule.kind);
export function summaryPlan(decision,frame){
 if(!decision||Object.keys(decision).some(k=>!['keep','reason'].includes(k))||typeof decision.keep!=='boolean')throw Error('画像选择只接受 keep 和 reason');
 const reason=text(decision.reason,'画像选择依据',700),request=frame.proposals[0].request;
 if(request.action==='remove'&&!decision.keep)throw Error('确认撤回的摘要不能继续保留为有效事实');
 const removing=request.action==='remove'||request.action==='replace'&&!decision.keep;
 const operation={proposalIndex:0,kind:removing?'runtime_remove':request.action==='add'?'runtime_add':'runtime_replace',...request.reference?{reference:request.reference}:{target:'user'},...request.content&&!removing?{content:request.content}:{},importance:'normal',evidence:frame.proposals[0].evidence,becauseRefs:[],reason};
 const apply=decision.keep||removing;
 if(request.action==='replace'&&decision.keep&&request.reference.text===request.content)return {decisions:[{proposalIndex:0,verdict:'noop',timing:'current',reason,operations:[]}]};
 return {decisions:[{proposalIndex:0,verdict:apply?'apply':'noop',timing:'current',reason,operations:apply?[operation]:[]}]};
}

/** A managed projection; canonical facts, public Runtime CAS, and protected applications remain authoritative. */
export class ProfileSummary{
 constructor(adapter,{authority,catalogue=new ProfileCatalogue(adapter),now=()=>new Date()}={}){
  Object.assign(this,{a:adapter,authority,catalogue,now});this.db=adapter.journal.db;this.stop=new AbortController();this.active=null;this.closed=false;this.host=null;this.lastError=null;
  this.db.exec(`CREATE TABLE IF NOT EXISTS profile_summary_state(family TEXT PRIMARY KEY,source_id TEXT NOT NULL,fingerprint TEXT NOT NULL,source_json TEXT NOT NULL,status TEXT NOT NULL,content TEXT,runtime_version TEXT,application_id TEXT,reason TEXT,updated_at TEXT NOT NULL);`);
  adapter.applications.profileGuard=(frame,signal)=>this.verify(frame,signal);
 }
 time(){return this.now().toISOString();}
 rows(){return this.db.prepare('SELECT * FROM profile_summary_state ORDER BY updated_at DESC,family').all().map(r=>({...r,source:parse(r.source_json)}));}
 put(item,status,{content=null,version=null,applicationId=null,reason=''}={}){
  this.db.prepare('INSERT INTO profile_summary_state VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(family) DO UPDATE SET source_id=excluded.source_id,fingerprint=excluded.fingerprint,source_json=excluded.source_json,status=excluded.status,content=excluded.content,runtime_version=excluded.runtime_version,application_id=excluded.application_id,reason=excluded.reason,updated_at=excluded.updated_at').run(item.family,item.id,item.fingerprint,JSON.stringify(item),status,content,version,applicationId,reason,this.time());
 }
 status(){return {running:Boolean(this.active),lastError:this.lastError,intervalSeconds:60,maxManaged:8,budget:'共享记忆应用审核额度',automatic:true};}
 bind(host){this.host=host;}
 pump(){if(this.active)return this.active;if(this.closed||this.a.profileChanges?.hasApprovedPending()||!this.host||this.host.busy()||!this.a.policy().enabled||!this.a.policy().writeEnabled||this.a.applications.active)return Promise.resolve();
  this.active=this.work(AbortSignal.any([this.stop.signal,AbortSignal.timeout(90000)])).catch(()=>{this.lastError='画像维护暂未完成，原事实与现有摘要保留';}).finally(()=>{this.active=null;});return this.active;
 }
 async catalogueItems(signal){const items=[];for(const id of this.catalogue.ids()){signal?.throwIfAborted();const item=await this.catalogue.resolve(id,signal);if(item.status==='active')items.push(item);}return items;}
 async owned(row,signal){const entries=(await this.a.applications.backend.runtime.snapshot(signal)).entries,matching=entries.filter(e=>e.target==='user'&&e.content===row.content);return matching.length===1&&runtimeVersion(matching[0])===row.runtime_version?matching[0]:null;}
 ref(row){return {id:'runtime:user:'+hash(row.content),kind:'runtime',target:'user',text:row.content,importance:row.importance,createdAt:row.created_at,updatedAt:row.updated_at};}
 async work(signal){
  const app=this.a.applications,rows=this.rows(),candidates=await this.catalogueItems(signal);
  // Finish a durable receipt first. No fresh selection or model replay after an interrupted write.
  for(const row of rows)if(row.status==='pending'){
   const run=row.application_id?app.store.get(row.application_id):app.store.bySelection(row.source.projectionKey);
   if(!run){this.restore(row,'应用尚未形成固定计划，等待来源重新核对');return;}
   if(this.a.protection?.withdrawnReport(run.reportId)){this.put(row.source,'undone',{...this.options(row),reason:'该摘要应用已撤销，同版本不自动重建'});return;}
   if(!run.plan){this.restore(row,'审核中断，未自动再次请求模型');return;}
   await app.runProfile(this.authority,async joined=>{
    if(!app.store.steps(run.id).every(s=>s.status==='applied'))await app.advance(run,joined);
    await this.finalize(row.source,run.id,joined);
   },signal);return;
  }
  for(const row of rows)if(row.status==='managed'){
   const run=app.store.get(row.application_id);if(run&&this.a.protection?.withdrawnReport(run.reportId)){this.put(row.source,'undone',{...this.options(row),reason:'该摘要应用已撤销，同版本不自动重建'});return;}
   const current=await this.owned(row,signal);if(!current){this.put(row.source,'detached',{...this.options(row),reason:'摘要后来已改写或移除，保留后续值并停止接管'});return;}
   const source=await this.catalogue.resolve(row.source_id,signal,{strict:true});
   if(source.status==='unavailable'){this.lastError=source.reason;continue;}
   const next=candidates.filter(i=>i.family===row.family&&eligible(i));
   if(next.length>1){this.lastError='同一来源存在多个有效分支，暂缓摘要更新';continue;}
   const fresh=next[0];
   if(source.status==='active'&&eligible(source)&&source.fingerprint===row.fingerprint)continue;
   if(source.status==='active'&&eligible(source)&&!fresh){this.lastError='来源未进入当前扫描窗口，暂缓摘要更新';continue;}
   if(fresh&&fresh.fingerprint!==row.fingerprint){await this.apply(fresh,'replace',current,signal);return;}
   if(source.status==='retired'||source.status==='active'&&!eligible(source)){await this.apply({...row.source,retirement:source.reason??'已变为局部适用事实'},'remove',current,signal);return;}
  }
  const managed=rows.filter(r=>['managed','pending'].includes(r.status)).length;if(managed>=8)return;
  for(const item of candidates){
   if(!eligible(item))continue;
   const row=rows.find(r=>r.family===item.family);
   // Detached entries may be manual preferences. Never regain ownership silently.
   if(row&&(row.fingerprint===item.fingerprint||['managed','pending','detached','undone','blocked'].includes(row.status)))continue;
   const content=summaryContent(item),existing=(await app.backend.runtime.snapshot(signal)).entries.some(e=>e.target==='user'&&e.content===content);
   if(existing){this.put(item,'existing',{content,reason:'相同常驻条目已存在，未接管其修改或删除权'});return;}
   await this.apply(item,'add',null,signal);return;
  }
  this.lastError=null;
 }
 options(row){return {content:row.content,version:row.runtime_version,applicationId:row.application_id};}
 restore(row,reason){const old=row.source.projectionPrevious;if(old)this.put(old.source,old.status,{...this.options(old),reason});else this.put(row.source,'failed',{...this.options(row),reason});}
 async verify(frame,signal){
  if(frame.authorization?.kind!=='profile_summary'||frame.protocol!=='ai-friend/profile-summary/1')throw Error('画像维护授权不匹配');
  const request=frame.proposals?.[0]?.request,item=frame.profileSource;if(!request||!item)throw Error('画像维护材料不完整');
  const actual=await this.catalogue.resolve(item.id,signal,{strict:true});
  if(actual.status==='unavailable')throw Error('画像原来源暂不可核实，未写入');
  if(request.action==='remove'){
   if(actual.status==='active'&&eligible(actual))throw Error('来源仍有效，拒绝按旧撤回计划删除');
  }else if(!eligible(actual)||actual.fingerprint!==item.fingerprint||summaryContent(actual)!==request.content)throw Error('画像原来源或适用范围已变化，未写入');
  if(request.reference){const row=this.rows().find(r=>r.family===item.family);if(!row||!['pending','managed'].includes(row.status)||!row.runtime_version)throw Error('没有可维护的摘要所有权');const current=await this.owned(row,signal);if(!current||current.content!==request.reference.text)throw Error('常驻摘要后来已变化，保留新值');}
 }
 async apply(item,action,before,signal){
  const app=this.a.applications,content=action==='remove'?null:summaryContent(item),key=hash(JSON.stringify(['profile-summary-v1',item.family,item.fingerprint,action,before?runtimeVersion(before):null]));
  const previous=this.rows().find(r=>r.family===item.family),intent={...item,projectionKey:key,projectionPrevious:previous?.status==='managed'?previous:null};
  const prior=app.store.bySelection(key);if(prior){
   if(this.a.protection?.withdrawnReport(prior.reportId)){this.put(item,'undone',{content,applicationId:prior.id,reason:'已撤销的同版本摘要不重建'});return;}
   if(prior.plan){this.put(intent,'pending',{content:before?.content??content,version:before?runtimeVersion(before):null,applicationId:prior.id});await this.finalize(item,prior.id,signal);return;}
   // A failed replacement must not leave the obsolete old summary in USER forever.
   if(before&&previous?.status==='managed'){
    const old=await this.catalogue.resolve(previous.source_id,signal,{strict:true});
    if(old.status==='retired'||old.status==='active'&&!eligible(old))return this.apply({...previous.source,retirement:old.reason??'原适用范围已改变'},'remove',before,signal);
    this.lastError='同版本替换审核未完成，保留待核对摘要';return;
   }
   this.put(item,'failed',{content,applicationId:prior.id,reason:'同版本审核未完成，不重复消耗模型额度'});return;
  }
  return app.runProfile(this.authority,async joined=>{
   const memories=await app.memoryReader.read([],joined),source={id:item.id,kind:'person_profile',text:item.sourceText,occurredAt:item.at,contentHash:hash(item.sourceText),fingerprint:item.fingerprint};
   const caller={kind:'profile_summary',policy:'profile-summary-v1',principal:'main-user',authorizedAt:this.time()},request={action,content,...before?{reference:this.ref(before)}:{}};
   const frame=freeze(copy({protocol:'ai-friend/profile-summary/1',authorization:caller,profileSource:item,proposals:[{index:0,action:action==='remove'?'withdraw':'supplement',request,evidence:[{sourceId:item.id,quote:item.evidenceQuote}]}],sources:[source],memories,activeSpaces:[]}));
   // Persist ownership intent before any external Runtime write; the protected receipt recovers completion.
   await this.verify(frame,joined);
   this.put(intent,'pending',{content:before?.content??content,version:before?runtimeVersion(before):null,reason:'待核对审核与受保护写入'});
   try{
    const result=await app.reviewFrame({reportId:randomUUID(),key,selection:[0],caller,frame,modelRequired:action!=='remove',reviewer:(f,s)=>this.host.review(f,s),validate:summaryPlan,noModelDecision:{keep:true,reason:'已确认原事实更正或撤回，移除尚未被后续修改的摘要'}},joined);
    const row=app.store.bySelection(key);this.put(intent,'pending',{content:before?.content??content,version:before?runtimeVersion(before):null,applicationId:row?.id,reason:'已取得审核回执，核对摘要当前值'});
    if(result.status!=='busy')await this.finalize(item,row.id,joined);
   }catch(error){const row=app.store.bySelection(key);this.put(intent,row?.plan?'pending':'failed',{content:before?.content??content,version:before?runtimeVersion(before):null,applicationId:row?.id,reason:'审核或写入未完成，保留原始依据'});if(!row?.plan&&previous?.status==='managed')this.put(previous.source,'managed',{...this.options(previous),reason:'替换审核未完成，旧摘要等待来源再次核对'});throw error;}
  },signal);
 }
 async finalize(item,id,signal){
  const {projectionPrevious,projectionKey,...canonical}=item;item=canonical;
  const app=this.a.applications,run=app.store.get(id),steps=app.store.steps(id),previous=this.rows().find(r=>r.family===item.family),options=previous?this.options(previous):{};
  if(this.a.protection?.withdrawnReport(run.reportId)){this.put(item,'undone',{...options,applicationId:id,reason:'已撤销，同版本摘要不重建'});return;}
  if(run.status!=='completed'||steps.some(s=>s.status!=='applied'))return;
  if(!steps.length){
   if(run.model?.decision?.keep&&run.frame.proposals[0].request.action==='replace'&&previous&&await this.owned(previous,signal))this.put(item,'managed',{...options,applicationId:id,reason:'原摘要正文未变，仅更新已核实的来源版本'});
   else this.put(item,'vetoed',{applicationId:id,reason:run.plan.decisions[0]?.reason??'模型认为不适合作为常驻画像'});return;
  }
  const op=steps[0].operation;if(op.kind==='runtime_remove'){this.put(item,'withdrawn',{applicationId:id,reason:'已撤回此来源对应的常驻摘要，原始历史保留'});return;}
  // Use sealed post-write version, never adopt a later manual edit during recovery.
  const after=this.a.protection?.store.snapshot(id)?.after?.runtime,expected=after?.filter(e=>e.target==='user'&&e.content===op.content),current=(await app.backend.runtime.snapshot(signal)).entries.filter(e=>e.target==='user'&&e.content===op.content);
  if(expected?.length!==1){this.lastError='写后快照尚未封存，等待核对摘要版本';return;}
  if(current.length!==1||runtimeVersion(current[0])!==runtimeVersion(expected[0])){this.put(item,'detached',{content:op.content,applicationId:id,reason:'写入后已有后续变化，停止自动接管'});return;}
  this.put(item,'managed',{content:op.content,version:runtimeVersion(expected[0]),applicationId:id,reason:'来源已审核；通过公共 Runtime 接口及一致性快照写入'});this.lastError=null;
 }
 async view(signal){
  const items=await this.catalogueItems(signal),runtime=await this.a.applications.backend.runtime.snapshot(signal),rows=this.rows();
  const sources=items.map(({sourceText,...i})=>({...i,summary:rows.find(r=>r.family===i.family)?.status??(i.alreadyCore?'core':'not_selected')}));
  const summaries=rows.map(({source_json,runtime_version,...r})=>{const {sourceText,projectionPrevious,projectionKey,...source}=r.source;return {...r,source};});
  const result={generatedAt:this.time(),status:this.status(),profileChanges:this.a.profileChanges?.status()??null,resultNotices:this.a.profileNotices?.status()??null,runtime:{entries:runtime.entries.filter(e=>e.target==='user').map(e=>({content:e.content,importance:e.importance,updatedAt:e.updated_at})),limit:this.a.policy().runtimeLimits?.userLimitBytes??4096},sources,summaries,coverage:'当前至多200条QQ、100条B站、100条主会话类型化记录；完整原始记忆仍在各来源库。',meaning:'常驻摘要供本实例主用户私聊；来源事实保留原场景与公开权限。查看页面不会写入记忆。'};
  noSecret(JSON.stringify(result));return result;
 }
 async close(){this.closed=true;this.stop.abort();await this.active?.catch(()=>{});}
}
