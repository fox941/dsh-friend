import {createHash,randomUUID} from 'node:crypto';
import {ownerMessage} from './evidence.js';
import {ownerIdentity} from './source-identity.js';

export const REPLY_REPAIR_SOURCE='ai-friend:reply-integrity';
const words=blocks=>(blocks??[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n');
const digest=s=>createHash('sha256').update(s).digest('hex');
const parse=s=>{try{return JSON.parse(s);}catch{return null;}};
const contextOK=v=>v?.scope==='current_user_turn'&&v.includesPreviousTurns===false&&typeof v.turnId==='string';
const ref=r=>JSON.stringify([r.sourceInstanceKey,r.memoryBodyId??null,r.id]);
// These are deliberately bounded language cues, not a semantic truth detector.
// Quoted admissions, negative statements and explicitly historical reports do
// not become new assertions merely because they contain a success phrase.
const visible=s=>s.replace(/```[^]*?```/g,'').replace(/^\s*>[^\n]*/gm,'');
const unquote=s=>s.replace(/[“‘「『"]([^]*?)[”’」』"]/g,'〔引文〕');
const negative=s=>/(?:没有|并未|尚未|未曾|还没|没(?:有)?|不能|不(?:曾|算|能|是|代表)?|勿|不要|别)[^。；！？\n]{0,16}$/.test(s);
const historical=s=>/(?:上轮|上一轮|上次|当时|曾经|之前(?:说|写|称)|上一条(?:说|写))/.test(s)&&!/(?:本轮|这轮|这次|现在|重新|仍|还在)/.test(s);
const quoteCue=/(?:逐字|引文|引用|原文|原话|字幕)[^。；！？\n]{0,26}?(?:核对|核验|校验|验证)[^。；！？\n]{0,8}?(?:通过|成功|一致|吻合)|(?:核对|核验|校验|验证)[^。；！？\n]{0,14}?(?:引文|引用|原文|原话|字幕)[^。；！？\n]{0,8}?(?:通过|成功|一致|吻合)/g;
const idCue=/\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?(?:…|\.\.\.)?/gi;
const taskCue=/(?:任务|请求|排队|队列|queued|request)/i;
const taskStates=[['queued',/(?:仍|还|已|已经|正在|也)?(?:在)?(?:队列里|队列中|排队|排着|待执行|等待执行)|\bqueued\b/i],['running',/(?:正在|仍在|还在)(?:执行|运行|观看|读取)|\brunning\b/i],['completed',/(?:已经|已)(?:完成|结束)|\bcompleted\b/i],['cancelled',/(?:已经|已)(?:取消|撤销)|\bcancelled\b/i],['failed',/(?:已经|已)?失败|\bfailed\b/i]];

/** Reconstruct only paired, successful local tool events before this draft.
 * User/tool text mentioning a tool name cannot manufacture a receipt. The
 * returned check is also bound back to a current-turn observed token and body.
 * This survives a restart without promoting an old assistant summary to proof.
 */
export function turnProof(session,row,finalSeq){
 if(!Number.isSafeInteger(row.event_seq)||!Number.isSafeInteger(finalSeq)||finalSeq<=row.event_seq||finalSeq-row.event_seq>1500)throw Error('回复来源超出可核验回合范围');
 const input=session.eventAt(row.event_seq);
 if(input?.type!=='user/message'||input.data.id!==row.message_id||words(input.data.content)!==row.body)throw Error('回复原消息与收件记录不一致');
 const calls=new Map(),tokens=new Map(),keys=new Map(),conflicts=new Set(),checks=[];let repairs=0,latestCheck=null;
 for(let seq=row.event_seq+1;seq<finalSeq;seq++){
  const e=session.eventAt(seq);if(!e)throw Error('回复回合事件缺失');
  if(e.type==='turn/start'||e.type==='turn/end')throw Error('回复依据跨越用户回合');
  if(e.type==='user/message'){
   if(e.data.source?.kind===REPLY_REPAIR_SOURCE&&e.data.source.inboxId===row.id)repairs++;
   else if(e.data.source?.kind==='user')throw Error('回复回合混入另一条直接消息');
  }
  if(e.type==='tool/call'&&['friend_memory_recall','friend_memory_evidence_check'].includes(e.data.name)){
   if(calls.has(e.data.callId))throw Error('核验工具调用编号重复');
   calls.set(e.data.callId,{name:e.data.name,args:parse(e.data.arguments),resolved:false});
  }
  if(e.type!=='tool/result')continue;
  const message=e.data?.message,c=calls.get(message?.toolCallId??message?.callId);if(!c)continue;
  if(c.resolved)throw Error('核验工具结果重复');c.resolved=true;
  const r=message.isError?null:parse(words(message.content));if(!r)continue;
  if(c.name==='friend_memory_recall'&&contextOK(r.evidenceContext)){
   if(r.retrieval?.sourceConflicts>0){for(const t of tokens.values())conflicts.add(t.key);tokens.clear();}
   for(const item of r.results??[]){
    if(!item.evidenceToken||typeof item.content!=='string')continue;
    const key=ref(item),old=keys.get(key);if(old&&old.content!==item.content){conflicts.add(key);tokens.delete(old.token);}
    if(conflicts.has(key))continue;
    const read=r.retrieval?.calls?.find(c=>!c.notRun&&!c.unavailable&&c.query===item.retrievalQuery&&c.memoryEvidence?.sourceInstanceKey===item.sourceInstanceKey)?.memoryEvidence;
    if(!read?.id||!read.viewId)continue;
    keys.set(key,{content:item.content,token:item.evidenceToken});tokens.set(item.evidenceToken,{...item,key,turnId:r.evidenceContext.turnId,readId:read.id,viewId:read.viewId});
   }
  }
  if(c.name==='friend_memory_evidence_check'){
   const current=[];
   for(const [i,check]of (r.checks??[]).entries()){
    const claim=c.args?.claims?.[i],entry=tokens.get(claim?.evidenceToken);
    const valid=contextOK(r.evidenceContext)&&entry&&entry.turnId===r.evidenceContext.turnId&&check.id===entry.id&&check.memoryBodyId===entry.memoryBodyId&&check.sourceInstanceKey===entry.sourceInstanceKey&&check.readId===entry.readId&&check.viewId===entry.viewId&&check.contentHash===digest(entry.content)&&check.checkedQuote===claim.quote&&entry.content.includes(claim.quote)&&check.status==='quote_verified'&&check.quoteVerified===true&&check.verificationScope==='literal_quote_only'&&check.sourceStatus==='observed_not_reread'&&check.currentStateVerified===false;
    current.push({valid:Boolean(valid),token:claim?.evidenceToken,quote:check.checkedQuote??null,id:check.id??null,seq,status:check.status??'unavailable'});
   }
   latestCheck={seq,checks:current,complete:current.length>0&&current.length===c.args?.claims?.length};checks.push(...current);
  }
 }
 const alive=c=>c.valid&&tokens.has(c.token)&&!conflicts.has(tokens.get(c.token).key);
 return {repairs,latestCheck:latestCheck?{...latestCheck,checks:latestCheck.checks.map(c=>({...c,valid:alive(c)}))}:null,verified:checks.filter(alive).slice(-12).map(({id,quote,seq})=>({id,quote,seq}))};
}

export function inspectReply(body,{proof,readTask}){
 const issues=[],facts=[],plain=visible(body);
 for(const original of plain.split(/[。；！？\n]+/)){
  const line=unquote(original);if(historical(line))continue;
  for(const match of line.matchAll(quoteCue)){
   const prefix=line.slice(0,match.index),assertion=line.slice(0,match.index+match[0].length);if(negative(prefix)||/(?:没有|没|未|不)[^。；！？]{0,12}(?:核对|核验|通过)/.test(match[0])||historical(assertion)||/(?:如果|假如|若是|只要|等到)[^。；！？]{0,25}$/.test(prefix))continue;
   const latest=proof.latestCheck,pass=latest?.checks.filter(c=>c.valid)??[];
   const quotations=[...original.matchAll(/[“‘「『"]([^“”‘’「」『』"\n]{2,1000})[”’」』"]/g)].map(m=>m[1]).filter(q=>!/(?:核对|核验).*(?:通过|成功)/.test(q));
   const explicitOne=/(?:只有|仅有|仅|第一|一条|1条|一处|1处)/.test(assertion)&&!/(?:全部|全都|都|均|两条|三条|二条|[2-9]条)/.test(assertion);
   const count=assertion.match(/([一二两三四1234])\s*(?:条|处|段|句|个)[^。；！？]{0,16}(?:全部|都|均|核对|核验)/),number=count?({'一':1,'二':2,'两':2,'三':3,'四':4}[count[1]]??Number(count[1])):null;
   const scoped=quotations.length>0&&quotations.every(q=>proof.verified.some(c=>c.quote===q));
   const ok=Boolean(latest?.complete&&pass.length&&(!number||number===(quotations.length||pass.length))&&(quotations.length?scoped:explicitOne?pass.length===1:pass.length===latest.checks.length));
   if(!ok)issues.push({kind:'quote_verification_unsupported',claim:match[0],reason:'本轮逐字核对回执不支持这项通过声明；召回、旧回答和部分通过不能替整段背书'});
  }
  const matches=[...line.matchAll(idCue)];if(!taskCue.test(line)||!matches.length)continue;
  for(let i=0;i<matches.length;i++){
   const id=matches[i][0].replace(/…|\.\.\./g,''),span=line.slice(matches[i].index,matches[i+1]?.index??line.length),before=line.slice(0,matches[i].index);
   const fragment=span.slice(id.length),state=taskStates.find(([,re])=>re.test(fragment))??(i===0?taskStates.find(([,re])=>re.test(before)):null);
   if(!state)continue;const m=state[1].exec(fragment)||state[1].exec(before);if(m&&negative((state[1].test(fragment)?fragment:before).slice(0,m.index)))continue;
   const actual=readTask(id);facts.push(actual);
   if(!actual?.found||actual.status!==state[0]||['queued','running'].includes(state[0])&&actual.resultStatus&&['rested','cancelled','failed','completed'].includes(actual.resultStatus))issues.push({kind:'task_status_mismatch',id,claimed:state[0],actual,reason:'历史排队回执不是当前任务状态'});
  }
 }
 return {ok:issues.length===0,issues:issues.slice(0,8),facts,proof:{latestCheck:proof.latestCheck,verified:proof.verified},repairs:proof.repairs};
}

/** Read through the existing trusted ledger, never through model-supplied JSON. */
export function taskFact(adapter,sessionId,prefix){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/i.test(prefix))return {found:false,id:prefix};
 const requests=adapter.activityRequests;if(!requests)return {found:false,id:prefix};
 const ids=requests.db.prepare("SELECT id FROM activity_requests WHERE id LIKE ? AND json_extract(source_json,'$.sessionId')=? LIMIT 3").all(prefix+'%',sessionId);
 if(ids.length!==1)return {found:false,id:prefix,reason:ids.length?'ambiguous':'not_found_in_this_session'};
 const r=requests.get(ids[0].id);if(!requests.valid(r))return {found:false,id:prefix,reason:'source_unavailable'};
 return {found:true,id:r.id,status:r.status,resultStatus:r.result?.status??null,activityId:r.run_id??null,updatedAt:r.updated_at};
}
export function verifyReply(adapter,{session,row,body,finalSeq}){
 const input=session.eventAt(row.event_seq),identity=ownerIdentity(input,session.header);
 if(identity?.channel!=='qq'||identity.qq?.inboxId!==row.id||identity.qq?.bindingId!==row.binding_id)throw Error('回复核实无法确认原QQ绑定');
 const final=session.eventAt(finalSeq);if(final?.type!=='assistant/message'||final.data.interrupted||words(final.data.message.content)!==body)throw Error('待发正文与原始最终草稿不一致');
 const proof=turnProof(session,row,finalSeq);
 return inspectReply(body,{proof,readTask:id=>taskFact(adapter,session.header.id,id)});
}
export function attachReplyIntegrity(ctx,adapter){
 if(!adapter.qq)return;
 const repairReads=new Set(['friend_activity_read','friend_activity_status','friend_memory_recall','friend_memory_evidence_check','mnemon_recall','friend_qq_reply_plan']);
 ctx.tools.guard?.(exec=>{
  let input,origin;try{input=ownerMessage(exec.agent);origin=ownerIdentity(input,exec.agent.session.header);}catch{return;}
  if(origin?.channel!=='qq')return;
  for(let seq=exec.agent.session.seq-1;seq>input.seq;seq--){const e=exec.agent.session.eventAt(seq);if(e?.type==='user/message'&&e.data.source?.kind===REPLY_REPAIR_SOURCE&&e.data.source.inboxId===origin.qq.inboxId&&!repairReads.has(exec.name))return '本轮正在修正尚未发送的回复，只能按原权限只读核对或调整回应意图，不能重复执行写入、排队或平台动作。';}
 });
 ctx.systemPrompt.section({name:'ai-friend:reply-integrity',order:10318,interpolate:false,text:'QQ回复前宿主会核对明确的后台阅读请求状态和逐字引用核验声明。后台旧queued回执不是当前状态；需要时用friend_activity_read按requestId读回。只有本轮实际friend_memory_evidence_check对应的逐字引文才能说核对通过，部分通过按条说明，不认证语义、科学事实或重新读过来源。宿主纠正上下文只含运行事实，不是主用户新原话，也不授权新写入、重复观看或改变人格。保持原有是否回应、何时回应及自然表达的选择。'});
 ctx.on('agent/turn-stopping',({agent,signal})=>{
  signal.throwIfAborted();let input,origin;try{input=ownerMessage(agent);origin=ownerIdentity(input,agent.session.header);}catch{return;}
  if(origin?.channel!=='qq')return;
  const row=adapter.qq.store.get(origin.qq.inboxId);if(!row||adapter.qq.replies.plan(row.id)?.action==='silent')return;
  let final;for(let seq=agent.session.seq-1;seq>row.event_seq;seq--){const e=agent.session.eventAt(seq);if(e?.type==='assistant/message'&&!e.data.interrupted&&words(e.data.message.content).trim()){final=e;break;}}
  if(!final)return;
  const result=verifyReply(adapter,{session:agent.session,row,body:words(final.data.message.content),finalSeq:final.seq});
  if(result.ok||result.repairs>=1)return;
  agent.steer({id:randomUUID(),role:'user',source:{kind:REPLY_REPAIR_SOURCE,inboxId:row.id},content:[{type:'text',text:'宿主回复事实核实：刚才的QQ草稿尚未发送。请按以下只读回执修正不符的声明，保持自己的语气和原回应意图。只补充必要的只读核对或改述，不重复排队/观看/写记忆。本轮最多一次宿主修正；仍无依据时如实说明。核验仅为候选内逐字匹配，不证明视频/事实已重读或科学结论为真。\n'+JSON.stringify(result)}]});
 });
}
