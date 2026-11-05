import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import {fixture,module,old,updated} from './protection-fixture.mjs';
const {ConversationMemoryController,conversationSource}=await module('conversation-memory.js');
const {attachConversationMemory,UNMANAGED_MEMORY_WRITES}=await module('conversation-agent.js');
const {reviewConversationMemory}=await module('conversation-reviewer.js');
const {databaseHash}=await module('protection-sql.js'),{undoBatch}=await module('protection-undo.js');
const stamp=Date.parse('2026-10-28T04:00:00Z');

async function dailyFixture(t,options={}){
  const f=await fixture(t,options),authority=Object.freeze({});f.app.conversationAuthority=authority;
  const daily=new ConversationMemoryController({applications:f.app,backend:f.backend,memoryReader:f.app.memoryReader,workspace:f.workspace,authority,config:options.dailyConfig});
  const rows=new Map();let agent,turn=0,calls=0;
  function next(message,overrides={}){
    turn++;const id=`daily-session-${turn}`,events=[{seq:0,time:stamp+turn,type:'turn/start',data:{turn:1}},{seq:1,time:stamp+turn,type:'user/message',data:{id:`message-${turn}`,source:{kind:'user'},content:[{type:'text',text:message}]}}];
    const header={id,createdAt:stamp+turn,cwd:f.workspace,agentPreset:'companion',isSeeded:false,...overrides};rows.set(id,{header,events});
    agent={id,session:{header,seq:events.length,eventAt:seq=>events[seq]}};return agent;
  }
  const persistence={async flush(){},async open(id,mode){assert.equal(mode,'read');const row=rows.get(id);if(!row)throw new Error('missing daily source');return {header:row.header,read:async(from,count)=>({events:structuredClone(row.events.slice(from,from+count))}),close:async()=>{}};}};
  next('我喜欢无糖乌龙茶，以后也可以记住。');
  return {...f,daily,persistence,rows,next,get agent(){return agent;},get calls(){return calls;},async run(changes,review=compile,signal){return daily.run({changes},agent,persistence,frame=>{calls++;return review(frame);},signal);}};
}
function compile(frame,{self=false,verdict='apply'}={}){
  return {decision:{decisions:frame.proposals.map(proposal=>{
    const r=proposal.request,evidence=proposal.evidence;
    const kind=r.target==='long_term'?(r.action==='add'?'native_add':r.action==='replace'?'native_correct':'native_forget'):(r.action==='add'?'runtime_add':r.action==='replace'?'runtime_replace':'runtime_remove');
    const operation={kind,evidence,...r.referenceId?{referenceId:r.referenceId}:{},...r.action!=='remove'?{content:r.content}:{},...kind==='runtime_add'?{target:r.target}:{},...kind==='native_add'?{target:'event',storeId:r.storeId}:{}};
    const operations=verdict==='apply'?[operation]:[];
    if(self&&verdict==='apply'){const state=frame.memories.items.find(row=>row.kind==='self'&&row.key==='trait:纸桥时间');if(state)operations.push({kind:'review_self',referenceId:state.id,becauseRefs:[r.referenceId],evidence});}
    return {proposalIndex:proposal.index,verdict,timing:verdict==='defer'?'uncertain':'current',reason:'隔离测试审核依据完整原话和当前条目。',operations};
  })},provider:'fixture',model:'fixture'};
}
const addition=(quote='我喜欢无糖乌龙茶，以后也可以记住。',content='用户喜欢无糖乌龙茶。')=>[{action:'add',target:'user',content,evidenceQuote:quote,reason:'用户明确陈述可重复使用的偏好。'}];
async function replacement(f,action='replace',target='memory'){
  const ref=(await f.daily.read()).items.find(row=>row.kind==='runtime'&&row.text===old);
  return [{action,target,referenceId:ref.id,expectedContent:ref.text,expectedVersion:ref.version,...action==='replace'?{content:updated}:{},evidenceQuote:f.agent.session.eventAt(1).data.content[0].text,reason:'用户明确更正或撤回当前约定。'}];
}
const undo=(f,id)=>undoBatch(f.protection,id,{kind:'isolated-daily-undo'},{assertOffline:()=>f.offline()});

