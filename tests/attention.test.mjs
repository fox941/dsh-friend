import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const source=process.env.FRIEND_ADAPTER_SOURCE??path.resolve(import.meta.dirname,'../plugins/companion-adapter/src');
const bsource=process.env.FRIEND_BILIBILI_SOURCE??path.resolve(import.meta.dirname,'../plugins/bilibili-tool/src'),bload=n=>import(pathToFileURL(path.join(bsource,n)));
const load=name=>import(pathToFileURL(path.join(source,name)));
const {Journal}=await load('journal.js'),{AttentionController}=await load('attention.js'),{bilibiliAttentionCapability}=await bload('attention-capability.js'),{validateAttention}=await load('attention-reviewer.js'),{attachAttentionHost}=await load('attention-host.js');
const answer=(action='rest',targetId=null,updates=[])=>({decision:{action,targetId,reason:'依据当前真实活动作出本次选择',updates,suggestions:[]}});
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-attention-')),journal=new Journal(directory),clock={time:Date.parse('2026-10-28T08:00:00Z')},frames=[],executions=[];
  let attention=new AttentionController({journal,now:()=>new Date(clock.time)}),choice=frame=>answer('start',frame.candidates[0].id);
  const host={snapshot:async()=>({stateRevision:1,currentActivity:{kind:'browse'},self:{identityId:'same-role'}}),review:async(frame,signal)=>{frames.push(frame);return choice(frame,signal);},execute:async row=>{executions.push(row.id);return {status:'executed'};}};
  attention.bind(host);
  t.after(async()=>{await attention.close();journal.close();const real=await fs.realpath(directory),temp=await fs.realpath(os.tmpdir());assert.ok(real.startsWith(temp+path.sep)&&path.basename(real).startsWith('friend-attention-'));await fs.rm(real,{recursive:true});});
  return {journal,clock,frames,executions,host,get attention(){return attention;},choose(fn){choice=fn;},offer(key='qq-message',kind='message'){return attention.offer({key,kind,scope:kind==='bilibili'?'public':'owner',summary:'这是一条普通问题，可以自主选择是否回应',payload:{message:{id:key,source:{kind:'user'},content:[{type:'text',text:'你怎么看？'}]},sessionId:'same-session',turn:1}});},async reopen(){await attention.close();attention=new AttentionController({journal,now:()=>new Date(clock.time)});attention.bind(host);}};
}

