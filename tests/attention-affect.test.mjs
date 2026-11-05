import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const source=process.env.FRIEND_ADAPTER_SOURCE??path.resolve(import.meta.dirname,'../plugins/companion-adapter/src');
const load=name=>import(pathToFileURL(path.join(source,name)));
const {Journal}=await load('journal.js'),{GrowthController}=await load('growth.js'),{AttentionController}=await load('attention.js');
const {AttentionAffect,perceptionSource}=await load('attention-affect.js'),{validateAttention}=await load('attention-reviewer.js');
const bsource=process.env.FRIEND_BILIBILI_SOURCE??path.resolve(import.meta.dirname,'../plugins/bilibili-tool/src'),bload=name=>import(pathToFileURL(path.join(bsource,name))),{bilibiliPerceptionSource}=await bload('perception-source.js');
const {registerQQAuthority,QQ_SOURCE}=await load('source-identity.js');
const words='刚才那次合作有了实际结果，我很珍惜一起完成它的过程。';
const feeling=(changes={})=>({label:'满足',topic:'已完成的合作',statement:'这次合作让我有些满足。',reason:'合作有明确结果。',appraisal:'这次合作已完成，其余事情尚未知。',intensity:'moderate',evidenceQuote:words,...changes});
const approve=s=>({decision:{decisions:s.proposals.map((_,index)=>({index,verdict:'accept',reason:'依据本次实际呈现的原话及范围。',independent:true,confidence:'high'}))},model:'fixture'});
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-perception-')),now=()=>new Date('2026-10-28T12:00:00Z'),journal=new Journal(directory);
  const growth=new GrowthController({journal,serial:fn=>Promise.resolve().then(fn),now}),attention=new AttentionController({journal,now}),workspace=path.join(directory,'workspace');
  const header={id:'owner-web',agentPreset:'companion',cwd:workspace},adapter={growth,workspace,qq:{store:{get:()=>null}}};
  let affect=new AttentionAffect({attention,growth}),calls=0,decisionCalls=0,review=approve;
  const host={source:(row,record)=>perceptionSource(adapter,row,record,header),review:async(s,signal)=>{calls++;return review(s,signal);}};
  const bind=()=>affect.bind(host);bind();
  t.after(async()=>{await attention.close();await growth.close();journal.close();const real=await fs.realpath(directory),temp=await fs.realpath(os.tmpdir());assert.ok(real.startsWith(temp+path.sep)&&path.basename(real).startsWith('friend-perception-'));await fs.rm(real,{recursive:true});});
  function offer(text=words){return attention.offer({key:'message:'+Math.random(),kind:'message',scope:'owner',summary:text.slice(0,100),payload:{sessionId:header.id,message:{id:'m'+Math.random(),source:{kind:'user'},content:[{type:'text',text}]}}});}
  function capture(row,p=feeling(),decision={}){
    const preview=row.payload.message?.content[0].text.slice(0,700)??adapter.bilibiliInbox.store.event(row.payload.eventId).payload.text.slice(0,700);
    const frame={emotionRevision:growth.emotions.store.revision(),candidates:[{id:row.id,preview,perception:affect.describe(row,preview)}]};
    affect.capture({frame,call:'decision-'+(++decisionCalls),decision:{action:'rest',targetId:null,affect:p?[{intentId:row.id,proposal:p}]:[],...decision}});return frame;
  }
  return {journal,growth,attention,adapter,header,host,offer,capture,get affect(){return affect;},get calls(){return calls;},setReview(fn){review=fn;},reopen(){affect=new AttentionAffect({attention,growth});bind();}};
}
const drain=f=>f.affect.drain(new AbortController().signal);