test('daily hot addition uses a lightweight verified snapshot, original source and the existing Runtime CAS',async t=>{
  const f=await dailyFixture(t),nativeBefore=await databaseHash(path.join(f.memoryDir,'data/default/mnemon.db'));
  const result=await f.run(addition());assert.equal(result.status,'completed');assert.equal(result.currentlyVerified,true);assert.equal(f.calls,1);
  const entries=(await f.runtime.snapshot()).entries;assert.ok(entries.some(row=>row.content===old));assert.ok(entries.some(row=>row.content==='用户喜欢无糖乌龙茶。'));
  assert.equal(await databaseHash(path.join(f.memoryDir,'data/default/mnemon.db')),nativeBefore);
  const snap=f.protection.store.snapshot(result.applicationId);assert.equal(snap.manifest.tier,'runtime_append');assert.deepEqual(snap.manifest.files.map(row=>row.path),['runtime.json']);
  const record=f.app.store.get(result.applicationId);assert.equal(record.approval.kind,'conversation');assert.equal(record.frame.sources[0].channel,'dsh-direct');assert.equal(record.frame.sources[0].text,'我喜欢无糖乌龙茶，以后也可以记住。');
  assert.ok(record.model.decision);assert.equal(f.app.store.calls(),0);assert.equal(f.app.store.calls('conversation'),1);
});

test('daily reads have no model or memory writes and retain explicit incomplete Native coverage',async t=>{
  const f=await dailyFixture(t),before=await databaseHash(path.join(f.memoryDir,'data/default/mnemon.db'));
  const result=await f.daily.read({references:[`native:default:${f.first.id}`]});assert.equal(f.calls,0);assert.equal(result.coverage.nativeIsComplete,false);assert.ok(result.items.every(row=>row.version));
  assert.equal(await databaseHash(path.join(f.memoryDir,'data/default/mnemon.db')),before);assert.equal(f.app.store.recent().length,0);
});

test('exact duplicates produce no model request, no snapshot and no additional self evidence',async t=>{
  const f=await dailyFixture(t);await f.run(addition());f.next('再说一次，我喜欢无糖乌龙茶，以后也可以记住。');
  const result=await f.run(addition('我喜欢无糖乌龙茶，以后也可以记住。'),()=>{throw new Error('must not review duplicate');});
  assert.equal(result.applied,false);assert.equal(result.status,'completed');assert.equal(f.calls,1);assert.equal(f.protection.store.snapshot(result.applicationId),undefined);assert.equal(f.growth.store.revision(),0);
});

test('a semantic duplicate can be declined without changing storage',async t=>{
  const f=await dailyFixture(t);await f.run(addition());f.next('其实我一直偏好不加糖的乌龙茶。');
  const result=await f.run(addition('我一直偏好不加糖的乌龙茶。','用户偏好不加糖的乌龙茶。'),frame=>compile(frame,{verdict:'noop'}));
  assert.equal(result.applied,false);assert.equal((await f.runtime.snapshot()).entries.filter(row=>row.target==='user').length,1);
});

test('full source context reaches review, including negation outside the selected short quote',async t=>{
  const f=await dailyFixture(t);const original='  我朋友说“我住南京”，这是转述，并不是我的住址。不要把它存成我的资料。  ';f.next(original);
  const result=await f.run(addition('我住南京','用户住南京。'),frame=>{assert.equal(frame.sources[0].text,original);assert.equal(frame.sources[0].contentHash.length,64);return compile(frame,{verdict:'defer'});});
  assert.equal(result.status,'deferred');assert.equal((await f.runtime.snapshot()).entries.some(row=>row.content==='用户住南京。'),false);
});

test('forged evidence, injected messages, other identities and non-companion sessions are rejected',async t=>{
  const f=await dailyFixture(t);await assert.rejects(f.run(addition('伪造原话')),/逐字/);assert.equal(f.calls,0);
  for(const header of [{origin:'subagent'},{isSeeded:true},{agentPreset:'coding'},{cwd:path.dirname(f.workspace)},{parentSession:'parent'}]){
    f.next('我喜欢无糖乌龙茶，以后也可以记住。',header);assert.throws(()=>conversationSource(f.agent,f.workspace));
  }
  f.next('我喜欢无糖乌龙茶，以后也可以记住。');f.agent.session.eventAt(1).data.source.principal={kind:'qq-user'};assert.throws(()=>conversationSource(f.agent,f.workspace));
  f.next('我喜欢无糖乌龙茶，以后也可以记住。');f.agent.session.eventAt(1).sourceEventSeqs=[8];assert.throws(()=>conversationSource(f.agent,f.workspace));
});