test('ordinary questions can be dismissed without replying or treating silence as failure',async t=>{
  const f=await fixture(t);f.choose(frame=>answer('continue',null,[{id:frame.candidates[0].id,action:'dismiss',reason:'选择继续当前阅读'}]));
  const row=f.offer();assert.equal(await f.attention.admit({key:row.event_key,kind:row.kind,scope:row.scope,summary:row.summary,payload:row.payload}),false);
  assert.equal(f.attention.store.get(row.id).status,'dismissed');await f.attention.tick();assert.equal(f.frames.length,1);assert.equal(f.executions.length,0);
});
test('defer persists the original input and wakes a new decision with fresh state, never a stored response draft',async t=>{
  const f=await fixture(t),row=f.offer();f.choose(frame=>answer('continue',null,[{id:row.id,action:'defer',reason:'读完这一段后再考虑',wake:{kind:'time',afterSeconds:60}}]));
  await f.attention.choose();assert.equal(f.attention.store.get(row.id).status,'waiting');assert.equal(f.attention.store.get(row.id).payload.message.content[0].text,'你怎么看？');
  f.host.snapshot=async()=>({stateRevision:2,currentActivity:null});f.choose(frame=>answer('start',frame.candidates[0].id));
  f.clock.time+=61000;await f.attention.tick();await Promise.all(f.attention.work.values());assert.equal(f.frames[1].stateRevision,2);assert.equal(f.executions.length,1);
});
test('task completion and state changes can wake parked considerations without imposing a timer',async t=>{
  const f=await fixture(t),row=f.offer();f.choose(()=>answer('continue',null,[{id:row.id,action:'defer',reason:'活动结束再考虑',wake:{kind:'task_end'}}]));await f.attention.choose();
  f.attention.signal('state_change');assert.equal(f.attention.store.get(row.id).status,'waiting');f.attention.signal('task_end');assert.equal(f.attention.store.get(row.id).status,'pending');
});
test('restart retains message identity, sender scope and wake condition, without automatically executing it',async t=>{
  const f=await fixture(t),row=f.offer();f.choose(()=>answer('rest',null,[{id:row.id,action:'defer',reason:'等新事件',wake:{kind:'event'}}]));await f.attention.choose();const before=f.attention.store.get(row.id);await f.reopen();const after=f.attention.store.get(row.id);
  assert.deepEqual(after.payload,before.payload);assert.equal(after.scope,'owner');assert.equal(after.status,'waiting');assert.equal(f.executions.length,0);
});
test('a new event during a model decision invalidates the old choice before any execution',async t=>{
  const f=await fixture(t);let release;f.choose(frame=>new Promise(resolve=>{release=()=>resolve(answer('start',frame.candidates[0].id));}));f.offer('first');const choice=f.attention.choose();while(!release)await new Promise(resolve=>setTimeout(resolve,1));f.offer('second','bilibili');release();assert.equal(await choice,null);assert.equal(f.executions.length,0);assert.equal(f.journal.db.prepare("SELECT count(*) n FROM attention_decisions WHERE status='stale'").get().n,1);
});
test('parallel wake calls share one model decision',async t=>{
  const f=await fixture(t);let release;f.choose(frame=>new Promise(resolve=>{release=()=>resolve(answer('start',frame.candidates[0].id));}));f.offer();const a=f.attention.choose(),b=f.attention.choose();while(!release)await new Promise(resolve=>setTimeout(resolve,1));release();assert.equal((await a).id,(await b).id);assert.equal(f.frames.length,1);
});
test('model failures are visible errors and cooled down, not fabricated intentional silence',async t=>{
  const f=await fixture(t),row=f.offer();f.choose(()=>{throw new Error('synthetic model outage');});assert.equal(await f.attention.choose(),null);assert.equal(f.attention.store.get(row.id).status,'pending');assert.match(f.attention.status().lastError,/outage/);await f.attention.tick();assert.equal(f.frames.length,1);
});
test('only enumerated candidate IDs and valid wake conditions are accepted',()=>{
  assert.throws(()=>validateAttention(answer('start','unknown').decision,['known']),/候选/);
  assert.throws(()=>validateAttention(answer('rest',null,[{id:'known',action:'defer',reason:'later',wake:{kind:'time',afterSeconds:1}}]).decision,['known']),/时间/);
  assert.throws(()=>validateAttention({...answer('rest').decision,suggestions:[{kind:'send_private',topic:'secret',reason:'not a capability'}]},['known']),/意图/);
});
test('completed message work is not sent again on repeated completion notifications',async t=>{
  const f=await fixture(t),row=f.offer();assert.equal(await f.attention.admit({key:row.event_key,kind:row.kind,scope:row.scope,summary:row.summary,payload:row.payload}),true);f.attention.finishMessage('same-session',1,{status:'completed'});f.attention.finishMessage('same-session',1,{status:'completed'});assert.equal(f.attention.store.get(row.id).status,'completed');assert.equal(f.executions.length,0);
});
test('the same global candidate set includes different channels with their original scopes',async t=>{
  const f=await fixture(t),qq=f.offer('qq','message'),bili=f.offer('bili','bilibili');f.choose(()=>answer('start',bili.id));assert.equal((await f.attention.choose()).id,bili.id);assert.deepEqual(f.frames[0].candidates.map(r=>[r.id,r.scope]),[[qq.id,'owner'],[bili.id,'public']]);
});

test('Web pre-step parking happens before reply generation and preserves the identified original',async t=>{
  const f=await fixture(t),handlers=new Map(),effects=[];const agent={id:'web-original',session:{header:{id:'web-original',agentPreset:'companion',cwd:'C:/friend-workspace'},seq:0,eventAt:()=>null},inbox:{nextTurn:[],nextStep:[]}};
  const adapter={attention:f.attention,workspace:'C:/friend-workspace',growth:{store:{revision:()=>0},emotions:{store:{revision:()=>0},context:()=>({})},context:()=>({})},activities:{active:null},nightly:{active:null},preview:{},qq:{store:{state(){throw new Error('Web must not mutate QQ');}}}};
  const services={agents:{get:()=>agent},agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},sessionPersistence:{flush:async()=>{}},llm:{}};
  const bound={...services,get:name=>services[name],on:(name,fn)=>handlers.set(name,fn),effect:fn=>effects.push(fn)};
  attachAttentionHost({inject:(_names,fn)=>fn(bound)},adapter);
  f.attention.host.review=async frame=>answer('rest',null,[{id:frame.candidates[0].id,action:'defer',reason:'稍后再看',wake:{kind:'task_end'}}]);
  const message={id:'original-message-id',role:'user',source:{kind:'user'},content:[{type:'text',text:'现在方便聊吗？'}]};let replyGeneration=0;
  const decision=await handlers.get('agent/pre-step')({agent,messages:[message],turn:1,step:1,signal:new AbortController().signal},async()=>{replyGeneration++;return {kind:'enter',messages:[message]};});
  assert.deepEqual(decision,{kind:'reject'});assert.equal(replyGeneration,0);const row=f.attention.store.byKey('message:web-original:original-message-id');assert.deepEqual(row.payload.message,message);assert.equal(row.status,'waiting');
});

