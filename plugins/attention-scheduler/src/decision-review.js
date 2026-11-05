import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');

export function sumUsage(values){
 const merge=(a,b)=>{if(typeof b==='number'&&Number.isFinite(b))return (typeof a==='number'?a:0)+b;if(b&&typeof b==='object'&&!Array.isArray(b)){const out=a&&typeof a==='object'?{...a}:{};for(const [k,v]of Object.entries(b)){const next=merge(out[k],v);if(next!==undefined)out[k]=next;}return out;}return a;};
 return values.filter(Boolean).reduce((all,value)=>merge(all,value),undefined)??null;
}

async function stillFresh(controller,meta,state,signal){
 if(controller.closed)return false;signal.throwIfAborted();
 if(controller.store.meta().epoch!==meta.epoch)return false;
 const fresh=!controller.host.fresh||await controller.host.fresh(state);if(controller.closed)return false;signal.throwIfAborted();
 return fresh&&controller.store.meta().epoch===meta.epoch;
}

/** The sole correction boundary. Two attempts maximum under the original abort/deadline. */
export async function reviewDecision(controller,{call,frame,state,meta,signal}){
 const usages=[];let previous=null,problem=null,truncated=false;
 for(const phase of ['initial','repair']){
  if(phase==='repair'&&!await stillFresh(controller,meta,state,signal)){
   if(controller.closed)return {stale:true};
   controller.store.finish(call,'stale',{decision:null,usage:sumUsage(usages)},'纠正前原事件或状态变化，未使用旧上下文继续');return {stale:true};
  }
  signal.throwIfAborted();if(controller.closed)return {stale:true};controller.store.beginAttempt(call,phase);
  let answer=null;
  try{
   answer=await (phase==='initial'?controller.host.review(frame,signal):controller.host.repair({frame,previous,problem,truncated},signal));
   if(controller.closed)return {stale:true};signal.throwIfAborted();usages.push(answer.usage);
   const raw=JSON.stringify(answer.decision);controller.validateData(raw);
   const decision=controller.validateDecision(answer.decision,frame.candidates.map(row=>row.id),controller.now().valueOf(),frame.candidates);
   controller.store.finishAttempt(call,phase,'completed',{usage:answer.usage,outputHash:hash(raw)});
   return {answer:{...answer,usage:sumUsage(usages)},decision};
  }catch(failure){
   const error=failure instanceof Error?failure:new Error(String(failure));
   if(controller.closed)return {stale:true};
   if(!answer)usages.push(error.usage);
   let repairable=error.repairable===true&&!signal.aborted;
   let raw=answer?JSON.stringify(answer.decision):error.rawOutput??null;
   if(raw!==null)try{controller.validateData(raw);}catch{raw=null;repairable=false;}
   const issue=controller.safe(error),issues=Array.isArray(error.issues)?error.issues.slice(0,16):[];
   controller.store.finishAttempt(call,phase,signal.aborted?'interrupted':repairable?'invalid':'failed',{error:issue,usage:answer?.usage??error.usage,outputHash:typeof raw==='string'?hash(raw):null});
   if(phase==='initial'&&repairable&&controller.host.repair){
    previous=typeof raw==='string'?raw.slice(0,8000):null;truncated=typeof raw==='string'&&raw.length>8000;
    problem={code:error.code??'INVALID_DECISION',message:issue,issues};controller.validateData(JSON.stringify(problem));continue;
   }
   error.reviewUsage=sumUsage(usages);throw error;
  }
 }
 throw new Error('调度纠正次数已用完');
}