test('persistent source tampering fails before any reviewer or write',async t=>{
  const f=await dailyFixture(t),read=f.persistence.open;f.persistence.open=async(...args)=>{const handle=await read(...args);return {...handle,read:async(...params)=>{const result=await handle.read(...params);result.events[0].data.content[0].text='被篡改的来源。';return result;}};};
  await assert.rejects(f.run(addition()),/原始交流不一致/);assert.equal(f.calls,0);
});

test('daily correction synchronizes known Runtime/Native copies and pauses only supported self dependencies',async t=>{
  const f=await dailyFixture(t,{self:true});f.next('现在把纸桥活动改为周日下午四点集合，地点仍是松塔书店。');const before=f.growth.store.head('trait:纸桥时间');
  const result=await f.run(await replacement(f),frame=>compile(frame,{self:true}));assert.equal(result.status,'completed');assert.equal(result.steps.length,3);
  assert.equal(await f.client.showReadOnly('default',f.first.id),null);assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content===updated));assert.ok(f.growth.read().states.every(row=>row.effectiveStatus==='needs_review'));
  assert.equal(f.growth.store.head(before.key).supports.length,before.supports.length);assert.equal(f.protection.store.snapshot(result.applicationId).manifest.tier,'full');
});

test('explicit withdrawal removes known copies from normal recall and offline undo restores original UUID/graph',async t=>{
  const f=await dailyFixture(t);f.next('纸桥集合约定已经取消，请撤回这条约定，不要继续按它安排。');const before=await databaseHash(path.join(f.memoryDir,'data/default/mnemon.db'));
  const result=await f.run(await replacement(f,'remove'));assert.equal(result.status,'completed');assert.equal(await f.client.showReadOnly('default',f.first.id),null);assert.ok(!(await f.runtime.snapshot()).entries.some(row=>row.content===old));
  const view=await f.protection.changes(result.applicationId,{includeSources:true});assert.ok(view.changes.every(row=>row.newValue===null));assert.ok(view.sources[0].text.includes('取消'));
  assert.equal((await undo(f,result.applicationId)).status,'completed');assert.equal(await databaseHash(path.join(f.memoryDir,'data/default/mnemon.db')),before);assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content===old));
  assert.equal((await f.daily.retry(result.applicationId,f.next('请重试刚才的记忆写入。'),'请重试刚才的记忆写入。',f.persistence)).status,'undone');
});

test('lightweight append undo retains unrelated subsequent hot entries',async t=>{
  const f=await dailyFixture(t),first=await f.run(addition());await f.runtime.manage('mutate','mutate',{action:'add',target:'user',content:'用户后来说明偏好步行。'});
  assert.equal((await undo(f,first.applicationId)).status,'completed');const rows=(await f.runtime.snapshot()).entries;
  assert.ok(rows.some(row=>row.content==='用户后来说明偏好步行。'));assert.ok(!rows.some(row=>row.content==='用户喜欢无糖乌龙茶。'));
});

test('a stale read version blocks replacement without asking the reviewer',async t=>{
  const f=await dailyFixture(t);f.next('现在把纸桥活动改为周日下午四点集合，地点仍是松塔书店。');const changes=await replacement(f);changes[0].expectedVersion='0'.repeat(64);
  await assert.rejects(f.run(changes),/版本过期/);assert.equal(f.calls,0);assert.equal(await f.client.showReadOnly('default',f.first.id).then(Boolean),true);
});

test('a concurrent memory change during review marks the attempt stale and preserves the newer record',async t=>{
  const f=await dailyFixture(t);const result=await f.run(addition(),async frame=>{await f.runtime.manage('mutate','mutate',{action:'add',target:'user',content:'另一个请求保存的新事实。'});return compile(frame);});
  assert.equal(result.status,'stale');assert.ok(!(await f.runtime.snapshot()).entries.some(row=>row.content==='用户喜欢无糖乌龙茶。'));assert.equal(f.app.store.calls('conversation'),1);
});

