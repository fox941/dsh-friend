import {randomUUID} from 'node:crypto';
import {text,noSecret,aborted} from './validation.js';
export function recallRequest(args){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['query','alternateQuery','complexReason'].includes(k)))throw Error('回忆只接受检索词、可选的第二种表达及复杂任务理由');
 const query=text(args.query,'回忆检索词',300),alternateQuery=args.alternateQuery===undefined?null:text(args.alternateQuery,'第二种检索表达',300),complexReason=args.complexReason===undefined?null:text(args.complexReason,'复杂回忆理由',300);noSecret(JSON.stringify([query,alternateQuery,complexReason]));
 if(complexReason!==null&&complexReason.length<8)throw Error('复杂回忆需说明至少8字的比较、重建或多事件任务理由');
 const normalize=s=>s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu,'');
 return {queries:alternateQuery&&normalize(query)!==normalize(alternateQuery)?[query,alternateQuery]:[query],...complexReason?{complexReason}:{}};
}
export async function dispatchRecall(ctx,exec,query,complexReason,mode='smart'){
 if(!['smart','keyword'].includes(mode))throw Error('回忆只支持既有smart或keyword检索模式');
 aborted(exec.signal);
 if(!exec.token||typeof ctx.tools.execute!=='function'||!ctx.tools.get?.('mnemon_recall',exec.agent))return {results:[],unavailable:true,reason:'当前会话没有可调用的Mnemon召回；未直接读取其他存储域'};
 let result;try{result=await ctx.tools.execute({callId:randomUUID(),rootCallId:exec.rootCallId??exec.callId,parent:exec.token,name:'mnemon_recall',arguments:{query,mode,limit:6,...complexReason?{intent:'complex:'+complexReason}:{}},agent:exec.agent,signal:exec.signal});}catch(error){aborted(exec.signal);return {results:[],unavailable:true,reason:'原召回工具未完成，不能据此断定没有记忆'};}
 for(const context of result.additionalContexts??[])exec.deferContext?.(context);
 if(!result.isError&&result.concludesTurn)exec.concludeTurn?.();aborted(exec.signal);
 if(result.isError||!Array.isArray(result.value?.results))return {results:[],unavailable:true,terminal:result.concludesTurn===true,reason:'原召回工具未返回可核对的结果'};
 return {...result.value,terminal:result.concludesTurn===true};
}
const role=content=>/^【历史画像原件[：:]/u.test(content.trimStart())?'history_marked':/^外部阅读经历（不是用户资料）/u.test(content.trimStart())?'external_observation':/^主用户画像更正原件/u.test(content.trimStart())?'correction_source':'unclassified';
/** Combines only evidence admitted by the current View. No model, DB or new read authority. */
export async function recallEvidence(args,read,signal){
 const {queries,complexReason}=recallRequest(args),results=[],calls=[],conflicts=[],seen=new Set();let chars=0,limited=false,unavailable=false;
 for(const [index,query]of queries.entries()){
  const mode=index===0?'smart':'keyword';
  aborted(signal);const response=await read(query,complexReason,mode);aborted(signal);
  if(!response||!Array.isArray(response.results))throw Error('回忆响应格式无效');
  const call={query,mode,notRun:response.notRun===true,budgetExhausted:response.budgetExhausted===true,unavailable:Boolean(response.unavailable),truncated:response.memoryEvidence?.truncated===true,admitted:0,...response.memoryEvidence?{memoryEvidence:structuredClone(response.memoryEvidence)}:{}};
  calls.push(call);unavailable||=call.unavailable;limited||=call.truncated||call.notRun||call.budgetExhausted;
  // A no-run response must never smuggle results from another turn or Source.
  if(call.notRun||call.unavailable)break;
  for(const memory of response.results){
   if(typeof memory?.id!=='string'||!memory.id||memory.id.length>1000||typeof memory.content!=='string'||!memory.content.trim()) {limited=true;continue;}
   try{noSecret(JSON.stringify(memory));}catch{limited=true;continue;}
   const sourceKey=response.memoryEvidence?.sourceInstanceKey??null,key=JSON.stringify([sourceKey,memory.memoryBodyId??null,memory.id]);if(seen.has(key)){
    const index=results.findIndex(r=>r.id===memory.id&&(r.memoryBodyId??null)===(memory.memoryBodyId??null)&&(r.sourceInstanceKey??null)===sourceKey);
    if(index>=0&&results[index].content!==memory.content){chars-=results[index].content.length;results.splice(index,1);conflicts.push({id:memory.id,memoryBodyId:memory.memoryBodyId??null,sourceInstanceKey:sourceKey});limited=true;}
    continue;
   }
   if(results.length>=12||memory.content.length>2000||chars+memory.content.length>12000){limited=true;continue;}
   const evidenceRole=role(memory.content);seen.add(key);chars+=memory.content.length;call.admitted++;
   results.push({...structuredClone(memory),evidenceRole,semanticMatch:'not_verified',...evidenceRole==='history_marked'?{currentUse:'historical_only'}:{},retrievalQuery:query,...response.memoryEvidence?.sourceInstanceKey?{sourceInstanceKey:response.memoryEvidence.sourceInstanceKey}:{}});
  }
  if(response.terminal)break;
 }
 return {status:results.length?'candidates':conflicts.length?'source_changed':unavailable?'unavailable':'no_evidence_admitted',results,retrieval:{calls,conflicts,limited,unavailable,characters:chars,completeSearch:false,...complexReason?{complexReason}:{}},hint:'这是当前会话获准读取的检索候选，排名不证明与问题匹配。逐项核对正文能否回答原问题；外部视频观察不自动成为用户偏好，history_marked只作历史，correction_source还需核对当前画像及应用回执。同一引用两次正文不同则从本次候选移除并记录conflicts，需重新核对现行状态。不能从近期排序猜答案；无直接依据时说明未知。未命中、未执行、额度用完或来源不可用都不证明记忆库没有相关内容。第二种表达由本轮模型提供，继续与直接mnemon_recall共用额度。'};
}
