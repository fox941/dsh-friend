import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL,fileURLToPath } from 'node:url';
const source=process.env.FRIEND_ADAPTER_SOURCE??fileURLToPath(new URL('../plugins/companion-adapter/src',import.meta.url));
const {Journal}=await import(pathToFileURL(path.join(source,'journal.js')));
const {GrowthController}=await import(pathToFileURL(path.join(source,'growth.js')));
const {reviewGrowth}=await import(pathToFileURL(path.join(source,'growth-reviewer.js')));
const {attachGrowth}=await import(pathToFileURL(path.join(source,'growth-agent.js')));

const decision=(snapshot,options={})=>({decision:{decisions:snapshot.proposals.map((_row,index)=>({index,verdict:'accept',reason:'存在可核对的本轮依据，保留不确定性并检查旧记录。',independent:true,sameClaim:false,...options}))},usage:{inputTokens:80,outputTokens:40,totalTokens:120},provider:'fixture',model:'fixture'});
async function fixture(t,config={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-growth-test-'));
  const clock={value:Date.parse('2026-10-27T02:00:00Z')};let journal,growth;
  const open=()=>{journal=new Journal(directory);growth=new GrowthController({journal,serial:fn=>Promise.resolve().then(fn),config,now:()=>new Date(clock.value)});};open();
  t.after(async()=>{await growth.close();if(journal.db.isOpen)journal.close();const real=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());assert.ok(real.startsWith(parent+path.sep)&&path.basename(real).startsWith('friend-growth-test-'));await fs.rm(real,{recursive:true});});
  return {clock,directory,get journal(){return journal;},get growth(){return growth;},async reopen(){await growth.close();if(journal.db.isOpen)journal.close();open();},input(content='这次我们讨论一个新的科幻设定。',sessionId='session-a'){return{owner:true,sessionId,messageId:crypto.randomUUID(),seq:1,occurredAt:new Date(clock.value).toISOString(),content,context:[]};}};
}
function args(f,event,changes={}){
  return {expectedRevision:f.growth.read().revision,proposals:[{kind:'interest',key:'科幻设定',action:'set',statement:'我对科幻设定有些好奇，愿意继续探索。',reason:'这次实际讨论引出了自己的好奇，暂不视作稳定性格。',evidenceQuote:event.content,...changes}]};
}
async function submit(f,event=f.input(),changes={},review={}){return f.growth.propose(args(f,event,changes),event,snapshot=>decision(snapshot,review));}