for(const [label,mutate] of [
  ['changed content',value=>{value.decision.decisions[0].operations[0].content='用户喜欢甜咖啡。';}],
  ['changed target',value=>{value.decision.decisions[0].operations[0].target='memory';}],
  ['invented quote',value=>{value.decision.decisions[0].operations[0].evidence[0].quote='不存在的原话';}],
  ['extra operation',value=>{value.decision.decisions[0].operations.push({...value.decision.decisions[0].operations[0],content:'额外无关事实。'});}],
  ['unsupported scope',value=>{value.decision.decisions[0].operations[0].kind='native_forget';value.decision.decisions[0].operations[0].referenceId='unknown';}],
])test(`review cannot silently expand the requested write: ${label}`,async t=>{
  const f=await dailyFixture(t);await assert.rejects(f.run(addition(),frame=>{const value=structuredClone(compile(frame));mutate(value);return value;}));assert.ok(!(await f.runtime.snapshot()).entries.some(row=>row.target==='user'));assert.equal(f.app.store.calls('conversation'),1);
});

test('backup failure stops all writes and explicit retry uses the fixed plan without another review',async t=>{
  const f=await dailyFixture(t),capture=f.protection.snapshots.capture.bind(f.protection.snapshots);f.protection.snapshots.capture=async()=>{throw new Error('isolated storage quota failure');};
  const first=await f.run(addition());assert.equal(first.status,'backup_blocked');assert.ok(!(await f.runtime.snapshot()).entries.some(row=>row.target==='user'));
  f.protection.snapshots.capture=capture;f.next('请继续刚才失败的记忆写入。');const result=await f.daily.retry(first.applicationId,f.agent,'请继续刚才失败的记忆写入。',f.persistence);
  assert.equal(result.status,'completed');assert.equal(f.calls,1);assert.equal(f.app.store.calls('conversation'),1);
});

test('Runtime acknowledgment loss reconciles exactly one write on replay',async t=>{
  const f=await dailyFixture(t),write=f.runtime.write.bind(f.runtime);let once=true;f.runtime.write=async(...args)=>{const result=await write(...args);if(once){once=false;throw new Error('daily lost acknowledgment');}return result;};
  assert.equal((await f.run(addition())).status,'partial');const result=await f.run(addition());assert.equal(result.status,'completed');assert.equal(f.calls,1);assert.equal((await f.runtime.snapshot()).entries.filter(row=>row.target==='user').length,1);
});

test('later modifications turn old completed requests historical instead of restoring old facts',async t=>{
  const f=await dailyFixture(t);await f.run(addition());await f.runtime.manage('mutate','mutate',{action:'replace',target:'user',oldText:'用户喜欢无糖乌龙茶。',content:'用户后来改为只喝白水。'});
  const result=await f.run(addition());assert.equal(result.status,'historical');assert.equal(f.calls,1);assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content==='用户后来改为只喝白水。'));
});

test('conversation quota is persistent, separate from nightly/manual quota and does not reset by recreating the controller',async t=>{
  const f=await dailyFixture(t,{dailyConfig:{dailyCallLimit:1}});await f.run(addition());f.next('我喜欢步行，以后可以记住。');
  await assert.rejects(f.run(addition('我喜欢步行，以后可以记住。','用户喜欢步行。')),/额度/);assert.equal(f.calls,1);assert.equal(f.app.store.calls(),0);
  assert.equal(f.daily.status().callsRemaining,0);assert.equal(f.app.store.calls('conversation'),1);
});

test('daily and manual/nightly application share one active execution gate',async t=>{
  const f=await dailyFixture(t);let release,entered;const ready=new Promise(resolve=>entered=resolve),pause=new Promise(resolve=>release=resolve);
  const first=f.run(addition(),async frame=>{entered();await pause;return compile(frame);});await ready;
  assert.equal((await f.apply()).status,'busy');assert.equal((await f.run(addition())).status,'busy');release();assert.equal((await first).status,'completed');assert.equal(f.calls,1);
});

test('disabled daily writing cannot fall back to the old unprotected route',async t=>{
  const f=await dailyFixture(t,{dailyConfig:{enabled:false}});await assert.rejects(f.run(addition()),/关闭/);assert.equal(f.calls,0);
});

