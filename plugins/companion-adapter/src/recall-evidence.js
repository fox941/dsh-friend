import {createHash,randomUUID} from 'node:crypto';
import {ownerMessage} from './evidence.js';
import {QQ_SOURCE} from './source-identity.js';
import {text,noSecret} from './validation.js';

const keyOf=r=>JSON.stringify([r.sourceInstanceKey??null,r.memoryBodyId??null,r.id]);
const hash=s=>createHash('sha256').update(s).digest('hex');
const contextOf=state=>({turnId:state.turnId,scope:'current_user_turn',includesPreviousTurns:false});

// Weak agent identity plus actual session and current user-event position. No disk,
// account-string cache or model-supplied turn id can carry proof into another turn.
export function recallTurn(agent){
 ownerMessage(agent);const session=agent.session;
 for(let seq=session.seq-1;seq>=Math.max(0,session.seq-500);seq--){
  const event=session.eventAt(seq);
  if(event?.type==='turn/start')break;
  if(event?.type==='user/message'&&['user',QQ_SOURCE].includes(event.data.source?.kind))return {session,seq,messageId:event.data.id??null};
 }
 throw Error('无法核验本轮原话的位置，不签发回忆引用');
}
const same=(a,b)=>a?.session===b?.session&&a?.seq===b?.seq&&a?.messageId===b?.messageId;

export class RecallEvidenceLedger{
 #agents=new WeakMap();
 begin(agent){
  const identity=recallTurn(agent);let state=this.#agents.get(agent);
  if(!same(state?.identity,identity)){state={identity,turnId:randomUUID(),entries:new Map(),tokens:new Map(),conflicts:new Set(),characters:0};this.#agents.set(agent,state);}
  return state;
 }
 admit(agent,started,result){
  const state=this.begin(agent);
  if(state!==started)throw Error('用户回合已变化，丢弃迟到的回忆结果');
  for(const ref of result.retrieval.conflicts??[])this.#invalidate(state,keyOf(ref));
  // Invalidate first, including changes discovered by a later wrapper call.
  for(const row of result.results){const key=keyOf(row),old=state.entries.get(key);if(old&&old.content!==row.content)this.#invalidate(state,key);}
  const rows=[];
  for(const row of result.results){
   const key=keyOf(row);if(state.conflicts.has(key))continue;
   const call=result.retrieval.calls.find(c=>c.memoryEvidence?.sourceInstanceKey===row.sourceInstanceKey&&c.query===row.retrievalQuery&&!c.notRun&&!c.unavailable);
   const proof=call?.memoryEvidence;
   // A candidate lacking a genuine Source/View/read identity stays visible but
   // cannot acquire a checkable citation. The model cannot supply this metadata.
   if(!proof?.id||!proof.viewId||!proof.sourceInstanceKey){rows.push(row);continue;}
   let entry=state.entries.get(key);
   if(!entry){
    if(state.entries.size>=12||state.characters+row.content.length>12000){rows.push(row);continue;}
    entry={...structuredClone(row),token:randomUUID(),contentHash:hash(row.content),viewId:proof.viewId,readId:proof.id,observedAt:proof.observedAt??null};
    state.entries.set(key,entry);state.tokens.set(entry.token,entry);state.characters+=row.content.length;
   }else if(entry.viewId!==proof.viewId){this.#invalidate(state,key);continue;}
   rows.push({...row,evidenceToken:entry.token});
  }
  return {...result,evidenceContext:contextOf(state),results:rows,retrieval:{...result.retrieval,characters:rows.reduce((n,r)=>n+r.content.length,0),sourceConflicts:state.conflicts.size},hint:result.hint+' evidenceContext.turnId标记当前用户回合；本次results不包含上轮结果。需要引用核对时，使用本轮evidenceToken与逐字原文调用friend_memory_evidence_check；它只核对已观察引用，不重新读取数据库，也不判断语义必然成立。'};
 }
 #invalidate(state,key){const old=state.entries.get(key);if(old){state.tokens.delete(old.token);state.entries.delete(key);state.characters-=old.content.length;}state.conflicts.add(key);}
 check(agent,args){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['claims'].includes(k))||!Array.isArray(args.claims)||args.claims.length<1||args.claims.length>4)throw Error('一次核对1至4条引用');
  const claims=args.claims.map(c=>{
   if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['evidenceToken','quote','use'].includes(k))||!['historical','current_user_fact','external_event','record'].includes(c.use))throw Error('引用必须包含本轮凭证、逐字原文和使用方式');
   const r={evidenceToken:text(c.evidenceToken,'引用凭证',100),quote:text(c.quote,'引用原文',1000),use:c.use};noSecret(JSON.stringify(r));return r;
  });
  const state=this.begin(agent),checks=claims.map(c=>{
   const entry=state.tokens.get(c.evidenceToken);
   if(!entry)return {status:'not_observed',quoteVerified:false,currentStateVerified:false};
   const base={id:entry.id,memoryBodyId:entry.memoryBodyId??null,sourceInstanceKey:entry.sourceInstanceKey,viewId:entry.viewId,readId:entry.readId,contentHash:entry.contentHash,evidenceRole:entry.evidenceRole,sourceStatus:'observed_not_reread',supportScope:'this_source_only',verificationScope:'literal_quote_only',checkedQuote:c.quote,semanticMatch:'model_must_assess',currentStateVerified:false};
   if(!entry.content.includes(c.quote))return {...base,status:'quote_mismatch',quoteVerified:false};
   const blocked=c.use==='current_user_fact'&&['history_marked','external_observation','correction_source'].includes(entry.evidenceRole);
   return {...base,status:blocked?'use_blocked':'quote_verified',quoteVerified:true,requestedUse:c.use,...c.use==='current_user_fact'?{currentUse:'requires_current_profile_or_applied_receipt'}:{}};
  });
  return {status:checks.every(c=>c.status==='quote_verified')?'quotes_verified':'needs_review',evidenceContext:contextOf(state),checks,hint:'每条核对只对应该条id与checkedQuote，不替该原件的其他细节或其他记录背书。逐项判断共同部分，旧assistant摘要不能作为原文；旧摘要说“两份都”而某份正文未提，就更正概括。核对成功只表示引用逐字存在于本轮获准观察的候选；不证明它能回答问题、仍是现行事实或已重新读回。说“两份都记载某细节”前，分别确认两份正文支持该细节；只有一份提到就单独归属，另一份未提不代表事情未发生。结合完整上下文判断否定、条件、人物和时间。历史、外部观察及更正提案不能直接充当当前用户画像；现行事实需当前画像或已应用回执。无依据时说明暂时没找到。'};
 }
}