test('an unavailable execution resource parks the choice for fresh consideration instead of sending later automatically',async t=>{
  const f=await fixture(t),row=f.offer();f.host.beforeStart=async()=>({waiting:true,wake:{kind:'task_end'},reason:'当前不可中断步骤未完成'});
  assert.equal(await f.attention.admit({key:row.event_key,kind:row.kind,scope:row.scope,summary:row.summary,payload:row.payload}),false);assert.equal(f.attention.store.get(row.id).status,'waiting');assert.equal(f.executions.length,0);
  f.attention.signal('task_end');f.host.beforeStart=async()=>{};f.choose(()=>answer('rest',null,[{id:row.id,action:'dismiss',reason:'状态变化后决定不回应'}]));await f.attention.tick();assert.equal(f.attention.store.get(row.id).status,'dismissed');assert.equal(f.executions.length,0);
});
test('new input while preparing a switch prevents an outdated decision from entering expression',async t=>{
  const f=await fixture(t),row=f.offer();f.host.beforeStart=async()=>{f.offer('arrived-during-switch');};assert.equal(await f.attention.admit({key:row.event_key,kind:row.kind,scope:row.scope,summary:row.summary,payload:row.payload}),false);assert.equal(f.attention.store.get(row.id).status,'pending');assert.equal(f.executions.length,0);
});
test('host cancellation closes parked message considerations without deleting their original content',async t=>{
  const f=await fixture(t),row=f.offer();f.attention.cancelSession('same-session');assert.equal(f.attention.store.get(row.id).status,'cancelled');assert.equal(f.attention.store.get(row.id).payload.message.id,'qq-message');await f.attention.tick();assert.equal(f.frames.length,0);
});

test('restoring a Web consideration follows the public DSH setup callback contract',async t=>{
  const f=await fixture(t),header={id:'restore-web',agentPreset:'companion',cwd:'C:/restored-friend'},sent=[],agent={session:{header,seq:0,eventAt:()=>null},inbox:{nextTurn:[],nextStep:[]},followup:message=>sent.push(message)};
  const adapter={attention:f.attention,workspace:header.cwd,qq:{binding:null},activities:{active:null},nightly:{active:null},growth:{store:{revision:()=>0},emotions:{store:{revision:()=>0},context:()=>({})},context:()=>({})}};
  let mounted=0,resumed=0;
  const services={agents:{get:()=>null,resume:async options=>{resumed++;const setupResult=await options.setup({});assert.equal(setupResult,undefined,'DSH treats a returned object as an optional setup transaction with commit()');return {agent,dispose:async()=>{}};}},agentPresets:{mount:async()=>{mounted++;return {aMountedPreset:true};}},agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},sessionPersistence:{stat:async()=>({header}),flush:async()=>{}},llm:{}};
  const bound={get:name=>services[name],on(){},effect(){}};attachAttentionHost({inject:(_names,fn)=>fn(bound)},adapter);
  const row=f.attention.offer({key:'restore-web:one',kind:'message',scope:'owner',summary:'原会话的暂缓输入',payload:{sessionId:header.id,message:{id:'preserved',source:{kind:'user'},content:[{type:'text',text:'原话'}]}}});
  assert.equal((await f.attention.host.execute(row,new AbortController().signal)).pending,true);assert.equal(resumed,1);assert.equal(mounted,1);assert.equal(sent[0].id,'preserved');
});

test('a busy Bilibili executor cannot silently complete an unprocessed inbound event',async t=>{
  const f=await fixture(t),event={id:'original-bili',status:'queued',payload:{text:'原始消息'}};
  const adapter={attention:f.attention,workspace:'C:/busy-fixture',qq:{binding:null},activities:{active:null},nightly:{active:null},growth:{store:{revision:()=>0},emotions:{store:{revision:()=>0},context:()=>({})},context:()=>({})},bilibiliInbox:{store:{event:()=>event}},bilibiliSocial:{store:{due(){},db:{prepare:()=>({get:()=>null})}},drive:async()=>{}}};adapter.attentionCapabilities=[bilibiliAttentionCapability(adapter)];
  const services={agents:{},agentDefaultModel:{currentSelection:()=>({})},sessionPersistence:{},llm:{}};attachAttentionHost({inject:(_names,fn)=>fn({get:name=>services[name],on(){},effect(){}})},adapter);
  const row=f.attention.offer({key:'busy-bili',kind:'bilibili',scope:'public',summary:'原始消息',payload:{eventId:event.id}});
  assert.equal((await f.attention.host.execute(row,new AbortController().signal)).pending,true);assert.equal(f.attention.store.get(row.id).status,'waiting');assert.equal(event.status,'queued');
});