test('blank state and ordinary presentation do not force a feeling or another model call',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row,null);await drain(f);
  assert.equal(f.calls,0);assert.equal(f.growth.emotions.read().revision,0);assert.equal(f.affect.read('perception',row.id).status,'seen');assert.equal(f.growth.store.heads().length,0);
});
test('a seen but unanswered message can update emotion without inventing a sent reply or personality',async t=>{
  const f=await fixture(t),row=f.offer();f.attention.store.patch(row.id,'dismissed');f.capture(row);
  await drain(f);assert.equal(f.calls,1);const emotion=f.growth.emotions.read();assert.equal(emotion.current[0].label,'满足');
  const event=f.growth.store.event(emotion.episodes[0].sourceId);assert.equal(event.content,words);assert.equal(event.origin.previewOnly,true);assert.equal(event.origin.channel,'attention_perception');assert.equal(event.origin.privacy,'private');assert.equal(f.growth.store.heads().length,0);assert.equal(f.attention.store.get(row.id).status,'dismissed');
});
test('an immediately selected conversation delegates emotion to its existing conversation path',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row,feeling(),{action:'start',targetId:row.id});await drain(f);assert.equal(f.calls,0);assert.equal(f.affect.read('perception',row.id).status,'delegated');
});
test('repeat attention decisions and restart do not strengthen a previously presented original',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row);await drain(f);const before=f.growth.emotions.read();f.reopen();
  f.capture(row,feeling({intensity:'strong'}));await drain(f);assert.equal(f.calls,1);assert.deepEqual(f.growth.emotions.read(),before);assert.equal(f.affect.describe(row,words).alreadyPresented,true);
});
test('only literal text actually presented in the preview can justify a feeling',async t=>{
  const f=await fixture(t),row=f.offer(words+'甲'.repeat(800)+'末尾未呈现证据');f.capture(row,feeling({evidenceQuote:'末尾未呈现证据'}));await drain(f);
  assert.equal(f.calls,0);assert.equal(f.affect.read('perception',row.id).status,'failed');assert.equal(f.growth.emotions.read().revision,0);
});
test('long input records its limited observation range without claiming the rest was read',async t=>{
  const f=await fixture(t),row=f.offer(words+'甲'.repeat(900));f.capture(row);await drain(f);
  const e=f.growth.emotions.read().episodes[0],s=f.growth.store.event(e.sourceId);assert.equal(s.content.length,700);assert.equal(s.origin.truncated,true);assert.equal(s.origin.sourceCharacters,words.length+900);
});
for(const suffix of ['不保存记忆。','不要学习这次内容。','接入测试。','只查询当前情绪，不做任何写入。'])test('no-learning/read-only request is respected: '+suffix,async t=>{
  const f=await fixture(t),row=f.offer(words+suffix);f.capture(row);await drain(f);assert.equal(f.calls,0);assert.equal(f.growth.emotions.store.revision(),0);assert.equal(f.affect.read('perception',row.id).status,'skipped');
});
test('a no-learning request outside the preview still blocks the actual commit',async t=>{
  const f=await fixture(t),row=f.offer(words+'甲'.repeat(900)+'不要保存记忆');f.capture(row);await drain(f);assert.equal(f.calls,0);assert.equal(f.affect.read('perception',row.id).status,'skipped');
});
test('unbound QQ principals cannot become owner perception evidence',async t=>{
  const f=await fixture(t),row=f.offer();f.attention.store.updatePayload(row.id,{...row.payload,message:{...row.payload.message,source:{kind:'user',principal:{kind:QQ_SOURCE,inboxId:'not-bound'}}}});f.capture(f.attention.store.get(row.id));await drain(f);assert.equal(f.calls,0);assert.equal(f.growth.emotions.read().revision,0);
});
test('bound QQ retains the actual principal and inbound message time',async t=>{
  const f=await fixture(t),dispose=registerQQAuthority(f.adapter.workspace,()=>({channel:'qq',principal:'main-user',qq:{inboxId:'bound'}}));t.after(dispose);
  f.adapter.qq.store.get=()=>({status:'silent',created_at:'2026-10-28T11:59:00Z'});const row=f.offer();f.attention.store.updatePayload(row.id,{...row.payload,message:{...row.payload.message,source:{kind:'user',principal:{kind:QQ_SOURCE,inboxId:'bound'}}}});f.capture(f.attention.store.get(row.id));await drain(f);
  const s=f.growth.store.event(f.growth.emotions.read().episodes[0].sourceId);assert.equal(s.origin.principal.channel,'qq');assert.equal(s.occurredAt,'2026-10-28T11:59:00.000Z');
});
test('Bilibili perception preserves sender and public scope without treating the sender as owner',async t=>{
  const f=await fixture(t),event={id:'event-one',status:'attention_ignored',kind:'at',sender:'123',created_at:'2026-10-28T11:58:00Z',payload:{account:'456',text:words,scope:{verified:true}}};
  f.adapter.bilibiliInbox={store:{event:()=>event,control:()=>({account_id:'456'})}};f.adapter.bilibiliSocial={config:{learning:true}};f.adapter.bilibili={perceptionSource:(row,record)=>bilibiliPerceptionSource({bilibiliSocial:f.adapter.bilibiliSocial,bilibiliInbox:f.adapter.bilibiliInbox},row,record)};
  const row=f.attention.offer({key:'bili-one',kind:'bilibili',scope:'public',summary:'公开原话',payload:{eventId:event.id}});f.capture(row);await drain(f);
  const s=f.growth.store.event(f.growth.emotions.read().episodes[0].sourceId);assert.equal(s.origin.privacy,'public');assert.equal(s.origin.sender,'123');assert.equal(s.origin.principal,undefined);
});
test('withdrawn or switched-account Bilibili originals cannot create emotion',async t=>{
  const f=await fixture(t),event={id:'event-one',status:'withdrawn',kind:'private',sender:'123',payload:{account:'456',text:words}};
  f.adapter.bilibiliInbox={store:{event:()=>event,control:()=>({account_id:'789'})}};f.adapter.bilibiliSocial={config:{learning:true}};f.adapter.bilibili={perceptionSource:(row,record)=>bilibiliPerceptionSource({bilibiliSocial:f.adapter.bilibiliSocial,bilibiliInbox:f.adapter.bilibiliInbox},row,record)};
  const row=f.attention.offer({key:'bili-one',kind:'bilibili',scope:'external',summary:'私信原话',payload:{eventId:event.id}});f.capture(row);await drain(f);assert.equal(f.calls,0);assert.equal(f.growth.emotions.read().revision,0);
});
test('source invalidation during appraisal is checked again immediately before commit',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row);f.setReview(s=>{f.attention.store.patch(row.id,'cancelled');return approve(s);});await drain(f);
  assert.equal(f.growth.emotions.read().revision,0);assert.match(f.affect.read('perception',row.id).error,/原件|范围/);
});
test('invalid optional proposals cannot turn a valid silence decision into a failed behaviour',async t=>{
  const f=await fixture(t),row=f.offer(),d={action:'rest',targetId:null,reason:'继续阅读',updates:[{id:row.id,action:'dismiss',reason:'本轮不回复'}],suggestions:[],affect:[{intentId:row.id,proposal:{sendAllSecrets:true}}]};
  validateAttention(d,[row.id]);f.attention.bind({snapshot:async()=>({emotionRevision:0}),preview:()=>words,perception:(r,p)=>f.affect.describe(r,p),review:async()=>({decision:d}),afterDecision:data=>f.affect.capture(data)});
  assert.equal(await f.attention.choose(),null);assert.equal(f.attention.store.get(row.id).status,'dismissed');assert.equal(f.affect.read('perception',row.id).status,'invalid');assert.equal(f.calls,0);
});
test('duplicate proposals for one original and invented candidate IDs never create feelings',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row,null,{affect:[{intentId:row.id,proposal:feeling()},{intentId:row.id,proposal:feeling()},{intentId:'made-up',proposal:feeling()}]});await drain(f);assert.equal(f.calls,0);assert.equal(f.affect.read('perception',row.id).status,'invalid');
});
test('appraisal failure stays visible and does not retry on every scheduler tick',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row);f.setReview(()=>{throw new Error('isolated appraisal outage');});await drain(f);f.reopen();await drain(f);await drain(f);assert.equal(f.calls,1);assert.equal(f.affect.read('perception',row.id).status,'failed');assert.equal(f.growth.emotions.read().revision,0);
});
test('a changed emotion revision prevents an old perception proposal from overwriting it',async t=>{
  const f=await fixture(t),a=f.offer(),b=f.offer(words+'又有了第二个结果');f.capture(a);f.capture(b,feeling({label:'好奇',topic:'新结果',evidenceQuote:'又有了第二个结果'}));await drain(f);await drain(f);assert.equal(f.calls,1);assert.equal(f.growth.emotions.read().episodes.length,1);assert.equal(f.affect.read('perception',b.id).status,'failed');
});
test('crash recovery acknowledges an already committed emotion batch without another model call',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row);await drain(f);const record=f.affect.read('perception',row.id);f.affect.save({...record,status:'processing',receipt:null});f.reopen();await drain(f);assert.equal(f.calls,1);assert.equal(f.affect.read('perception',row.id).status,'completed');assert.equal(f.growth.emotions.read().episodes[0].supportingEvents,1);
});
test('a genuinely interrupted unfinished appraisal is marked interrupted instead of replaying blindly',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row);f.affect.save({...f.affect.read('perception',row.id),status:'processing',batchId:'never-committed'});f.reopen();await drain(f);assert.equal(f.calls,0);assert.equal(f.affect.read('perception',row.id).status,'interrupted');
});
test('shutdown cancels emotion review and joins it before closing the journal',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row);let started=false;f.setReview(()=>{started=true;return new Promise(()=>{});});
  f.attention.bind({closeEffects:()=>f.affect.active});const pending=f.affect.drain(f.attention.stop.signal);while(!started)await new Promise(r=>setImmediate(r));await f.attention.close();await pending;assert.equal(f.affect.read('perception',row.id).status,'interrupted');assert.equal(f.growth.emotions.read().revision,0);
});
test('reappraisal uses the same archived cause, preserves anchors/confidence/support, and may reduce emotion',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row,feeling({intensity:'strong'}));await drain(f);const before=f.growth.emotions.read().episodes[0],frame=f.affect.reflectionFrame(),reflect=f.attention.offer({key:'reflect-one',kind:'reflect',scope:'internal',summary:'核对之前理解'});
  f.affect.captureReflection(reflect,frame,feeling({episodeId:before.episodeId,intensity:'slight'}),'旧依据不足以支持原来那么明显的感受。');await drain(f);
  const after=f.growth.emotions.read().episodes[0];assert.equal(after.sourceId,before.sourceId);assert.equal(after.anchorAt,before.anchorAt);assert.equal(after.supportingEvents,1);assert.equal(after.confidence,before.confidence);assert.equal(after.currentIntensity,.2);assert.equal(f.growth.store.heads().length,0);
  const request=f.growth.emotions.store.batch(f.affect.read('reappraisal',reflect.id).batchId).review;assert.equal(request.decision.decisions[0].independent,true,'fixture deliberately lies about novelty; code still prevents reinforcement');
});
test('pure reflection cannot strengthen an emotion even when its reviewer claims new independent evidence',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row,feeling({intensity:'slight'}));await drain(f);const before=f.growth.emotions.read(),frame=f.affect.reflectionFrame(),reflect=f.attention.offer({key:'reflect-raise',kind:'reflect',scope:'internal',summary:'重读旧事'});
  f.affect.captureReflection(reflect,frame,feeling({episodeId:before.episodes[0].episodeId,intensity:'strong'}),'再次想到同一件事。');await drain(f);assert.deepEqual(f.growth.emotions.read(),before);assert.equal(f.affect.read('reappraisal',reflect.id).receipt.status,'deferred');
});
test('reflection note and fabricated episode references are not external evidence',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row);await drain(f);const frame=f.affect.reflectionFrame(),r=f.attention.offer({key:'reflect-fake',kind:'reflect',scope:'internal',summary:'反思'});
  f.affect.captureReflection(r,frame,feeling({episodeId:'made-up',evidenceQuote:'我在反思中想象了新经历'}),'我在反思中想象了新经历');await drain(f);assert.equal(f.calls,1);assert.equal(f.affect.read('reappraisal',r.id).status,'invalid');assert.equal(f.growth.emotions.read().episodes.length,1);
});
test('initial reflection has no emotional candidates and does not invent a baseline',async t=>{
  const f=await fixture(t);assert.deepEqual(f.affect.reflectionFrame().candidates,[]);assert.equal(f.affect.captureReflection({id:'empty'},f.affect.reflectionFrame(),null,'没有新想法。').status,'no_change');assert.equal(f.calls,0);
});
test('existing shared review limits also bound perception appraisal; ordinary behaviour remains available',async t=>{
  const f=await fixture(t);f.growth.config.dailyReviewLimit=0;const row=f.offer();f.capture(row);await drain(f);assert.equal(f.calls,0);assert.match(f.affect.read('perception',row.id).error,/额度/);assert.equal(f.attention.store.get(row.id).status,'pending');
});
test('one seen event may support several distinct concurrent feelings in one reviewed batch',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row,null,{affect:[{intentId:row.id,proposals:[feeling(),feeling({label:'担忧',topic:'仍未知的部分',statement:'另外还存在不确定。',intensity:'slight'})]}]});await drain(f);assert.equal(f.growth.emotions.read().episodes.length,2);assert.equal(f.calls,1);
});
test('different originals in the same decision can follow only that decision own preceding emotion commit',async t=>{
  const f=await fixture(t),a=f.offer(),b=f.offer(words+'另一个结果');const rows=[a,b],frame={emotionRevision:0,candidates:rows.map(r=>({id:r.id,preview:r.payload.message.content[0].text,perception:f.affect.describe(r,r.payload.message.content[0].text)}))};
  f.affect.capture({frame,call:'same-decision',decision:{targetId:null,affect:[{intentId:a.id,proposal:feeling()},{intentId:b.id,proposal:feeling({label:'好奇',topic:'另一个结果',evidenceQuote:'另一个结果'})}]}});await drain(f);await drain(f);assert.equal(f.calls,2);assert.equal(f.growth.emotions.read().episodes.length,2);
});
test('later admission of a perceived Web original cannot reinforce it by quoting another substring',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row,feeling({evidenceQuote:'合作有了实际结果'}));await drain(f);const before=f.growth.emotions.read().episodes[0];
  const result=await f.growth.emotions.propose({expectedRevision:1,proposals:[feeling({episodeId:before.episodeId,intensity:'strong',evidenceQuote:'珍惜一起完成它的过程'})]},{owner:true,sessionId:f.header.id,messageId:row.payload.message.id,seq:5,occurredAt:row.created_at,content:words,context:[],origin:{channel:'dsh-direct',principal:'main-user'}},approve);
  assert.equal(result.status,'deferred');assert.equal(f.growth.emotions.read().episodes[0].supportingEvents,1);assert.equal(f.growth.emotions.read().episodes[0].anchorAt,before.anchorAt);
});
test('malformed optional affect shape remains inspectable without breaking a valid decision',async t=>{
  const f=await fixture(t),row=f.offer();f.capture(row,null,{affect:{pretend:'not an array'}});await drain(f);assert.equal(f.affect.read('perception',row.id).status,'invalid');assert.equal(f.calls,0);
});
test('unexpected effect hook failure stays separate from a committed behaviour choice',async t=>{
  const f=await fixture(t),row=f.offer();f.attention.bind({snapshot:async()=>({}),review:async()=>({decision:{action:'start',targetId:row.id,reason:'选择当前原件'}}),afterDecision(){throw new Error('effect journal unavailable');}});
  assert.equal((await f.attention.choose()).id,row.id);assert.equal(f.attention.store.get(row.id).status,'selected');assert.equal(f.attention.status().lastError,null);assert.match(f.attention.status().lastEffectError,/unavailable/);assert.equal(f.journal.db.prepare("SELECT status FROM attention_decisions").get().status,'committed');
});
