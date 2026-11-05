import {ApplyStore} from './apply-store.js';
import {validateApplyPlan} from './apply-plan.js';
import {verifyReportSources} from './apply-evidence.js';
import {collectPreviewSources} from './preview-sessions.js';
import {validatePreview} from './preview.js';
import {hash,uuid,noSecret,aborted} from './validation.js';
import {ReviewTrace} from './review-trace.js';
import {groundVideoPlan} from './video-grounding.js';
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
const safeError=error=>{const value=String(error?.message??error).slice(0,700);try{noSecret(value);return value;}catch{return '失败诊断中疑似敏感内容已省略';}};
function bounded(value,fallback,min,max){const n=value??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('提案应用配置超出范围');return n;}
export class ApplicationController{
  constructor({journal,preview,backend,memoryReader,growth,policy,workspace,config={},writeEnabled=()=>true,now=()=>new Date(),maintenanceAuthority,conversationAuthority,activityAuthority,profileAuthority}){
    Object.assign(this,{journal,preview,backend,memoryReader,growth,policy,workspace,writeEnabled});
    if(config.enabled!==undefined&&typeof config.enabled!=='boolean')throw new Error('应用开关必须是布尔值');
    this.config={enabled:config.enabled??true,dailyCallLimit:bounded(config.dailyCallLimit,30,0,100),timeoutMs:bounded(config.timeoutMs,60000,1000,60000),backgroundTimeoutMs:bounded(config.backgroundTimeoutMs,120000,1000,180000),backgroundMaxTokens:bounded(config.backgroundMaxTokens,16384,1024,32768),maxTokens:bounded(config.maxTokens,8192,1024,8192)};
    this.maintenanceAuthority=maintenanceAuthority;this.conversationAuthority=conversationAuthority;this.activityAuthority=activityAuthority;this.profileAuthority=profileAuthority;this.store=new ApplyStore(journal,now);this.active=null;this.closed=false;
  }
  writable(){if(this.closed||!this.config.enabled||!this.writeEnabled()||!this.policy().writeEnabled)throw new Error('当前不允许应用整理提案，历史仍可查询');}
  status(){return {enabled:this.config.enabled&&this.writeEnabled()&&this.policy().writeEnabled,automatic:false,running:Boolean(this.active),callsToday:this.store.calls(),callsRemaining:Math.max(0,this.config.dailyCallLimit-this.store.calls()),recent:this.store.recent()};}
  reportInfo(reportId){
    const runs=this.store.forReport(reportId),steps=runs.flatMap(row=>this.store.steps(row.id)),applied=steps.filter(step=>step.status==='applied'),uncertain=steps.filter(step=>['writing','written'].includes(step.status));
    return {applied:applied.length?true:uncertain.length?null:false,verifiedOperations:applied.length,uncertainOperations:uncertain.length,runs:runs.map(row=>({id:row.id,status:row.status,selection:row.selection,error:row.error})),scope:'应用记录；是否仍为当前值请查询具体应用回执'};
  }
  pendingStateKeys(){
    const keys=new Set();
    const runs=this.store.db.prepare("SELECT id FROM apply_runs WHERE status IN ('prepared','applying','partial','interrupted','cancelled','backup_blocked')").all();
    for(const row of runs){const steps=this.store.steps(row.id);if(!steps.some(step=>step.operation.kind!=='review_self'&&['writing','written','applied'].includes(step.status)))continue;
      for(const step of steps)if(step.operation.kind==='review_self'&&step.status!=='applied'&&this.growth.store.head(step.operation.stateBefore.key)?.id===step.operation.stateBefore.id)keys.add(step.operation.stateBefore.key);
    }
    for(let depth=0;depth<24;depth++){let changed=false;for(const state of this.growth.store.heads())if(!keys.has(state.key)&&state.dependsOn.some(id=>keys.has(this.growth.store.version(id)?.key))){keys.add(state.key);changed=true;}if(!changed)break;}
    return keys;
  }
  async read(id,signal){
    const chosen=id??this.store.recent(1)[0]?.id,row=chosen?this.store.get(chosen):null;if(!row)return {status:'no_application',applied:false,...this.status()};
    if(this.protection?.store.undo(row.id)?.status==='completed')return {status:'undone',applicationId:row.id,reportId:row.reportId,applied:false,historicallyApplied:true,currentlyVerified:false,fullyProcessed:true,protection:this.protection.summary(row.id),steps:this.store.steps(row.id),summary:'这批应用已明确撤销，过去的写入和原话保留为历史，不能视为当前记忆或重新应用。'};
    const steps=this.store.steps(row.id),verified=steps.filter(step=>step.status==='applied');let current=null;
    if(verified.length){const values=await Promise.all(verified.map(step=>this.backend.current(step,signal).catch(()=>null)));current=values.includes(false)?false:values.includes(null)?null:true;}
    const status=current===false&&row.status==='completed'?'historical':row.status;
    return {status,...this.protection?{protection:this.protection.summary(row.id)}:{},applicationId:row.id,reportId:row.reportId,attemptDiagnostics:this.store.attempts(row.id),applied:verified.length?true:steps.some(step=>['writing','written'].includes(step.status))?null:false,fullyProcessed:row.status==='completed',currentlyVerified:current,verifiedOperations:verified.length,pendingOperations:steps.filter(step=>step.status!=='applied').length,decisions:row.plan?.decisions.map(({operations,...decision})=>decision)??[],steps:steps.map(step=>({id:step.id,status:step.status,kind:step.operation.kind,proposalIndex:step.operation.proposalIndex,reason:step.operation.reason,evidence:step.operation.evidence,videoEvidence:step.operation.videoEvidence??[],previous:step.operation.reference??null,current:step.operation.content??null,receipt:step.receipt,error:step.error})),error:row.error,createdAt:row.createdAt,updatedAt:row.updatedAt,summary:status==='historical'?'这组提案过去已处理，部分目标后来变化；未重放旧值。':row.status==='completed'?(verified.length?'所选提案已按回执核对完成；原始依据与历史保留。':'所选提案无需修改，已记录核对结果。'):'应用尚未全部完成；已发生的步骤和待处理原因分别保留。'};
  }
  runMaintenance(authority,args,runId,persistence,reviewer,signal){
    try{this.writable();if(!this.maintenanceAuthority||authority!==this.maintenanceAuthority)throw new Error('后台应用授权不匹配');uuid(runId);uuid(args.reportId);}catch(error){return Promise.reject(error);}
    return this.start(args,{kind:'nightly',runId,policy:'nightly-v1',authorizedAt:this.store.time()},persistence,reviewer,signal);
  }
  run(args,caller,persistence,reviewer,signal){
    try{this.writable();if(!caller?.owner||!caller.sessionId||!caller.messageId||!Number.isSafeInteger(caller.seq)||!Number.isSafeInteger(caller.turnStart)||!caller.quote)throw new Error('应用需要主用户本轮的具体请求及原话');noSecret(JSON.stringify(caller));uuid(args.reportId);}catch(error){return Promise.reject(error);}
    return this.start(args,caller,persistence,reviewer,signal);
  }
  start(args,caller,persistence,reviewer,signal){
    return this.startTask(combined=>this.execute(args,caller,persistence,reviewer,combined),signal);
  }
  runConversation(authority,task,signal){
    try{this.writable();if(!this.conversationAuthority||authority!==this.conversationAuthority)throw new Error('日常记忆写入授权不匹配');}catch(error){return Promise.reject(error);}
    return this.startTask(task,signal);
  }
  runActivity(authority,task,signal){try{this.writable();if(!this.activityAuthority||authority!==this.activityAuthority)throw new Error('活动记忆授权不匹配');}catch(error){return Promise.reject(error);}return this.startTask(task,signal);}
  runProfile(authority,task,signal){try{this.writable();if(!this.profileAuthority||authority!==this.profileAuthority)throw Error('常驻画像维护授权不匹配');}catch(error){return Promise.reject(error);}return this.startTask(task,signal);}
  startTask(task,signal){
    if(this.active)return Promise.resolve({status:'busy',applied:false,summary:'已有一个提案应用正在进行，请先查询其回执。'});
    const stop=new AbortController(),combined=signal?AbortSignal.any([signal,stop.signal]):stop.signal,active={stop,promise:null};this.active=active;
    active.promise=Promise.resolve().then(()=>task(combined)).finally(()=>{if(this.active===active)this.active=null;});return active.promise;
  }
  async execute(args,caller,persistence,reviewer,signal){
    aborted(signal);const report=this.preview.store.get(args.reportId);if(report?.status!=='completed')throw new Error('只能应用已完成且未过时的预演报告');
    if(this.protection?.withdrawnReport(report.id))return {status:'withdrawn',applied:false,reportId:report.id,summary:'这份报告的应用已明确撤销，未重新写入。需要改动请依据新交流重新预演。'};
    validatePreview(report.result.decision,report.snapshot);
    const all=report.result.decision.proposals;if(!all.length)return {status:'no_changes',applied:false,reportId:report.id,summary:'这份报告没有需要应用的提案。'};
    const selection=[...(args.proposalIndexes??all.map((_row,index)=>index))];
    if(!Array.isArray(selection)||!selection.length||selection.length>8||selection.some(index=>!Number.isSafeInteger(index)||index<0||index>=all.length)||new Set(selection).size!==selection.length)throw new Error('请选择报告中实际存在且不重复的提案序号');
    selection.sort((a,b)=>a-b);const key=hash(JSON.stringify([report.id,selection]));let row=this.store.bySelection(key);
    if(row?.plan){
      if(this.store.steps(row.id).every(step=>step.status==='applied'))return {...await this.read(row.id,signal),replayed:true};
      await verifyReportSources(row.frame.sources,persistence,this.workspace,signal);if(this.videoGrounding)await this.videoGrounding.verify(row.frame.videoGrounding,row.frame.sources,persistence,signal);return this.advance(row,signal);
    }
    await verifyReportSources(report.snapshot.sources.sources,persistence,this.workspace,signal);
    if(this.videoGrounding)await this.videoGrounding.verify(report.snapshot.sources.videoGrounding,report.snapshot.sources.sources,persistence,signal);
    const selected=selection.map(index=>({index,...all[index]}));
    const refs=new Set(selected.flatMap(item=>item.referenceIds));
    const memories=await this.memoryReader.read(report.snapshot.memories.queries??[],signal),items=new Map(memories.items.map(item=>[item.id,item]));
    for(const id of refs){const original=report.snapshot.memories.items.find(item=>item.id===id);const checked=await this.backend.reference(original,signal);items.set(id,checked);}
    const cursors=Object.fromEntries(report.snapshot.sources.ranges.map(range=>[range.sessionId,{nextSeq:range.nextSeq,updatedAt:report.updatedAt}]));
    const newEvidence=await collectPreviewSources({persistence,workspace:this.workspace,cursors,currentSessionId:caller.sessionId,currentTurnStart:caller.turnStart,scope:'companion',limits:this.preview.config,signal,background:caller.kind==='nightly'});
    const frame=freeze(JSON.parse(JSON.stringify({protocol:'ai-friend/memory-application/1',reviewedAt:this.store.time(),authorization:caller,reportId:report.id,proposals:selected,sources:report.snapshot.sources.sources,...this.videoGrounding?{videoGrounding:this.videoGrounding.refresh(report.snapshot.sources.videoGrounding)}:{},newEvidence,memories:{...memories,items:[...items.values()]},activeSpaces:this.policy().spaces.filter(space=>space.active).map(space=>({id:space.id,name:space.name}))})));
    if(JSON.stringify(frame).length>100000)throw new Error('应用材料过多，请分批预演后再处理');noSecret(JSON.stringify(frame));
    const modelRequired=selected.some(item=>!['keep','duplicate','conflict','defer'].includes(item.action));
    return this.reviewFrame({reportId:report.id,key,selection,caller,frame,modelRequired,reviewer,config:caller.kind==='nightly'?{...this.config,timeoutMs:this.config.backgroundTimeoutMs}:this.config},signal);
  }
  async reviewFrame({reportId,key,selection,caller,frame,modelRequired=true,reviewer,config=this.config,budgetKind='application',validate=validateApplyPlan,noModelDecision},signal){
    this.writable();aborted(signal);
    const handoff=this.profileChangeHandoff?.(frame);if(handoff)return handoff;
    const {row}=this.store.begin({reportId,key,selection,approval:caller,frame,limit:config.dailyCallLimit,modelRequired,budgetKind});
    let timer;const trace=new ReviewTrace();trace.inputCharacters=JSON.stringify(frame).length;
    try{
      let reviewed;
      if(!modelRequired)reviewed={decision:noModelDecision??{decisions:frame.proposals.map(item=>({proposalIndex:item.index,verdict:['keep','duplicate'].includes(item.action)?'noop':'defer',timing:'uncertain',reason:item.reason,operations:[]}))},usage:null};
      else{
        const timeout=new AbortController();timer=setTimeout(()=>timeout.abort(new Error('应用审核超时')),config.timeoutMs);const combined=AbortSignal.any([signal,timeout.signal]);
        reviewed=await trace.step('modelReview',()=>new Promise((resolve,reject)=>{const abort=()=>reject(combined.reason);combined.addEventListener('abort',abort,{once:true});if(combined.aborted){abort();return;}Promise.resolve().then(()=>reviewer(frame,combined,event=>trace.progress(event))).then(resolve,reject).finally(()=>combined.removeEventListener('abort',abort));}));aborted(combined);
      }
      const plan=await trace.step('validation',()=>this.filterRetiredPlan(groundVideoPlan(validate(reviewed.decision,frame),frame),frame));
      if(modelRequired&&(frame.memories.changedDuringRead||await this.memoryReader.token(signal)!==frame.memories.token)){this.store.failReview(row.id,'stale','审核期间资料已变化，未执行写入');return this.read(row.id,signal);}
      const operations=[];for(const operation of plan.decisions.flatMap(decision=>decision.operations))operations.push(await this.backend.prepare(operation,signal));
      // State review follows every fact write, so an uncertainty never silently presents it as fully propagated.
      operations.sort((a,b)=>Number(a.kind==='review_self')-Number(b.kind==='review_self'));
      noSecret(JSON.stringify({plan,operations,reviewed}));this.store.prepare(row.id,plan,{decision:reviewed.decision,usage:reviewed.usage??null,provider:reviewed.provider??null,model:reviewed.model??null,reasoningEffort:reviewed.reasoningEffort??null,diagnostics:trace.snapshot()},operations);
      return this.advance(this.store.get(row.id),signal);
    }catch(error){const message=safeError(error);if(!this.store.get(row.id)?.plan)this.store.failReview(row.id,signal.aborted?'cancelled':'failed',message,trace.snapshot());throw new Error(`提案应用审核未完成：${message}`);}finally{clearTimeout(timer);}
  }
  async advance(row,signal){
    if(this.protection)return this.protection.submit(row,signal,()=>this.advancePrepared(row,signal));
    return this.advancePrepared(row,signal);
  }
  async advancePrepared(row,signal){
    this.writable();this.store.state(row.id,'applying');
    try{
      if(row.approval?.kind==='profile_summary'){
        if(!this.profileGuard)throw Error('画像来源核验器尚未就绪');
        await this.profileGuard(row.frame,signal);
      }
      if(row.approval?.kind==='profile_change'&&this.store.steps(row.id).length){if(!this.profileChangeGuard)throw Error('更正来源核验器未就绪');await this.profileChangeGuard(row.frame,signal,row);}
      if(this.store.steps(row.id).some(step=>step.status!=='applied'&&this.retiredWrite(step.operation,row.frame)))throw new Error('计划的旧依据已被后续更正或撤回，未重新写入旧事实；请依据新交流重新核对');
      for(const step of this.store.steps(row.id)){
        aborted(signal);this.writable();if(step.status==='applied')continue;
        if(row.approval?.kind==='profile_summary'){
          if(!this.profileGuard)throw Error('画像来源核验器尚未就绪');
          await this.profileGuard(row.frame,signal);
        }
        if(row.approval?.kind==='profile_change'){if(!this.profileChangeGuard)throw Error('更正来源核验器未就绪');await this.profileChangeGuard(row.frame,signal,row);}
        try{if(this.videoGrounding)this.videoGrounding.current(row.frame,step.operation,row.id);const receipt=await this.backend.execute(step,row,this.store,signal);if(!receipt?.verified)throw new Error('应用步骤缺少可核对的成功回执');if(step.operation.kind!=='review_self')this.store.step(step.id,'applied',receipt);}
        catch(error){this.store.step(step.id,step.status==='written'?'written':this.store.steps(row.id).find(item=>item.id===step.id).status,null,safeError(error));throw error;}
      }
      const deferred=row.plan.decisions.some(item=>item.verdict==='defer');this.store.state(row.id,deferred?(this.store.steps(row.id).length?'partial':'deferred'):'completed');
    }catch(error){this.store.state(row.id,signal.aborted?'cancelled':'partial',safeError(error));}
    return this.read(row.id,signal.aborted?undefined:signal);
  }
  retiredWrite(operation,frame){
    if(!operation.content||!['runtime_add','runtime_replace','native_add','native_correct'].includes(operation.kind))return false;
    const evidence=frame.sources.filter(source=>(source.kind==='user_message'||frame.authorization?.kind==='profile_summary'&&source.kind==='person_profile'||frame.authorization?.kind==='profile_change'&&source.kind==='profile_change_source')&&operation.evidence.some(item=>item.sourceId===source.id));
    const newer=(source,prior)=>source.sessionId&&prior.sessionId&&source.sessionId===prior.sessionId?source.seq>prior.seq:Date.parse(source.occurredAt)>Date.parse(prior.occurredAt);
    return this.store.retirements(operation.content).some(retired=>!retired.sources.length||!evidence.some(source=>retired.sources.every(prior=>newer(source,prior))));
  }
  filterRetiredPlan(plan,frame){
    return {decisions:plan.decisions.map(decision=>decision.operations.some(operation=>this.retiredWrite(operation,frame))?{...decision,verdict:'noop',timing:'current',reason:'宿主核对：该旧事实已有后续纠正或撤回，本提案没有更晚的原始用户依据；未从旧交流重新保存。',operations:[]}:decision)};
  }
  async close(){this.closed=true;this.active?.stop.abort(new Error('提案应用服务已停止'));await this.active?.promise.catch(()=>{});}
}
