import {inspectReply,turnProof,taskFact} from './reply-integrity.js';
import {ownerMessage} from './evidence.js';
import {ownerIdentity} from './source-identity.js';
import {hash} from './validation.js';
import {socialScope,socialOriginal} from '@ai-friend/qq-bridge/social-memory-store';

const empty=()=>({repairs:0,latestCheck:null,verified:[]});
const words=blocks=>(blocks??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const quoteList=s=>[...s.matchAll(/[“‘「『"]([^“”‘’「」『』"\n]{2,1000})[”’」』"]/g)].map(m=>m[1]).filter(q=>!/(?:核对|核验).*(?:通过|成功)/.test(q)).slice(0,4);
const blocked=()=>Object.assign(Error('QQ回复事实依据不足或已变化，原草稿保留，未发送'),{code:'QQ_REPLY_INTEGRITY_BLOCKED',replyIntegrityBlocked:true});
const key=id=>'qq-reply-check:'+id;
const sourceStamp=e=>({id:e.id,account:e.account,thread:e.thread_key,sender:e.sender,hash:e.raw_hash,kind:e.kind,visibility:e.raw?.postVisibility??null});
const sameSource=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Ports supply already scoped reads. This controller never opens owner Native
 * memory or private background tasks for a social callback. Durable metadata
 * goes into the existing platform_meta table, not a second memory system. */
export class QQReplyIntegrity{
 constructor(adapter){this.a=adapter;this.db=adapter.journal.db;}
 read(id){const r=this.db.prepare('SELECT value FROM platform_meta WHERE key=?').get(key(id));return r?JSON.parse(r.value):null;}
 save(id,value){const r={...value,at:new Date().toISOString()};this.db.prepare('INSERT INTO platform_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(id),JSON.stringify(r));return r;}
 event(id){return this.a.platforms.store.event(id);}
 note(id){try{return this.a.platforms.socialMemory?.store.note(id);}catch{return null;}}
 sources(event,items=[]){
  const memory=this.a.platforms.socialMemory,scope=socialScope(event),out=[];
  for(const item of items.slice(0,12)){
   const n=this.note(item.id),source=n?this.event(n.event_id):null;
   if(!n||n.status!=='active'||n.account!==event.account||n.thread_key!==scope.thread||n.subject!==source?.sender||event.kind!=='group'&&n.subject!==event.sender||n.content_hash!==item.expectedHash||n.content!==item.content||n.evidence!==item.evidenceQuote||n.event_id!==item.sourceEvent||!memory.live(source,{processed:true})||memory.profileCurrent(n,event)===false||!socialOriginal(source).includes(n.evidence))continue;
   out.push({id:n.id,expectedHash:n.content_hash,sourceEventId:source.id,sourceHash:source.raw_hash,scope:n.thread_key,subject:n.subject});
  }
  return out;
 }
 currentTexts(event,refs){
  const memory=this.a.platforms.socialMemory,scope=socialScope(event),texts=[];
  for(const ref of refs??[]){
   const n=this.note(ref.id),source=n?this.event(n.event_id):null;
   if(!n||n.status!=='active'||n.content_hash!==ref.expectedHash||hash(n.content)!==ref.expectedHash||n.account!==event.account||n.thread_key!==scope.thread||n.thread_key!==ref.scope||n.subject!==ref.subject||n.subject!==source?.sender||event.kind!=='group'&&n.subject!==event.sender||source?.id!==ref.sourceEventId||source.raw_hash!==ref.sourceHash||!memory.live(source,{processed:true})||memory.profileCurrent(n,event)===false||!socialOriginal(source).includes(n.evidence))continue;
   // These are stored records/currently allowed source words, not proof that a
   // recalled event is objectively true or that an online page was reread.
   texts.push({id:n.id,text:n.content},{id:n.id,text:n.evidence});
  }
  return texts;
 }
 checkBody(body,texts=[]){
  const quotes=quoteList(body),checks=quotes.map(quote=>({quote,id:texts.find(s=>s.text.includes(quote))?.id??null}));
  const proof=empty();if(quotes.length){proof.latestCheck={complete:true,checks:checks.map(c=>({valid:Boolean(c.id),quote:c.quote,id:c.id,status:c.id?'quote_verified':'not_observed'}))};proof.verified=checks.filter(c=>c.id).map(c=>({id:c.id,quote:c.quote}));}
  const r=inspectReply(body,{proof,readTask:id=>({found:false,id,reason:'not_observed_in_this_social_scope'})});
  const assertion=body.replace(/```[^]*?```/g,'').replace(/^\s*>[^\n]*/gm,'').replace(/[“‘「『"]([^]*?)[”’」』"]/g,'〔引文〕');
  const claims=assertion.match(/(?:已|已经|刚|本轮|实际)[^。；！？\n]{0,12}(?:调用|执行|运行|使用|用)[^。；！？\n]{0,30}friend_memory_(?:recall|evidence_check)/g)??[];
  if(claims.some(c=>!/(?:未|没有|没|不曾|尚未)[^。；！？]{0,12}(?:调用|执行|运行|使用|用)/.test(c))){r.ok=false;r.issues.push({kind:'tool_not_available_in_scene',reason:'本回调没有该检索/核验工具，不能编造工具执行'});}return r;
 }
 begin(frame){
  if(!['group','friend','qzone_comment'].includes(frame.event?.kind))return;
  const event=this.event(frame.event.id);if(!event||event.status!=='queued'||event.kind!==frame.event.kind||event.sender!==frame.event.sender||event.body!==frame.event.text)throw blocked();
  this.save(event.id,{schema:1,channel:event.kind,source:sourceStamp(event),refs:this.sources(event,frame.socialMemory?.items),phase:'context',attempts:0,issues:[]});
  return {scope:'current_social_frame',toolsUnavailable:['friend_memory_recall','friend_memory_evidence_check'],literalCheck:'宿主只匹配本轮已载社交记录的逐字引文，不重新读在线原件；没有私聊任务回执。不要把候选或匹配说成语义、科学结论或现行状态已证实。'};
 }
 decision(frame,decision){
  if(!['group','friend','qzone_comment'].includes(frame.event?.kind))return null;
  const event=this.event(frame.event.id),old=this.read(frame.event.id);if(!event||!old||!sameSource(old.source,sourceStamp(event)))throw blocked();
  if(decision.disposition!=='reply'){this.save(event.id,{...old,phase:decision.disposition==='defer'?'deferred':'ignored',reason:decision.reason,bodyHash:null});return null;}
  const r=this.checkBody(decision.body,this.currentTexts(event,old.refs)),attempts=old.attempts+1;
  this.save(event.id,{...old,phase:r.ok?(attempts>1?'repaired':'checked'):attempts>1?'blocked':'needs_repair',attempts,bodyHash:hash(decision.body),format:decision.replyFormat??'text',issues:r.issues.map(i=>({kind:i.kind,id:i.id??null})),literalChecks:r.proof.latestCheck?.checks??[],reason:r.ok?'本场景已载原文与明确核验声明检查通过；不认证语义或在线重读':'本场景没有支持该状态/通过声明的回执'});
  return r.ok?null:'reply_facts_unverified: 本场景只能使用已经加载的社交记忆原文；引用需逐字匹配，不能声称调用过并未提供的检索/核验工具，不能从私聊读取任务状态。请改述无依据的成功声明或明确未知，保持自己的回应选择。';
 }
 social(event,body,{stage='before_send'}={}){
  const fresh=this.event(event.id),old=this.read(event.id);let r;
  if(!fresh||!sameSource(sourceStamp(event),sourceStamp(fresh))||!['queued','proposed'].includes(fresh.status))throw blocked();
  if(old&&(!sameSource(old.source,sourceStamp(fresh))||old.bodyHash!==hash(body)||!['checked','repaired','send_checked'].includes(old.phase)))throw blocked();
  r=this.checkBody(body,old?this.currentTexts(fresh,old.refs):[]);
  this.save(event.id,{...(old??{schema:1,channel:event.kind,source:sourceStamp(fresh),refs:[],attempts:0}),phase:r.ok?'send_checked':'blocked',stage,bodyHash:hash(body),issues:r.issues.map(i=>({kind:i.kind,id:i.id??null})),literalChecks:r.proof.latestCheck?.checks??[],reason:r.ok?'待发正文在原会话范围检查完成':'待发正文依据不足或变化，未发送'});
  if(!r.ok)throw blocked();return r;
 }
 agentVoice(agent,text){
  const input=ownerMessage(agent),identity=ownerIdentity(input,agent.session.header);if(!identity)throw blocked();
  const row=identity.channel==='qq'?this.a.qq.store.get(identity.qq.inboxId):{id:input.data.id,event_seq:input.seq,message_id:input.data.id,body:words(input.data.content)};
  const proof=turnProof(agent.session,row,agent.session.seq),result=inspectReply(text,{proof,readTask:id=>taskFact(this.a,agent.id,id)});
  const source={sessionId:agent.id,messageId:input.data.id,seq:input.seq,bodyHash:hash(row.body),...identity.channel==='qq'?{inboxId:row.id,bindingId:row.binding_id}:{}};
  this.save('voice:'+input.data.id,{schema:1,channel:'owner_voice',source,phase:result.ok?'checked':'blocked',bodyHash:hash(text),issues:result.issues.map(i=>({kind:i.kind,id:i.id??null})),reason:result.ok?'待朗读正文已按本轮回执检查':'合成前检查未通过，未向TTS提交正文'});
  if(!result.ok)throw blocked();return {schema:1,bodyHash:hash(text),source,proof,at:new Date().toISOString()};
 }
 async operation(op,prepared){
  if(op.action==='qq_space_reply'&&op.source?.kind==='qzone_comment'){const event=this.event(op.source.eventId);if(!event||op.args.eventId!==event.id||event.account!==op.account||prepared.state?.visibility!==event.raw.postVisibility||prepared.state?.source?.sourceHash!==event.raw.comment.sourceHash)throw blocked();return this.social(event,op.args.text,{stage:'space_before_dispatch'});}
  if(op.action!=='qq_send_voice')return;
  const asset=prepared.asset,record=this.a.platforms.store.media(op.args.assetId);if(!record||record.kind!=='voice'||record.scope?.account!==op.account||!Buffer.isBuffer(asset.bytes)||hash(asset.bytes)!==record.sha256||JSON.stringify(record.scope)!==JSON.stringify(asset.scope))throw blocked();const body=record.text;
  if(record.scope?.origin==='social_reply'){
   const e=this.event(record.scope.sourceEventId);if(!e||record.scope.sourceHash!==e.raw_hash||(op.args.groupId?String(op.args.groupId)!==String(e.raw.group_id):String(op.args.userId??this.a.qq.binding.owner_qq)!==e.sender))throw blocked();
   // A generated social voice normally sends inside its original event. A later
   // explicit resend still cannot turn that scene's receipts into another's.
   return this.checkBody(body,[]).ok?undefined:Promise.reject(blocked());
  }
  const p=record.scope?.replyIntegrity;let proof=empty(),sessionId='';
  const ownerTarget=!op.args.groupId&&String(op.args.userId??this.a.qq.binding.owner_qq)===this.a.qq.binding.owner_qq;
  if(ownerTarget&&p?.schema===1&&p.bodyHash===hash(body)){
   const s=p.source,row=s.inboxId?this.a.qq.store.get(s.inboxId):null;
   if(row&&row.session_id===s.sessionId&&row.binding_id===s.bindingId&&row.message_id===s.messageId&&row.event_seq===s.seq&&hash(row.body)===s.bodyHash&&!['cancelled','withdrawn'].includes(row.status)&&this.a.qq.store.binding(row.binding_id)?.active){proof=p.proof;sessionId=s.sessionId;}
  }
  const r=inspectReply(body,{proof,readTask:id=>sessionId?taskFact(this.a,sessionId,id):{found:false,id,reason:'voice_source_unavailable'}});
  this.save('voice-send:'+op.id,{schema:1,channel:'owner_voice',phase:r.ok?'send_checked':'blocked',operationId:op.id,bodyHash:hash(body),issues:r.issues.map(i=>({kind:i.kind,id:i.id??null})),reason:r.ok?'实际发送前重新核对语音正文与任务状态':'语音发送前依据不足或变化，未提交'});if(!r.ok)throw blocked();
 }
}
