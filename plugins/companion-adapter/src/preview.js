import {PreviewStore} from './preview-store.js';
import {collectPreviewSources} from './preview-sessions.js';
import {text,hash,noSecret,aborted} from './validation.js';
import {ReviewTrace} from './review-trace.js';
import {previewInputCharacters,previewRepairInputCharacters} from './preview-reviewer.js';
import {validatePreviewShape,previewGroundingError,safePreviewDraft,previewRepairEligibility,assertPreviewRepairScope} from './preview-protocol.js';

const requiresReference=new Set(['duplicate','temporal_change','conflict','leave_hot','review_self']);
function integer(value,fallback,min,max,label){const n=value??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${label} 配置超出范围`);return n;}
export function previewConfig(value={},namespace='manual'){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.enabled!==undefined&&typeof value.enabled!=='boolean')throw new Error('预演配置不正确');
  return {enabled:value.enabled??true,dailyCallLimit:integer(value.dailyCallLimit,6,0,100,'预演每日额度'),timeoutMs:namespace==='nightly'?integer(value.backgroundTimeoutMs,120000,1000,180000,'后台预演超时'):integer(value.timeoutMs,45000,1000,60000,'预演超时'),maxInputChars:integer(namespace==='nightly'?value.backgroundMaxInputChars:value.maxInputChars,namespace==='nightly'?48000:70000,4000,70000,'预演总输入'),maxTokens:namespace==='nightly'?integer(value.backgroundMaxTokens,16384,1024,32768,'后台预演输出'):integer(value.maxTokens,8192,1024,8192,'预演输出'),maxSessions:integer(value.maxSessions,4,1,12,'预演会话数'),maxTurns:integer(value.maxTurns,8,1,24,'预演回合数'),maxSourceChars:integer(value.maxSourceChars,16000,2000,30000,'预演输入'),maxMessageChars:6000,maxScannedEvents:integer(value.maxScannedEvents,4096,128,16384,'预演扫描事件数')};
}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
function safeError(error){const value=String(error?.message??error).slice(0,600);try{noSecret(value);return value;}catch{return '失败诊断中疑似敏感内容已省略';}}
function exactKeys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('预演 JSON 包含未定义字段');}
export function validatePreview(value,snapshot){
  value=validatePreviewShape(value);
  exactKeys(value,['summary','proposals']);const summary=text(value.summary,'预演总结',1200);
  if(!Array.isArray(value.proposals)||value.proposals.length>8)throw new Error('预演提案数量不正确');
  const sources=new Map(snapshot.sources.sources.map(row=>[row.id,row])),memories=new Map(snapshot.memories.items.map(row=>[row.id,row]));
  const proposals=value.proposals.map((row,index)=>{
    exactKeys(row,['action','summary','reason','evidence','referenceIds','effectiveTime','conditions']);
    const evidence=row.evidence.map((item,evidenceIndex)=>{
      exactKeys(item,['sourceId','quote']);const source=sources.get(item.sourceId),quote=text(item.quote,'预演原话',1500);
      if(!source||!source.text.includes(quote))throw previewGroundingError(`proposals.${index}.evidence.${evidenceIndex}`,'预演引文没有对应的真实逐字原话');
      return {sourceId:source.id,quote};
    });
    if(!evidence.some(item=>sources.get(item.sourceId).kind==='user_message'))throw previewGroundingError(`proposals.${index}.evidence`,'预演不能只以助手自述或工具输出作为用户依据');
    const refs=[...new Set(row.referenceIds)];if(refs.some(id=>!memories.has(id)))throw previewGroundingError(`proposals.${index}.referenceIds`,'预演引用了本次没有读取的旧条目');
    if(requiresReference.has(row.action)&&!refs.length)throw previewGroundingError(`proposals.${index}.referenceIds`,'这类预演建议缺少相关旧记忆');
    if(row.action==='review_self'&&!refs.some(id=>memories.get(id).kind==='self'))throw previewGroundingError(`proposals.${index}.referenceIds`,'自我复核建议必须对应已存在的状态');
    if(row.action==='leave_hot'&&refs.some(id=>memories.get(id).kind!=='runtime'||memories.get(id).target!=='memory'))throw previewGroundingError(`proposals.${index}.referenceIds`,'退出常驻建议仅支持工作记忆，不得据此清空用户画像');
    return {action:row.action,summary:text(row.summary,'建议内容',500),reason:text(row.reason,'建议依据',900),evidence,referenceIds:refs,...row.effectiveTime?{effectiveTime:text(row.effectiveTime,'生效时间',160)}:{},...row.conditions?{conditions:text(row.conditions,'适用条件',400)}:{}};
  });
  const result={summary,proposals};noSecret(JSON.stringify(result));return result;
}
export class PreviewController{
  constructor({journal,workspace,memoryReader,writeEnabled=()=>true,config={},now=()=>new Date(),namespace='manual',maintenanceAuthority}){
    Object.assign(this,{journal,workspace,memoryReader,writeEnabled});this.config=previewConfig(config,namespace);this.maintenanceAuthority=maintenanceAuthority;this.namespace=namespace;this.store=new PreviewStore(journal,now,namespace);this.active=null;this.closed=false;this.protectedTurns=new WeakMap();
  }
  protectTurn(agent,seq){this.protectedTurns.set(agent,seq);}
  isProtectedTurn(agent,seq){
    if(!agent?.session||!this.protectedTurns.has(agent))return false;
    if(seq===undefined)for(let index=agent.session.seq-1;index>=Math.max(0,agent.session.seq-1000);index--){const event=agent.session.eventAt(index);if(event?.type==='turn/start'){seq=event.seq;break;}}
    return seq===undefined||this.protectedTurns.get(agent)===seq;
  }
  status(){return {enabled:this.config.enabled&&this.writeEnabled(),previewOnly:true,automatic:false,running:Boolean(this.active),reviewTimeoutMs:this.config.timeoutMs,maxInputChars:this.config.maxInputChars,activeDiagnostics:this.active?.trace.snapshot()??null,callsToday:this.store.budget(),callsRemaining:Math.max(0,this.config.dailyCallLimit-this.store.budget()),recent:this.store.list(5)};}
  read(id,includeSources=false){
    const chosen=id??this.store.list(1)[0]?.id,row=chosen?this.store.get(chosen):null;
    if(!row)return {status:'no_report',previewOnly:true,applied:false,...this.status()};
    const source=row.snapshot.sources,memories=row.snapshot.memories??{items:[],coverage:{}};
    const refs=new Set(row.result?.decision?.proposals.flatMap(item=>item.referenceIds)??[]);
    const applicationStatus=this.applicationInfo?.(row.id)??null;
    return {status:row.status,reportId:row.id,previewOnly:true,applied:applicationStatus?applicationStatus.applied:false,applicationStatus,attempts:row.attempts,attemptDiagnostics:this.store.attempts(row.id,includeSources),summary:row.result?.decision?.summary??'仅预演，未修改记忆或自我状态。',proposals:row.result?.decision?.proposals??[],error:row.error,createdAt:row.createdAt,updatedAt:row.updatedAt,coverage:memories.coverage??{},memoryNotices:memories.notices??[],videoGrounding:source.videoGrounding??null,sourceSummary:{completedTurns:source.completedTurns,userMessages:source.sources.filter(item=>item.kind==='user_message').length,scannedEvents:source.scannedEvents},sourceProgress:source.ranges,excluded:source.excluded,deferredSessions:source.deferredSessions,sourceNotices:source.notices,references:memories.items.filter(item=>refs.has(item.id)),sources:source.sources.map(item=>includeSources?item:((({text,...metadata})=>metadata)(item))),usage:row.result?.usage??null,model:row.result?{provider:row.result.provider??null,model:row.result.model??null,reasoningEffort:row.result.reasoningEffort??null}:null,reviewMeaning:applicationStatus?.applied?'报告中部分或全部操作过去已应用，当前是否仍有效请查询回执；报告本身不成为新经历。':'这是待复核的整理提案，未应用，也不能作为新的独立经历。'};
  }
  runMaintenance(authority,persistence,reviewer,signal,checkpoint){
    if(!this.maintenanceAuthority||authority!==this.maintenanceAuthority)return Promise.reject(new Error('后台预演授权不匹配'));
    return this.start({scope:'companion'},{kind:'nightly',checkpoint},persistence,reviewer,signal);
  }
  run(args,caller,persistence,reviewer,signal){
    if(this.closed||!this.config.enabled||!this.writeEnabled())return Promise.reject(new Error('记忆预演当前未启用，历史报告仍可读取'));
    if(caller?.owner!==true||!caller.sessionId||!Number.isSafeInteger(caller.turnStart))return Promise.reject(new Error('预演仅支持主用户的直接陪伴会话'));
    return this.start(args,caller,persistence,reviewer,signal);
  }
  start(args,caller,persistence,reviewer,signal){
    if(this.closed||!this.config.enabled||!this.writeEnabled())return Promise.reject(new Error('记忆预演当前未启用'));
    if(this.active)return Promise.resolve({status:'busy',previewOnly:true,applied:false,summary:'已有一个预演正在执行，请稍后查询报告。'});
    const stop=new AbortController(),combined=signal?AbortSignal.any([stop.signal,signal]):stop.signal;
    const operation={stop,promise:null,trace:new ReviewTrace()};this.active=operation;
    operation.promise=this.execute(args,caller,persistence,reviewer,combined,operation.trace).finally(()=>{if(this.active===operation)this.active=null;});
    return operation.promise;
  }
  async execute(args,caller,persistence,reviewer,signal,trace){
    aborted(signal);const scope=args.scope??'current';if(!['current','companion'].includes(scope))throw new Error('预演范围只能是当前会话或本实例陪伴会话');
    if(this.store.budget()>=this.config.dailyCallLimit)return {status:'budget_exhausted',previewOnly:true,applied:false,summary:'今日预演模型额度已用完，已有报告可继续查询。'};
    if(args.queries!==undefined&&(!Array.isArray(args.queries)||args.queries.length>2))throw new Error('预演最多接受两条相关主题查询');
    const requested=(args.queries??[]).map(query=>text(query,'相关记忆查询',160));requested.forEach(noSecret);
    let limits={...this.config},sources,memories,snapshot,hasSources,serialized;
    for(;;){
      sources=await trace.step('sourceRead',()=>collectPreviewSources({persistence,workspace:this.workspace,cursors:this.store.cursors(),currentSessionId:caller.sessionId,currentTurnStart:caller.turnStart,scope,limits,signal,background:caller.kind==='nightly'}));
      if(this.videoGrounding)sources=await trace.step('videoGrounding',()=>this.videoGrounding.enrich(sources,persistence,limits,signal));
      hasSources=sources.sources.some(row=>row.kind==='user_message');const hasProgress=sources.ranges.some(row=>row.nextSeq>row.from);
      if(!hasSources&&!hasProgress)return {status:'no_new_events',previewOnly:true,applied:false,summary:'没有新的已完成交流可供预演。',sourceProgress:sources.ranges,sourceNotices:sources.notices,deferredSessions:sources.deferredSessions,latestReportId:this.store.list(1)[0]?.id??null};
      const fallback=sources.sources.filter(row=>row.kind==='user_message').slice(-2).map(row=>row.text.slice(0,160));
      memories=hasSources?await trace.step('memoryRead',()=>this.memoryReader.read(requested.length?requested:fallback,signal)):{items:[],coverage:{},notices:[],token:null};
      snapshot=freeze(JSON.parse(JSON.stringify({protocol:'ai-friend/memory-preview/1',...this.namespace==='nightly'?{purpose:'nightly'}:{},sources,memories})));
      serialized=JSON.stringify(snapshot);trace.inputCharacters=previewInputCharacters(snapshot);
      if(trace.inputCharacters<=this.config.maxInputChars)break;
      if(sources.completedTurns<=1||limits.maxTurns<=1)throw new Error('单个完整回合与相关资料超过预演总输入预算，原件和游标保留');
      limits={...limits,maxTurns:Math.max(1,Math.floor(limits.maxTurns/2))};trace.rebatches++;
    }
    noSecret(serialized);
    const key=hash(JSON.stringify({scope,...this.namespace==='nightly'?{namespace:'nightly'}:{},ranges:sources.ranges,sourceHashes:sources.sources.map(row=>[row.id,row.contentHash]),...sources.videoGrounding?{videoGrounding:sources.videoGrounding}:{},memoryToken:memories.token}));
    const started=this.store.begin(key,snapshot,this.config.dailyCallLimit,hasSources,caller.kind==='nightly'?caller.checkpoint:undefined),id=started.row.id;
    if(started.replayed)return {...this.read(id),replayed:true};
    let timer;
    try{
      if(!hasSources){this.store.finish(id,'empty',{decision:{summary:'没有新的原始交流依据；仅记录扫描进度，未调用模型。',proposals:[]}},null,trace.snapshot());return this.read(id);}
      const timeout=new AbortController();timer=setTimeout(()=>timeout.abort(Object.assign(new Error('记忆预演审核超时'),{code:'PREVIEW_TIMEOUT'})),this.config.timeoutMs);
      const reviewSignal=AbortSignal.any([signal,timeout.signal]);
      let reviewed;
      try{reviewed=await this.reviewAttempt(id,'initial',snapshot,reviewer,reviewSignal,trace,snapshot);}
      catch(error){
        const previous=error.previewDraft,eligibility=previewRepairEligibility(previous,error,snapshot);let skipped=null;
        if(!eligibility.allowed)skipped=eligibility.reason;
        else if(typeof reviewer.repair!=='function')skipped='repair_not_supported';
        const request=eligibility.allowed?freeze({snapshot,previous:structuredClone(previous),problem:{code:error.code,issues:error.issues??[]},...error.previewRoute?{route:error.previewRoute}:{}}):null;
        if(!skipped&&previewRepairInputCharacters(request)>this.config.maxInputChars)skipped='repair_input_budget';
        if(!skipped&&reviewer.repair.available?.()===false)skipped='host_model_budget';
        if(!skipped&&this.store.budget()>=this.config.dailyCallLimit)skipped='preview_model_budget';
        if(skipped){
          if(error.previewPhase)this.store.reviewPhase(id,{...error.previewPhase,repairSkipped:skipped});
          if(['host_model_budget','preview_model_budget'].includes(skipped))throw Object.assign(Error('结构纠正模型额度已用完，原输出与游标保留'),{code:caller.kind==='nightly'?'NIGHTLY_BUDGET':'PREVIEW_BUDGET'});
          throw error;
        }
        aborted(reviewSignal);if(this.closed||!this.config.enabled||!this.writeEnabled())throw Error('预演当前未启用，未发起结构纠正');
        if(memories.changedDuringRead||await this.memoryReader.token(reviewSignal)!==memories.token){this.store.finish(id,'stale',null,'纠正前资料已变化，保留原输出但游标未推进',trace.snapshot());return this.read(id);}
        try{this.store.reserveRepair(id,this.config.dailyCallLimit);}catch(e){if(e.code==='PREVIEW_BUDGET'&&caller.kind==='nightly')e.code='NIGHTLY_BUDGET';throw e;}
        reviewed=await this.reviewAttempt(id,'repair',request,reviewer.repair,reviewSignal,trace,snapshot,previous);
      }
      const {result,decision}=reviewed;
      if(this.videoGrounding)await this.videoGrounding.verify(sources.videoGrounding,sources.sources,persistence,reviewSignal);
      const token=await trace.step('contextCheck',()=>this.memoryReader.token(reviewSignal));aborted(reviewSignal);
      const stale=memories.changedDuringRead||token!==memories.token;
      const outcome={decision,usage:result.usage??null,provider:result.provider??null,model:result.model??null,reasoningEffort:result.reasoningEffort??null};noSecret(JSON.stringify(outcome));
      this.store.finish(id,stale?'stale':'completed',outcome,stale?'预演期间已有资料变化，报告保留但游标未推进，请重新预演':null,trace.snapshot());
      return this.read(id);
    }catch(error){
      const message=safeError(error);if(this.store.get(id)?.status==='running')this.store.finish(id,signal.aborted?'cancelled':'failed',null,message,trace.snapshot());
      throw Object.assign(new Error(`记忆预演未完成，未修改记忆或自我状态：${message}`),{code:error?.code,diagnostics:trace.snapshot()});
    }finally{clearTimeout(timer);}
  }
  async reviewAttempt(id,phase,input,reviewer,signal,trace,snapshot,previous){
    aborted(signal);const phaseTrace=new ReviewTrace(),at=this.store.time();let result;
    this.store.reviewPhase(id,{phase,status:'running',at});
    try{
      result=await trace.step('modelReview',()=>new Promise((resolve,reject)=>{
        const cancel=()=>reject(signal.reason??Error('记忆预演已取消'));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted){cancel();return;}
        Promise.resolve().then(()=>reviewer(input,signal,event=>{trace.progress(event);phaseTrace.progress(event);})).then(resolve,reject).finally(()=>signal.removeEventListener('abort',cancel));
      }));
      aborted(signal);if(result?.decision!==undefined)try{noSecret(JSON.stringify(result.decision));}catch{throw Object.assign(Error('模型输出包含疑似敏感内容，未发起结构纠正'),{code:'PREVIEW_SENSITIVE_OUTPUT'});}
      const decision=await trace.step('validation',()=>{const value=validatePreview(result?.decision,snapshot);if(previous)assertPreviewRepairScope(previous,value);return value;});
      this.store.reviewPhase(id,{phase,status:'validated',at,finishedAt:this.store.time(),diagnostics:phaseTrace.snapshot(),model:{provider:result.provider??null,model:result.model??null,usage:result.usage??null}});
      return {result,decision};
    }catch(error){
      if(!(error instanceof Error))error=Error(safeError(error));
      const record={phase,status:signal.aborted?'cancelled':'invalid',at,finishedAt:this.store.time(),problem:{code:error?.code??'REVIEW_FAILED',message:safeError(error),issues:['PREVIEW_SCHEMA_INVALID','PREVIEW_GROUNDING_INVALID'].includes(error.code)?error.issues??[]:[]},diagnostics:phaseTrace.snapshot(),...safePreviewDraft(result?.decision)};
      this.store.reviewPhase(id,record);error.previewDraft=result?.decision;error.previewPhase=record;if(result?.provider&&result?.model)error.previewRoute={provider:result.provider,model:result.model};throw error;
    }
  }
  async close(){this.closed=true;this.active?.stop.abort(new Error('记忆预演服务已停止'));await this.active?.promise.catch(()=>{});}
}