test('starts with no persona, emotion or interest and preserves one identity on reopen',async t=>{
  const f=await fixture(t),first=f.growth.read();assert.equal(first.blank,true);assert.deepEqual(first.states,[]);assert.equal(first.revision,0);assert.equal(first.reviewCallsToday,0);
  await f.reopen();assert.equal(f.growth.read().identityId,first.identityId);assert.equal(f.growth.read().blank,true);
});
test('records a tentative self-state and its exact source instead of populating user memory',async t=>{
  const f=await fixture(t),event=f.input();const result=await submit(f,event);assert.equal(result.status,'applied');assert.equal(result.changes[0].status,'tentative');assert.equal(result.changes[0].supportingEvents,1);
  const history=f.growth.history();assert.equal(history.proposals[0].source.content,event.content);assert.equal(history.proposals[0].source.messageId,event.messageId);assert.equal(history.proposals[0].review.provider,'fixture');
  assert.equal(f.journal.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='insights'").get().n,0);
});
test('replaying one operation neither repeats review nor writes another version',async t=>{
  const f=await fixture(t),event=f.input(),request=args(f,event);let calls=0;const review=snapshot=>{calls++;return decision(snapshot);};
  const first=await f.growth.propose(request,event,review),second=await f.growth.propose(request,event,review);
  assert.equal(second.replayed,true);assert.equal(first.batchId,second.batchId);assert.equal(calls,1);assert.equal(f.growth.read().revision,1);
});
test('the same text in another session cannot become independent supporting evidence',async t=>{
  const f=await fixture(t);await submit(f);const repeated=f.input('这次我们讨论一个新的科幻设定。','session-b');
  const result=await submit(f,repeated,{}, {sameClaim:true});assert.equal(result.status,'deferred');assert.equal(f.growth.read().states[0].supports.length,1);assert.equal(f.growth.read().revision,1);
});
test('a paraphrase identified as the same event does not reinforce the state',async t=>{
  const f=await fixture(t);await submit(f);const result=await submit(f,f.input('刚才那次科幻讨论，换句话再说一遍。','session-b'),{}, {sameClaim:true,independent:false});
  assert.equal(result.status,'deferred');assert.equal(f.growth.read().states[0].status,'tentative');
});
test('independent cross-session experiences can establish an interest after semantic review',async t=>{
  const f=await fixture(t);await submit(f);const result=await submit(f,f.input('今天读另一篇新故事，我们又讨论了不同的时间设定。','session-b'),{}, {sameClaim:true});
  assert.equal(result.changes[0].status,'established');assert.equal(result.changes[0].supportingEvents,2);
});
test('stable self-description requires more than two independent observations',async t=>{
  const f=await fixture(t);const changes={kind:'self_description',key:'current',statement:'讨论问题时，我倾向先追问背后的原因。'};
  await submit(f,f.input('第一次一起分析一个新问题。'),changes);
  await submit(f,f.input('另一次讨论中你又选择追问原因。','session-b'),changes,{sameClaim:true});assert.equal(f.growth.read().states[0].status,'tentative');
  await submit(f,f.input('第三个不同问题中仍然出现了这个选择。','session-c'),changes,{sameClaim:true});assert.equal(f.growth.read().states[0].status,'established');
});
test('a changed meaning starts with its own evidence rather than inheriting stability',async t=>{
  const f=await fixture(t);await submit(f);await submit(f,f.input('第二个独立故事。','session-b'),{}, {sameClaim:true});
  await submit(f,f.input('这次体验不同，我对这个主题的认识要调整。','session-c'),{statement:'目前对这类科幻设定有些保留，愿意换一个方向。'},{sameClaim:false});
  assert.equal(f.growth.read().states[0].status,'tentative');assert.equal(f.growth.read().states[0].supports.length,1);
});
test('retiring a mistaken base state invalidates dependent personal guidance',async t=>{
  const f=await fixture(t);await submit(f);const basis=f.growth.read().states[0];
  await submit(f,f.input('继续按这个兴趣决定你想追问什么。'),{kind:'personal_prompt',key:'current',statement:'可以主动追问感兴趣的科幻设定。',dependsOn:[basis.id]});
  const result=await submit(f,f.input('更正：前面的例子被误读了，请撤回那项兴趣。'),{action:'retract'});
  assert.equal(result.invalidated.length,1);assert.equal(f.growth.read().states.find(row=>row.kind==='personal_prompt').status,'needs_review');assert.ok(!f.growth.context().includes('可以主动追问感兴趣的科幻设定'));
  assert.ok(f.growth.history('interest:科幻设定').versions.some(row=>row.status==='retracted'));
});
test('dependency cycles are deferred even if a reviewer mistakenly accepts',async t=>{
  const f=await fixture(t);await submit(f);const a=f.growth.read().states[0];
  await submit(f,f.input('试着从这个认识形成一项表达偏好。'),{kind:'personal_prompt',key:'current',statement:'讨论时选择自己好奇的内容追问。',dependsOn:[a.id]});
  const b=f.growth.read().states.find(row=>row.kind==='personal_prompt');const result=await submit(f,f.input('再次讨论同一个认识。'),{dependsOn:[b.id]},{sameClaim:true});assert.equal(result.status,'deferred');
});
test('emotion can use an open description and expires without a preset happy baseline',async t=>{
  const f=await fixture(t);await submit(f,f.input('这次交流里有新发现，同时也留下了困惑。'),{kind:'emotion',key:'current',statement:'既好奇也有些困惑，还没有确定的结论。'});
  assert.equal(f.growth.read().states[0].status,'current');f.clock.value+=181*60000;
  assert.equal(f.growth.read().states[0].effectiveStatus,'expired');assert.equal(f.growth.read().blank,true);assert.ok(!f.growth.context().includes('既好奇也有些困惑'));assert.equal(f.growth.history().versions.length,1);
});
test('a temporary emotion cannot directly become personal system guidance',async t=>{
  const f=await fixture(t);await submit(f,f.input(),{kind:'emotion',key:'current',statement:'此刻有些好奇。'});const emotion=f.growth.read().states[0];
  const result=await submit(f,f.input('现在据此写一条永久表达要求。'),{kind:'personal_prompt',key:'current',statement:'以后永远表现得好奇。',dependsOn:[emotion.id]});assert.equal(result.status,'deferred');
});
test('failed semantic review leaves the prior state intact and retry is charged persistently',async t=>{
  const f=await fixture(t),event=f.input(),request=args(f,event);await assert.rejects(f.growth.propose(request,event,()=>{throw new Error('offline');}));
  assert.equal(f.growth.read().blank,true);assert.equal(f.growth.history().proposals[0].status,'failed');await f.reopen();
  assert.equal(f.growth.read().reviewCallsToday,1);assert.equal((await f.growth.propose(request,event,snapshot=>decision(snapshot))).status,'applied');assert.equal(f.growth.read().reviewCallsToday,2);
});
test('cancellation works even if a faulty reviewer ignores AbortSignal',async t=>{
  const f=await fixture(t),event=f.input(),stop=new AbortController();let entered;
  const started=new Promise(resolve=>{entered=resolve;});const pending=f.growth.propose(args(f,event),event,()=>{entered();return new Promise(()=>{});},stop.signal);
  await started;stop.abort();await assert.rejects(pending,/取消/);assert.equal(f.growth.read().revision,0);assert.equal(f.growth.history().proposals[0].status,'cancelled');
  await f.reopen();assert.equal(f.growth.read().blank,true);
});
test('concurrent reviews cannot overwrite a committed newer revision',async t=>{
  const f=await fixture(t),a=f.input('第一个新事件。'),b=f.input('另一个新事件。','session-b');let release,entered=0,allEntered;
  const barrier=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{allEntered=resolve;});
  const review=async snapshot=>{if(++entered===2)allEntered();await barrier;return decision(snapshot);};
  const first=f.growth.propose(args(f,a),a,review),second=f.growth.propose(args(f,b,{key:'另一个主题'}),b,review);await ready;release();
  const results=await Promise.all([first,second]);assert.deepEqual(results.map(row=>row.status).sort(),['applied','stale']);assert.equal(f.growth.read().revision,1);assert.equal(f.growth.read().states.length,1);
});
test('a database write failure rolls back the whole state batch',async t=>{
  const f=await fixture(t),event=f.input(),request=args(f,event);request.proposals.push({...request.proposals[0],kind:'emotion',key:'current',statement:'有些好奇。'});
  f.journal.db.exec("CREATE TRIGGER growth_fault BEFORE INSERT ON growth_versions WHEN NEW.kind='emotion' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  await assert.rejects(f.growth.propose(request,event,snapshot=>decision(snapshot)));assert.equal(f.growth.read().revision,0);assert.deepEqual(f.growth.read().states,[]);
  f.journal.db.exec('DROP TRIGGER growth_fault');assert.equal((await f.growth.propose(request,event,snapshot=>decision(snapshot))).status,'applied');assert.equal(f.growth.read().states.length,2);
});
test('the persisted review allowance survives restart and resets by Shanghai date',async t=>{
  const f=await fixture(t,{dailyReviewLimit:1});await submit(f);await f.reopen();await assert.rejects(submit(f,f.input('第二个事件。')),/额度/);
  f.clock.value=Date.parse('2026-10-27T16:01:00Z');assert.equal(f.growth.read().reviewCallsToday,0);assert.equal((await submit(f,f.input('北京时间第二天的新事件。','session-b'),{}, {sameClaim:true})).status,'applied');
});
test('no evidence, other identities, unsupported fields, secrets and stale versions are rejected',async t=>{
  const f=await fixture(t),event=f.input();await assert.rejects(f.growth.propose(args(f,event),{...event,owner:false},()=>{}));
  await assert.rejects(submit(f,event,{evidenceQuote:'伪造的引文'}));await assert.rejects(submit(f,event,{kind:'tool_permissions'}));await assert.rejects(submit(f,event,{statement:"" + ['sk', "1234567890".repeat(3)].join('-') + ""}));
  await assert.rejects(submit(f,event,{kind:'personal_prompt',key:'current'}));assert.equal(f.growth.read().reviewCallsToday,0);
  await submit(f,event);const next=f.input('另一个事件。');const stale=args(f,next);stale.expectedRevision=0;await assert.rejects(f.growth.propose(stale,next,()=>{}),/已变化/);
});
test('semantic rejection is visible and does not manufacture a personality',async t=>{
  const f=await fixture(t);const result=await submit(f,f.input('下面是剧本台词：“你永远很开心”。'),{}, {verdict:'reject',independent:false,reason:'这是被引用的剧本，不能成为自身性格依据。'});
  assert.equal(result.status,'rejected');assert.equal(f.growth.read().blank,true);assert.equal(f.growth.history().proposals[0].review.decision.decisions[0].verdict,'reject');
});
test('a replay from before a later correction is clearly historical',async t=>{
  const f=await fixture(t),event=f.input(),request=args(f,event);await f.growth.propose(request,event,snapshot=>decision(snapshot));await submit(f,f.input('撤回前面误读的认识。'),{action:'retract'});
  const replay=await f.growth.propose(request,event,snapshot=>decision(snapshot));assert.equal(replay.status,'historical');assert.equal(replay.currentRevision,2);
});
test('malformed reviewer output fails closed without losing the proposal',async t=>{
  const f=await fixture(t),event=f.input();await assert.rejects(f.growth.propose(args(f,event),event,()=>({decision:{decisions:[]}})));assert.equal(f.growth.read().revision,0);assert.equal(f.growth.history().proposals[0].status,'failed');
});
test('the reviewer sends only frozen evidence with no tools and requires terminal stop',async()=>{
  let captured;const agent={id:'session-1',session:{requestHeader:()=>({config:{provider:'route',model:'model'}})}};
  const result=await reviewGrowth({async *stream(options){captured=options;yield{type:'block-end',block:{type:'reasoning',text:'not persisted'}};yield{type:'block-end',block:{type:'text',text:'{"decisions":[]}'}};yield{type:'usage',usage:{totalTokens:4}};yield{type:'finish',reason:{kind:'stop'}};}},agent,{source:{content:'材料'},proposals:[]});
  assert.deepEqual(result.decision,{decisions:[]});assert.equal(captured.tools,undefined);assert.equal(captured.messages.length,1);assert.equal(captured.sessionId,agent.id);
  await assert.rejects(reviewGrowth({async *stream(){yield{type:'block-end',block:{type:'text',text:'{"decisions":[]}'}};yield{type:'finish',reason:{kind:'length'}};}},agent,{}));
});
test('only the current owner receives self-state context and state tools',async t=>{
  const f=await fixture(t),tools=new Map(),contexts=new Map();
  const message={type:'user/message',seq:1,time:f.clock.value,data:{id:'message-1',source:{kind:'user'},content:[{type:'text',text:'先读当前状态。'}]}};
  const agent={id:'session-test',session:{header:{},seq:2,eventAt:seq=>seq===1?message:{type:'turn/start',seq:0}}};
  const ctx={systemPrompt:{section:()=>{},context:row=>contexts.set(row.name,row)},tools:{register:row=>tools.set(row.name,row)},on:()=>{}};attachGrowth(ctx,{growth:f.growth});
  assert.deepEqual([...tools.keys()],['friend_state_read','friend_state_history','friend_state_propose','friend_emotion_read','friend_emotion_history','friend_emotion_propose']);assert.ok(contexts.get('ai-friend:self-state').text({scope:agent}).includes('"blank":true'));
  message.data.source.principal={kind:'remote'};await assert.rejects(tools.get('friend_state_read').execute({}, {agent}));assert.equal(contexts.get('ai-friend:self-state').text({scope:agent}),'');await assert.rejects(tools.get('friend_emotion_read').execute({}, {agent}));await assert.rejects(tools.get('friend_emotion_propose').execute({}, {agent}));
});

test('adding growth tables preserves preexisting correction history and adapter schema',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-growth-test-migration-')),journal=new Journal(directory);
  let growth;
  t.after(async()=>{await growth?.close();journal.close();const real=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());assert.ok(real.startsWith(parent+path.sep)&&path.basename(real).startsWith('friend-growth-test-'));await fs.rm(real,{recursive:true});});
  const id='old-operation',oldId=crypto.randomUUID(),newId=crypto.randomUUID();
  journal.prepare({id,storeId:'default',factKey:'existing-fact',oldId,oldContent:'旧值',newContent:'新值',oldSnapshot:{id:oldId,content:'旧值'},evidence:{quote:'更正为新值'},reason:'原有纠错记录'});
  journal.update(id,'written',newId);journal.commit(id);const before=JSON.stringify(journal.get(id));
  growth=new GrowthController({journal,serial:fn=>Promise.resolve().then(fn)});
  assert.equal(JSON.stringify(journal.get(id)),before);assert.equal(journal.head('default','existing-fact'),newId);assert.equal(journal.db.prepare('SELECT version FROM adapter_schema WHERE id=1').get().version,1);assert.equal(growth.read().blank,true);
});