test('plugin guard denies legacy and generic writes including nested PTC names while preserving reads',async()=>{
  const tools=new Map(),guards=[],restrictions=[];const ctx={tools:{guard:fn=>guards.push(fn),schemas:()=>[{name:'mnemon_remember'},{name:'mnemon_recall'}],restrict:row=>restrictions.push(row),register:row=>tools.set(row.name,row)},systemPrompt:{section(){},context(){}}};
  attachConversationMemory(ctx,{conversations:{config:{},status:()=>({}),workspace:'scope'}});
  assert.deepEqual([...tools.keys()],['friend_memory_read','friend_memory_write','friend_memory_write_retry']);
  assert.deepEqual(restrictions,[{deny:['mnemon_remember']}]);for(const name of UNMANAGED_MEMORY_WRITES)assert.ok(guards[0]({name}));for(const name of ['mnemon_recall','mnemon_view_route','friend_emotion_propose','friend_memory_write','run_code'])assert.equal(guards[0]({name}),undefined);
});

test('conversation reviewer uses one tool-free bounded request with strict terminal output',async()=>{
  let captured;const llm={async *stream(options){captured=options;yield {type:'block-end',block:{type:'text',text:'{"decisions":[]}'}};yield {type:'finish',reason:{kind:'stop'}};}};
  const result=await reviewConversationMemory(llm,{id:'test',options:{provider:'fixture',model:'fixture'}},{sources:[]},undefined,{maxTokens:2048});assert.deepEqual(result.decision,{decisions:[]});assert.equal(captured.tools,undefined);assert.equal(captured.maxTokens,2048);
});

test('historical chat cannot resurrect a withdrawn fact, while a new actual assertion can restore it',async t=>{
  const f=await dailyFixture(t);const earlier=f.next(old);f.next('纸桥集合约定已经取消，请撤回这条约定。');await f.run(await replacement(f,'remove'));
  const oldChanges=[{action:'add',target:'memory',content:old,evidenceQuote:old,reason:'测试旧交流被重新整理。'}];
  const result=await f.daily.run({changes:oldChanges},earlier,f.persistence,compile);
  assert.equal(result.status,'completed');assert.equal(result.applied,false);assert.ok(result.decisions[0].reason.includes('后续纠正或撤回'));assert.ok(!(await f.runtime.snapshot()).entries.some(row=>row.content===old));
  f.next(`现在重新恢复这个约定：${old}`);const fresh=await f.run([{...oldChanges[0],reason:'主用户有新的真实恢复决定。'}]);
  assert.equal(fresh.status,'completed');assert.equal(fresh.applied,true);assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content===old));
});

test('shared application review also filters retired exact text from older nightly evidence',async t=>{
  const f=await dailyFixture(t);const earlier=f.next(old),source=conversationSource(earlier,f.workspace).source;f.next('纸桥集合约定已经取消，请撤回这条约定。');await f.run(await replacement(f,'remove'));
  const frame={authorization:{kind:'nightly'},sources:[source],memories:await f.app.memoryReader.read([]),activeSpaces:[{id:'default'}],proposals:[{index:0,action:'supplement',reason:'重新整理旧交流',evidence:[{sourceId:source.id,quote:old}],referenceIds:[]}]};
  const result=await f.app.reviewFrame({reportId:crypto.randomUUID(),key:crypto.randomUUID(),selection:[0],caller:{kind:'nightly'},frame,reviewer:()=>({decision:{decisions:[{proposalIndex:0,verdict:'apply',timing:'current',reason:'测试审核误提案',operations:[{kind:'runtime_add',target:'memory',content:old,evidence:frame.proposals[0].evidence}]}]}})},new AbortController().signal);
  assert.equal(result.applied,false);assert.equal(result.status,'completed');assert.ok(!(await f.runtime.snapshot()).entries.some(row=>row.content===old));
});

test('cancelled or unrelated current messages cannot continue a pending memory batch',async t=>{
  const f=await dailyFixture(t),capture=f.protection.snapshots.capture.bind(f.protection.snapshots);f.protection.snapshots.capture=async()=>{throw new Error('isolated unavailable');};const first=await f.run(addition());f.protection.snapshots.capture=capture;
  for(const message of ['你好。','不要继续刚才失败的记忆写入。']){f.next(message);assert.throws(()=>f.daily.retry(first.applicationId,f.agent,message,f.persistence),/明确继续/);}
  assert.ok(!(await f.runtime.snapshot()).entries.some(row=>row.target==='user'));
});
