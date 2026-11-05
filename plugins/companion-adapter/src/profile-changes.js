import {socialEligible,scopedFamily,temporaryChange,explicitGeneral,localChange} from './profile-social-source.js';
import {socialOriginal,socialScope} from '@ai-friend/qq-bridge/social-memory-store';
import {profileRule} from '@ai-friend/qq-bridge/person-policy';
import {randomUUID} from 'node:crypto';
import {ProfileChangeStore} from './profile-change-store.js';
import {ProfileChangeSources,sceneChange,changeCue} from './profile-change-source.js';
import {ProfileCatalogue} from './profile-catalogue.js';
import {normalizeChanges,prepareProfilePlan,validateProfileAudit} from './profile-change-plan.js';
import {runtimeVersion} from './apply-runtime.js';
import {hash,noSecret} from './validation.js';
const freeze=v=>{if(v&&typeof v==='object'){Object.freeze(v);for(const c of Object.values(v))freeze(c);}return v;};
const clone=v=>JSON.parse(JSON.stringify(v));
export class ProfileChanges{
 constructor(adapter,{authority,now=()=>new Date()}={}){
  Object.assign(this,{a:adapter,authority});this.store=new ProfileChangeStore(adapter.journal,now);this.store.bootstrap();this.catalogue=new ProfileCatalogue(adapter);this.sources=new ProfileChangeSources(adapter,()=>this.host);this.active=null;this.stop=new AbortController();this.closed=false;this.host=null;this.lastError=null;
  adapter.applications.backend.profileChangeStore=this.store;
  adapter.applications.profileChangeHandoff=frame=>this.handoff(frame);
  adapter.applications.profileChangeGuard=(frame,signal,row)=>this.verifyFrame(frame,signal,row);
 }
 bind(host){this.host=host;}
 handoff(frame){
  let text=null;
  if(frame.protocol==='ai-friend/memory-conversation/1'){
   const s=frame.sources?.find(s=>s.kind==='user_message'),q=this.a.qq?.binding;
   if(s?.channel==='qq'&&q&&s.qq?.botQQ===q.bot_qq&&s.qq?.senderQQ===q.owner_qq&&frame.proposals.some(p=>p.request?.target==='user'||p.request?.profile))text=s.text;
  }else if(frame.protocol==='ai-friend/social-memory/1'&&frame.profile){
   const s=this.a.bilibiliSocial,t=s?.store.turn(frame.sources?.[0]?.turnId),events=t&&s.store.events(t);
   if(t?.thread_key.startsWith('private:')&&events?.every(e=>e.sender===s.config.ownerUid))text=events.map(e=>e.payload.text).join('\n');
  }
  if(text&&changeCue(text)&&!sceneChange(text)&&this.catalogue.ids().length)return {status:'deferred_profile_change',applied:false,currentlyVerified:false,summary:'这条可能更正已有通用画像，已交给后台核对新原话与旧版本；尚未保存。请正常接话，稍后用 friend_profile_changes_read 核对进度，不要换工具重复写入。'};
 }
 socialHandoff(event){if(!socialEligible(this.a,event)||!changeCue(event.body))return false;const m=this.a.platforms.socialMemory;if(explicitGeneral(event.body)&&!localChange(event.body))return this.catalogue.ids().length>0;const dest={scene:event.kind==='qzone_comment'?event.thread_key:socialScope(event).thread,audience:event.kind==='group'?'group':event.raw.postVisibility===1?'public':event.raw.postVisibility===4?'friends':'self'},matches=item=>this.a.personProfiles.allows(item.rule,item.origin,dest)&&(!/叫|称呼/.test(event.body)||item.rule.kind==='address'||/叫|称呼/.test(item.content));for(const id of this.catalogue.ids().filter(id=>id.startsWith('qq:'))){const n=m.store.note(id.slice(3));if(!n||n.event_id===event.id)continue;const e=m.readEvent(n.event_id),p=m.store.job(n.event_id)?.proposals[n.proposal_index],raw=e&&socialOriginal(e);if(!raw)continue;const rule=profileRule({profile:p?.profile,source:raw,quote:n.evidence,kind:n.kind}),origin={scene:e.kind==='qzone_comment'&&rule.scope==='scene'?e.thread_key:socialScope(e).thread,audience:e.kind==='group'?'group':e.kind==='friend'?'private':e.raw.postVisibility===1?'public':e.raw.postVisibility===4?'friends':'self'};if(matches({rule,origin,content:n.content})&&!this.blocked(id,dest))return true;}return this.store.currentVersions().some(v=>v.action==='replace'&&matches(v.item)&&!this.blocked(v.item.id,dest));}
 socialVisible(note,event){const m=this.a.platforms?.socialMemory;if(!event)return !this.blocked('qq:'+note.id);const e=m?.readEvent(note.event_id),job=m?.store.job(note.event_id),p=job?.proposals[note.proposal_index],rule=e?profileRule({profile:p?.profile,source:socialOriginal(e)??'',quote:note.evidence,kind:note.kind}):null;if(e?.kind==='qzone_comment'&&rule?.scope==='scene'&&e.thread_key!==event.thread_key)return false;return !this.blocked('qq:'+note.id,{scene:event.kind==='qzone_comment'?event.thread_key:socialScope(event).thread});}
 verifySource(source,signal){return this.sources.verify(source,signal);}
 blocked(id,dest){const family=this.store.familyForSource(id),head=this.store.head(family);const overlay=dest?.scene?this.store.head(scopedFamily(dest.scene,family)):null;if(overlay&&id!=='change:'+overlay)return true;if(head&&id!=='change:'+head)return true;for(const r of this.store.db.prepare("SELECT proposal_json,source_json FROM profile_change_jobs WHERE status IN ('prepared','partial','backup_blocked') AND proposal_json IS NOT NULL").all()){const p=JSON.parse(r.proposal_json);if(p.changes?.some(c=>(c.scope!=='scene'||JSON.parse(r.source_json).scene===dest?.scene)&&c.targets.some(t=>t.family===family)))return true;}return false;}
 notices(){return {enabled:true,scope:'主用户QQ/B站私聊及已接入QQ群/空间中的画像更正',recent:this.store.recent(4),boundary:'更正须依据新的真实主用户原话；提案、审核中或部分完成不等于已保存。原聊天仅作历史，不能从旧消息自动恢复已撤回偏好。'};}
 hasApprovedPending(){return Boolean(this.store.db.prepare("SELECT 1 FROM profile_change_jobs WHERE status IN ('prepared','partial','backup_blocked') LIMIT 1").get());}
 status(){return {running:Boolean(this.active),hostReady:Boolean(this.host),lastError:this.lastError,...this.notices()};}
 async context(dest,signal){const items=[];for(const v of this.store.currentVersions().slice(-24)){
  if(v.action!=='replace'||this.blocked('change:'+v.id,dest)||!this.a.personProfiles.allows(v.item.rule,v.item.origin,dest))continue;
  const item=await this.catalogue.resolve('change:'+v.id,signal,{strict:true});if(item.status!=='active')continue;items.push({id:item.id,kind:item.rule.kind,content:item.content,evidenceQuote:item.evidenceQuote,scope:item.rule.scope,origin:item.origin,at:item.at,sourceVerification:'verified-profile-change',readOnly:true});
 }return items;}
 pump(){if(this.active)return this.active;if(this.closed||!this.host||this.host.busy()||this.a.applications.active||!this.a.policy().enabled||!this.a.policy().writeEnabled)return Promise.resolve();
  this.active=this.work(AbortSignal.any([this.stop.signal,AbortSignal.timeout(150000)])).catch(()=>{this.lastError='画像更正尚未完成；保留原件、逐步回执和后续修改'}).finally(()=>{this.active=null;});return this.active;
 }
 async candidates(source,signal){
  const ids=this.catalogue.ids(),runtime=(await this.a.applications.backend.runtime.snapshot(signal)).entries,managed=this.a.profileSummary?.rows()??[];
  for(const row of runtime.filter(r=>r.target==='user'))if(!managed.some(m=>m.status==='managed'&&m.content===row.content&&m.runtime_version===runtimeVersion(row)))ids.push('runtime:'+hash(row.content));
  for(const v of this.store.currentVersions())if(v.action==='retract')ids.push('change:'+v.id);
  const unique=[...new Set(ids)];if(unique.length>512)throw Error('画像候选过多，未截断原件后更正');const result=[];for(const id of unique){
   signal.throwIfAborted();let item=await this.catalogue.resolve(id,signal,{strict:true});
   // Main-user revocation need not wait for an old public website to become
   // reachable. The immutable local QQ audit and exact hot version still apply.
   if(item.status==='unavailable'&&id.startsWith('qq:'))item=await this.catalogue.resolve(id,signal,{strict:false});
   if(!['active','retracted'].includes(item.status)||item.sourceKey===source.key)continue;
   if(source.transport==='qq-social'&&source.mode==='scene'){
    const dest={scene:source.scene,audience:source.audience};if(!this.a.personProfiles.allows(item.rule,item.origin,dest)||this.blocked(item.id,dest))continue;
   }else if(item.rule.scope!=='person')continue;
   result.push({...item,subject:source.subject});if(result.length>32)throw Error('通用画像超过单批核对范围，未只更正部分副本');
  }return result;
 }
 async work(signal){
  await this.sources.collect(this.store,signal);const id=this.store.pending();if(!id){this.lastError=null;return;}const job=this.store.job(id),app=this.a.applications;
  const existingId=job.application_id??app.store.bySelection(hash('profile-change:'+job.source.hash))?.id;
  if(existingId){const run=app.store.get(existingId);if(!run?.plan){this.store.state(id,'failed',{reason:'审核未形成固定计划，未自动重放模型'});return;}if(this.a.protection.withdrawnReport(run.reportId)){this.store.state(id,'undone',{reason:'该批已撤销，同一原话不会重放'});return;}this.store.state(id,'prepared',{applicationId:existingId,reason:'核对已有固定计划，不重放模型'});return app.runProfile(this.authority,async joined=>{await this.sources.verify(job.source,joined);if(!app.store.steps(run.id).every(s=>s.status==='applied'))await app.advance(run,joined);await this.finish(id,run.id,joined);},signal);}
  if(job.source.transport==='qq-social'?temporaryChange(job.source.text):sceneChange(job.source.text)){this.store.state(id,'deferred',{reason:'当前入口只更正通用人物偏好；原话含局部或临时范围，需要确认具体适用范围'});return;}
  return app.runProfile(this.authority,async joined=>{
   try{
    await this.sources.verify(job.source,joined);const candidates=await this.candidates(job.source,joined);if(!candidates.length){this.store.state(id,'no_change',{reason:'没有可核对的当前通用画像；不猜测要覆盖的旧记录'});return;}
    const verifiedBoundary={subject:job.source.subject,scope:job.source.mode??'person',sourceScene:job.source.scene,reviewPrivacy:'internal-only; never forward private targets or reasons to a public reply',candidateIds:candidates.map(c=>c.id),accountIdentity:'宿主已按配置账号绑定核验这些原件属于同一主用户；昵称不作为身份依据',runtimeLinks:'compiled.before.summaries 是原件族与受管理常驻摘要的版本关联；Runtime原条目还在 memories.items 中逐字提供'};
    const proposalFrame=freeze(clone({source:job.source,candidates,verifiedBoundary,boundary:'内部画像协调审核，绝不把候选旧值或私密原因回填公开表达。公开原话默认scene，明确通用才person；临时、引用、补充不是撤回。'}));
    app.store.reserveCall(app.config.dailyCallLimit);this.store.state(id,'proposing',{reason:'根据真实原话识别对应关系'});const reviewed=await this.host.propose(proposalFrame,joined),proposal=normalizeChanges(reviewed.decision,proposalFrame);
    if(!proposal.changes.length){this.store.state(id,'deferred',{proposal,reason:proposal.reason});return;}
    this.store.state(id,'auditing',{proposal,reason:'提案尚未通过独立审核'});const compiled=await prepareProfilePlan(this.a,this.store,proposal,job.source,joined);compiled.operations.at(-1).jobId=id;
    const memories=job.source.transport==='qq-social'&&job.source.mode==='scene'?{items:candidates.map(t=>({id:t.id,kind:'person_profile',text:t.content})),queries:[],token:await app.memoryReader.token(joined),coverage:{scope:'only-visible-scene-candidates'}}:await app.memoryReader.read([],joined),source={id:job.source.key,kind:'profile_change_source',text:job.source.text,occurredAt:job.source.occurredAt,contentHash:hash(job.source.text),origin:job.source},caller={kind:'profile_change',policy:'profile-change-v1',principal:'main-user',authorizedAt:this.store.time()},key=hash('profile-change:'+job.source.hash),previous=app.store.bySelection(key);
    const frame=freeze(clone({protocol:'ai-friend/profile-change/1',authorization:caller,source:job.source,verifiedBoundary,proposals:[{index:0,action:'temporal_change',summary:proposal.reason,reason:proposal.reason,evidence:compiled.operations.at(-1).evidence,referenceIds:[]}],sources:[source],memories,compiled,candidates,disclosureBoundary:'本审核是内部数据面，私密旧值、审核原因、Runtime内容不可发送至公开场景；公开表达仅接收经过范围过滤的新事实',activeSpaces:this.a.policy().spaces.filter(s=>s.active).map(s=>({id:s.id,name:s.name}))}));
    if(JSON.stringify(frame).length>100000)throw Error('更正核验材料过多，未截断后写入');noSecret(JSON.stringify(frame));
    const result=await app.reviewFrame({reportId:previous?.reportId??randomUUID(),key,selection:[0],caller,frame,reviewer:(f,s)=>this.host.audit(f,s),validate:(value,f)=>{
     const plan=validateProfileAudit(value,f);if(plan.decisions[0].verdict==='apply')this.store.state(id,'prepared',{proposal,reason:'独立审核通过，等待快照及逐步写入'});return plan;
    }},joined);const run=app.store.bySelection(key);if(run)this.store.state(id,run.status==='completed'?'prepared':run.status,{applicationId:run.id,proposal,reason:result.error??'核对受保护应用回执'});if(run)await this.finish(id,run.id,joined);
   }catch(error){const run=app.store.bySelection(hash('profile-change:'+job.source.hash));this.store.state(id,run?.plan?'partial':'deferred',{applicationId:run?.id,reason:'原话、旧版本或审核未通过完整核验；未扩大写入，需按回执核对'});throw error;}
  },signal);
 }
 async finish(jobId,applicationId,signal){const app=this.a.applications,run=app.store.get(applicationId),steps=app.store.steps(applicationId);
  if(this.a.protection.withdrawnReport(run.reportId)){this.store.state(jobId,'undone',{applicationId,reason:'已撤销，不重放旧原话'});return;}
  if(run.status==='completed'&&steps.every(s=>s.status==='applied')){this.store.state(jobId,steps.length?'completed':'vetoed',{applicationId,reason:steps.length?'更正已核验提交，原始历史保留':run.plan.decisions[0].reason});this.lastError=null;return;}
  this.store.state(jobId,run.status==='backup_blocked'?'backup_blocked':'partial',{applicationId,reason:run.error??'尚有未完成的受保护步骤'});
 }
 async verifyFrame(frame,signal,row){
  if(frame.authorization?.kind!=='profile_change'||frame.protocol!=='ai-friend/profile-change/1')throw Error('更正授权不匹配');await this.sources.verify(frame.source,signal);
  const app=this.a.applications,steps=row?app.store.steps(row.id):[],meta=steps.find(s=>s.operation.kind==='profile_transition');if(meta?.status==='applied'){if(!this.store.current(meta.receipt))throw Error('这批更正已有后续版本');return;}
  this.store.checkBefore(frame.compiled.before);
  for(const step of steps.filter(s=>s.status==='applied'&&s.operation.kind!=='profile_transition')){
   if(!await app.backend.current(step,signal))throw Error('已提交的步骤被后续修改，未覆盖');
   if(step.operation.kind==='runtime_replace'){const row=(await app.backend.runtime.snapshot(signal)).entries.find(r=>r.target==='user'&&r.content===step.operation.content);if(!row||runtimeVersion(row)!==step.receipt.entryVersion)throw Error('已写入的常驻版本又发生变化');}
  }
  for(const c of frame.compiled.changes)for(const target of c.targets){
   const applied=steps.find(s=>s.status==='applied'&&(target.nativeRef?s.operation.kind==='native_correct'&&s.operation.reference?.recordId===target.nativeRef.recordId:s.operation.kind.startsWith('runtime_')&&s.operation.reference?.text===target.runtimeRef));
   if(applied){if(!await app.backend.current(applied,signal))throw Error('本批已写入的目标又发生变化，保留后来值');if(applied.operation.kind==='runtime_replace'){const r=(await app.backend.runtime.snapshot(signal)).entries.find(r=>r.target==='user'&&r.content===applied.operation.content);if(!r||runtimeVersion(r)!==applied.receipt.entryVersion)throw Error('常驻新值被后续改写');}continue;}
   let current=await this.catalogue.resolve(target.id,signal,{strict:true});if(current.status==='unavailable'&&target.id.startsWith('qq:'))current=await this.catalogue.resolve(target.id,signal,{strict:false});if(current.fingerprint!==target.fingerprint)throw Error('目标画像已变化，未按旧提案覆盖');
  }
 }
 async close(){this.closed=true;this.stop.abort();await this.active?.catch(()=>{});}
}