test('stored state survives an offline directory copy with the same identity and evidence',async t=>{
  const f=await fixture(t);await submit(f);const expected=f.growth.read(),history=f.growth.history();await f.growth.close();f.journal.close();
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-growth-test-restored-'));await fs.cp(f.directory,directory,{recursive:true});
  const journal=new Journal(directory),growth=new GrowthController({journal,serial:fn=>Promise.resolve().then(fn)});
  t.after(async()=>{await growth.close();journal.close();const real=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());assert.ok(real.startsWith(parent+path.sep)&&path.basename(real).startsWith('friend-growth-test-'));await fs.rm(real,{recursive:true});});
  assert.equal(growth.read().identityId,expected.identityId);assert.deepEqual(growth.read().states,expected.states);assert.deepEqual(growth.history().proposals[0].source,history.proposals[0].source);
  // Reopen the original fixture so its standard cleanup owns an open connection again.
  await f.reopen();
});

test('a missing actual reply can be checked once after the reply without user approval or duplicate evidence',async t=>{
  const f=await fixture(t),event=f.input(),request=args(f,event);let calls=0;
  const first=await f.growth.propose(request,event,snapshot=>{calls++;return decision(snapshot,{verdict:'defer',independent:false,needsResponse:true,reason:'还没有实际回答，等待核对真实选择。'});});
  assert.equal(first.status,'awaiting_response');assert.equal(f.growth.read().blank,true);
  const observed={...event,context:[{role:'assistant',seq:3,text:'我选择讨论旧书店的营业条件，因为更关心条件背后的代价。'}]};
  const results=await f.growth.afterResponse(observed,snapshot=>{calls++;assert.equal(snapshot.source.context[0].role,'assistant');return decision(snapshot);});
  assert.equal(results[0].status,'applied');assert.equal(f.growth.read().states[0].supports.length,1);assert.equal(f.growth.history().proposals[0].reviewSteps.length,2);
  assert.deepEqual(await f.growth.afterResponse(observed,()=>{calls++;}),[]);assert.equal(calls,2);
});

