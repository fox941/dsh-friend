import {repeatedSocialExperience} from './social-episode-source.js';
import { GrowthStore, evidenceFingerprint } from './growth-store.js';
import { text, noSecret, hash, UUID, aborted } from './validation.js';
import {EmotionController} from './emotion.js';
import {trustedObservationSource} from './activity-source.js';

const KINDS=new Set(['self_description','interest','trait','personal_prompt','emotion']);
const bounded=(value,fallback,min,max,label)=>{
  const result=value??fallback;
  if(!Number.isInteger(result)||result<min||result>max)throw new Error(`${label} 必须是 ${min}–${max} 的整数`);
  return result;
};
export function growthConfig(config={}){
  if(typeof config!=='object'||config===null||Array.isArray(config))throw new Error('growth 配置必须是对象');
  if(config.enabled!==undefined&&typeof config.enabled!=='boolean')throw new Error('growth.enabled 必须是布尔值');
  return {enabled:config.enabled??true,dailyReviewLimit:bounded(config.dailyReviewLimit,50,0,200,'每日审核上限'),reviewTimeoutMs:bounded(config.reviewTimeoutMs,60000,1000,180000,'审核超时'),reviewMaxTokens:bounded(config.reviewMaxTokens,8192,1024,8192,'单次审核输出上限'),emotionTtlMinutes:bounded(config.emotionTtlMinutes,180,5,1440,'情绪有效分钟数')};
}
function keyOf(kind,key){
  if(!KINDS.has(kind))throw new Error('只能提案自我描述、兴趣、特质、个人表达偏好或当下情绪');
  const value=text(key,'状态键',60).normalize('NFKC').trim().toLowerCase();
  if(!/^[\p{L}\p{N}_ -]+$/u.test(value))throw new Error('状态键只能使用文字、数字、空格、下划线和连字符');
  if(['self_description','personal_prompt','emotion'].includes(kind)&&value!=='current')throw new Error('该类型使用 current 作为唯一状态键');
  return `${kind}:${value}`;
}
function validateProposals(rows,source){
  if(!Array.isArray(rows)||rows.length<1||rows.length>3)throw new Error('每次提交 1–3 项成长提案');
  const seen=new Set();
  return rows.map(row=>{
    const key=keyOf(row.kind,row.key),action=row.action??'set';
    if(seen.has(key)||!['set','retract'].includes(action))throw new Error('状态键不能重复，action 只能是 set 或 retract');
    seen.add(key);
    const statement=action==='retract'?'':text(row.statement,'自我状态内容',row.kind==='personal_prompt'?600:400);
    const reason=text(row.reason,'变化理由',600),quote=text(row.evidenceQuote,'本轮依据原话',1500);
    if(!source.content.includes(quote))throw new Error('依据必须逐字引用本轮主用户原话');
    const dependsOn=row.dependsOn??[];
    if(!Array.isArray(dependsOn)||dependsOn.length>6||dependsOn.some(id=>!UUID.test(id)))throw new Error('依赖只能引用最多 6 个已知状态版本 UUID');
    if(row.kind==='personal_prompt'&&action==='set'&&!dependsOn.length)throw new Error('个人表达偏好须引用已有自我认识，不能直接写入预设人设');
    noSecret(JSON.stringify({statement,reason,quote}));
    return {kind:row.kind,key,action,statement,reason,evidenceQuote:quote,dependsOn:[...new Set(dependsOn)]};
  });
}
function validateReview(value,count){
  const rows=value?.decisions;
  if(!Array.isArray(rows)||rows.length!==count)throw new Error('成长审核没有逐项给出决定');
  const seen=new Set();
  for(const row of rows){
    if(!Number.isInteger(row.index)||row.index<0||row.index>=count||seen.has(row.index)||!['accept','reject','defer'].includes(row.verdict)||typeof row.independent!=='boolean'||typeof row.sameClaim!=='boolean'||(row.needsResponse!==undefined&&typeof row.needsResponse!=='boolean'))throw new Error('成长审核决定不符合约定');
    seen.add(row.index);row.reason=text(row.reason,'审核依据',1000);noSecret(row.reason);
  }
  return [...rows].sort((a,b)=>a.index-b.index).map(row=>({index:row.index,verdict:row.verdict,reason:row.reason,independent:row.independent,sameClaim:row.sameClaim,needsResponse:row.needsResponse??false}));
}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))freeze(item);}return value;}
export class GrowthController {
  constructor({journal,serial,writeEnabled=()=>true,config={},now=()=>new Date()}){
    this.config=growthConfig(config);this.store=new GrowthStore(journal,now);this.serial=serial;this.writeEnabled=writeEnabled;this.inflight=new Map();this.stops=new Set();this.closed=false;this.emotions=new EmotionController(this,{journal,now});
  }
  writable(){if(this.closed||!this.config.enabled||!this.writeEnabled())throw new Error('自我成长当前未启用写入，普通聊天仍可继续');}
  read(){const state=this.store.read(),pending=this.pendingReviewKeys?.()??new Set();state.states=state.states.map(row=>({...row,effectiveStatus:pending.has(row.key)?'pending_memory_review':row.effectiveStatus}));state.blank=!state.states.some(row=>this.store.usable(row)&&!pending.has(row.key))&&this.emotions.read().current.length===0;return {...state,enabled:this.config.enabled,writeEnabled:this.config.enabled&&this.writeEnabled(),reviewCallsToday:this.store.budget(),reviewCallsRemaining:Math.max(0,this.config.dailyReviewLimit-this.store.budget()),reviewMaxTokens:this.config.reviewMaxTokens,emotionTtlMinutes:this.config.emotionTtlMinutes};}
  context(budget=6000){
    if(!this.config.enabled)return '';
    const state=this.read(),priority={emotion:0,personal_prompt:1,self_description:2,interest:3,trait:4};
    const affect=this.emotions.context();
    const rows=state.states.filter(row=>this.store.usable(row)&&row.effectiveStatus!=='pending_memory_review'&&(!affect||row.kind!=='emotion')).sort((a,b)=>priority[a.kind]-priority[b.kind]);
    const selected=[];let used=affect?JSON.stringify(affect).length:0;
    for(const row of rows){const brief={id:row.id,kind:row.kind,key:row.key,statement:row.statement,status:row.status,expiresAt:row.expiresAt};const cost=JSON.stringify(brief).length;if(used+cost>budget)continue;selected.push(brief);used+=cost;}
    return JSON.stringify({identityId:state.identityId,revision:state.revision,blank:state.blank&&this.emotions.read().current.length===0,states:selected,...affect?{affect}:{},omitted:rows.length-selected.length,remainingReviewCalls:state.reviewCallsRemaining});
  }
  history(key,limit=10){
    if(key!==undefined&&(typeof key!=='string'||key.length>100))throw new Error('状态键格式不正确');
    return this.store.history(key,bounded(limit,10,1,20,'历史条数'));
  }
  validDependencies(proposal){
    const reachesSelf=(id,seen=new Set())=>{
      if(seen.has(id))return false;seen.add(id);
      const row=this.store.version(id);
      return Boolean(row&&(row.key===proposal.key||row.dependsOn.some(ref=>reachesSelf(ref,seen))));
    };
    return proposal.dependsOn.every(ref=>{
      const row=this.store.version(ref);
      return this.store.usable(row)&&!this.pendingReviewKeys?.().has(row.key)&&this.store.head(row.key)?.id===ref&&!reachesSelf(ref)&&(proposal.kind!=='personal_prompt'||row.kind!=='emotion');
    });
  }
  async propose(args,source,reviewer,signal,options={}){
    this.writable();aborted(signal);
    if((!source?.owner&&!trustedObservationSource(source))||!source.sessionId||!source.messageId||!Number.isInteger(source.seq))throw new Error('成长只能使用主用户原话或已核验的实际观察');
    const content=text(source.content,'本轮主用户消息',12000);noSecret(content);
    const at=new Date(source.occurredAt);if(!Number.isFinite(at.valueOf())||at.valueOf()>this.store.now().valueOf()+60000)throw new Error('成长依据的时间无效');
    const context=source.context??[];
    if(!Array.isArray(context)||context.length>6||JSON.stringify(context).length>7500)throw new Error('本轮上下文超出成长审核预算');
    noSecret(JSON.stringify(context));
    const event={id:hash(`${source.sessionId}:${source.messageId}:${source.seq}`),sessionId:source.sessionId,messageId:source.messageId,seq:source.seq,occurredAt:at.toISOString(),content,fingerprint:trustedObservationSource(source)&&source.origin?.channel==='qq_social_media'?source.origin.evidenceFingerprint:evidenceFingerprint(content),context,...source.origin?{origin:source.origin}:{}};
    if(this.sourceUsable?.(event.id)===false)throw Error('该成长来源已撤回或变化');const proposals=validateProposals(args.proposals,event),base=bounded(args.expectedRevision,undefined,0,Number.MAX_SAFE_INTEGER,'预期自我状态版本');
    const id=hash(JSON.stringify([event.id,base,proposals]));
    if(this.inflight.has(id))return this.inflight.get(id);
    const operation=this.run(id,event,base,proposals,reviewer,signal,options);
    this.inflight.set(id,operation);
    try{return await operation;}finally{this.inflight.delete(id);}
  }
  async run(id,event,base,proposals,reviewer,signal,options={}){
    const started=await this.serial(()=>{this.writable();aborted(signal);return this.store.begin(id,event,base,proposals,this.config.dailyReviewLimit);},signal);
    if(started.existing){
      const receipt=started.existing.receipt;
      const historical=this.store.revision()!==receipt.revision;
      return {...receipt,status:historical?'historical':receipt.status,replayed:true,currentRevision:this.store.revision(),historical,summary:historical?'此提案过去已处理，当前状态已有后续版本，请读取最新状态。':receipt.summary};
    }
    const stop=new AbortController();this.stops.add(stop);
    const combined=AbortSignal.any([stop.signal,AbortSignal.timeout(this.config.reviewTimeoutMs),...(signal?[signal]:[])]);
    let snapshot,reviewRecord;
    try{
      const priorEvidence=this.store.evidence(proposals.map(row=>row.key)).map(row=>({...row,context:undefined,content:row.content.slice(0,1200),truncated:row.content.length>1200}));
      const currentStates=this.store.heads().map(row=>({...row,supports:row.supports.slice(-8),supportingEventCount:row.supports.length,supportSampleTruncated:row.supports.length>8}));
      snapshot=freeze(JSON.parse(JSON.stringify({source:event,baseRevision:base,proposals,currentStates,priorEvidence})));
      if(JSON.stringify(snapshot).length>36000)throw new Error('审核材料超过当次预算，尚未提交变化');
      aborted(combined);
      let abortListener;
      const cancelled=new Promise((_resolve,reject)=>{abortListener=()=>reject(combined.reason);combined.addEventListener('abort',abortListener,{once:true});});
      let reviewed;
      try{reviewed=await Promise.race([reviewer(snapshot,combined),cancelled]);}finally{combined.removeEventListener('abort',abortListener);}
      aborted(combined);noSecret(JSON.stringify(reviewed));
      const decisions=validateReview(reviewed.decision,proposals.length);
      reviewRecord={decision:{decisions},provider:reviewed.provider??null,model:reviewed.model??null,reasoningEffort:reviewed.reasoningEffort??null,usage:reviewed.usage??null};
      return await this.serial(async()=>{
        this.writable();aborted(combined);if(options.guard&&!await options.guard())throw Error('成长提交前原件已失效');if(this.store.revision()===base&&decisions.some(d=>d.verdict==='accept'))await options.beforeCommit?.();if(options.guard&&!await options.guard())throw Error('备份后成长原件已失效');if(this.sourceUsable?.(event.id)===false)throw Error('成长原件已撤回或变化');aborted(combined);
        return this.store.journal.transaction(()=>{
          this.store.recordReview(id,snapshot,reviewRecord,'reviewed');
          if(this.store.revision()!==base){
            const receipt={status:'stale',batchId:id,revision:base,currentRevision:this.store.revision(),changes:[],summary:'审核期间状态发生变化，本提案没有覆盖当前状态。'};
            this.store.finish(id,'stale',reviewRecord,receipt);return receipt;
          }
          const outcomes=[],invalidated=[];let changed=false;
          for(let index=0;index<proposals.length;index++){
            const proposal=proposals[index],decision=decisions[index],prior=this.store.head(proposal.key);
            const outcome={key:proposal.key,verdict:decision.verdict,reason:decision.reason};
            const defer=reason=>{outcome.verdict='defer';outcome.reason=reason;};
            if(decision.verdict==='accept'){
              if(proposal.action==='retract'&&!this.store.usable(prior))defer('没有需要撤回的当前有效状态');
              else if(!this.validDependencies(proposal))defer('依赖已变化、失效、形成循环，或把暂时情绪当作个人表达依据');
              else if(!this.store.usable(prior)&&this.store.heads().filter(row=>this.store.usable(row)).length>=24)defer('当前自我状态达到数量上限，先合并已有认识');
              else {
                let supports=decision.sameClaim&&this.store.usable(prior)?prior.supports.filter(ref=>this.sourceUsable?.(ref)!==false):[];
                const fingerprints=new Set(supports.map(ref=>this.store.event(ref)?.fingerprint).filter(Boolean));
                if(decision.independent&&!fingerprints.has(event.fingerprint)&&!repeatedSocialExperience(event,supports.map(ref=>this.store.event(ref))))supports=[...supports,event.id];
                if(proposal.action==='set'&&!supports.length&&proposal.kind!=='personal_prompt')defer('没有独立经历依据，保留提案而不生成自我状态');
                else if(proposal.action==='set'&&prior?.statement===proposal.statement&&JSON.stringify(supports)===JSON.stringify(prior.supports))defer('重复事件或已有表述不增加成长依据');
                else {
                  const evidence=supports.map(ref=>this.store.event(ref)).filter(Boolean),days=new Set(evidence.map(row=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(row.occurredAt)))),sessions=new Set(evidence.map(row=>row.sessionId));
                  const required=['trait','self_description','personal_prompt'].includes(proposal.kind)?3:2;
                  const dependencies=proposal.dependsOn.map(ref=>this.store.version(ref));
                  const stable=supports.length>=required&&(days.size>=2||sessions.size>=2)&&dependencies.every(row=>row.status==='established');
                  const status=proposal.action==='retract'?'retracted':proposal.kind==='emotion'?'current':stable?'established':'tentative';
                  const expiresAt=proposal.kind==='emotion'&&proposal.action==='set'?new Date(this.store.now().valueOf()+this.config.emotionTtlMinutes*60000).toISOString():null;
                  const next=this.store.put({...proposal,status,supports,reason:decision.reason,batchId:id,expiresAt});
                  outcome.versionId=next.id;outcome.status=status;outcome.statement=next.statement;outcome.supportingEvents=supports.length;changed=true;
                  if(prior&&(!decision.sameClaim||proposal.action==='retract'))invalidated.push(...this.store.invalidate(proposal.key,id));
                }
              }
            }
            this.store.audit(id,proposal.key,outcome.verdict,outcome.reason);outcomes.push(outcome);
          }
          const revision=changed?this.store.advanceRevision():this.store.revision();
          const awaitResponse=!changed&&outcomes.every(row=>row.verdict==='defer')&&decisions.some(row=>row.needsResponse)&&this.store.batch(id).attempts<2;
          const status=changed?'applied':awaitResponse?'awaiting_response':outcomes.some(row=>row.verdict==='defer')?'deferred':'rejected';
          const receipt={status,batchId:id,revision,changes:outcomes,invalidated,summary:changed?'自我状态已按依据更新，暂定认识与稳定认识分别标注。':'提案已留痕，本次没有改变当前自我状态。'};
          if(awaitResponse)receipt.summary='提案尚未提交，等待本轮实际回答后最多复核一次；不需要用户额外确认。';
          this.store.finish(id,status,reviewRecord,receipt);return receipt;
        });
      },combined);
    }catch(error){
      const cancelled=Boolean(signal?.aborted||stop.signal.aborted);
      let detail=String(error?.message??'未知原因').slice(0,400);try{noSecret(detail);}catch{detail='错误详情含凭据特征，已隐藏';}
      const recordedRequest=snapshot&&JSON.stringify(snapshot).length<=36000?snapshot:{sourceId:event.id,baseRevision:base,omitted:'审核材料超出预算，原始依据仍保存在事件表'};
      await this.serial(()=>{this.store.recordReview(id,recordedRequest,reviewRecord,cancelled?'cancelled':'failed');this.store.fail(id,cancelled?'cancelled':'failed',cancelled?'审核已取消，未提交自我状态；可明确重试':`成长审核未完成，未提交自我状态：${detail}`);}).catch(()=>{});
      throw new Error(cancelled?'成长审核已取消，没有提交自我状态':`成长审核未完成，没有提交自我状态：${detail}`);
    }finally{this.stops.delete(stop);}
  }
  async afterResponse(source,reviewer,signal){
    if(this.closed||!this.config.enabled||signal?.aborted)return [];
    const sourceId=hash(`${source.sessionId}:${source.messageId}:${source.seq}`),results=[];
    for(const batch of this.store.awaiting(sourceId)){
      if(batch.base_revision!==this.store.revision())continue;
      const proposals=batch.proposals.map(row=>({...row,key:row.key.slice(row.kind.length+1)}));
      try{results.push(await this.propose({expectedRevision:batch.base_revision,proposals},source,reviewer,signal));}
      catch{results.push({status:'failed',summary:'回答后的成长复核未完成，原有聊天和自我状态保留。'});}
    }
    return results;
  }
  async close(){this.closed=true;for(const stop of this.stops)stop.abort();await Promise.allSettled([...this.inflight.values(),this.emotions.inflight].filter(Boolean));}
}

export {validateProposals as validateGrowthProposals};