test('ordinary semantic deferral does not trigger another model request at turn end',async t=>{
  const f=await fixture(t),event=f.input();await f.growth.propose(args(f,event),event,snapshot=>decision(snapshot,{verdict:'defer',independent:false,needsResponse:false}));
  const results=await f.growth.afterResponse(event,()=>{throw new Error('must not be called');});assert.deepEqual(results,[]);assert.equal(f.growth.read().reviewCallsToday,1);
});

test('reply-time checking stops after one retry even when uncertainty remains',async t=>{
  const f=await fixture(t),event=f.input(),review=snapshot=>decision(snapshot,{verdict:'defer',independent:false,needsResponse:true});
  await f.growth.propose(args(f,event),event,review);const result=await f.growth.afterResponse(event,review);assert.equal(result[0].status,'deferred');
  assert.deepEqual(await f.growth.afterResponse(event,()=>{throw new Error('no third call');}),[]);assert.equal(f.growth.read().reviewCallsToday,2);
});

test('review inputs are deeply frozen and cannot mutate the proposal that will be committed',async t=>{
  const f=await fixture(t),event=f.input(),request=args(f,event);
  await assert.rejects(f.growth.propose(request,event,snapshot=>{snapshot.proposals[0].statement='伪造篡改';return decision(snapshot);}));
  assert.equal(f.growth.read().blank,true);assert.notEqual(request.proposals[0].statement,'伪造篡改');assert.equal(f.growth.history().proposals[0].status,'failed');
});

test('auxiliary review selects supported low effort without changing the main conversation route',async()=>{
  const config={provider:'route',model:'model',reasoningEffort:'high'},agent={id:'session-1',session:{requestHeader:()=>({config})}};let captured;
  const llm={resolveModelInfo:async()=>({reasoning:{efforts:[{id:'low'},{id:'high'}]}}),async *stream(options){captured=options;yield{type:'block-end',block:{type:'text',text:'{"decisions":[]}'}};yield{type:'finish',reason:{kind:'stop'}};}};
  const result=await reviewGrowth(llm,agent,{proposals:[]});assert.equal(captured.reasoningEffort,'low');assert.equal(captured.maxTokens,8192);assert.equal(config.reasoningEffort,'high');assert.equal(result.reasoningEffort,'low');
});
