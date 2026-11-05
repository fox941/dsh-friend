import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const project=process.env.AI_FRIEND_PROJECT_ROOT??fileURLToPath(new URL('../',import.meta.url));
const source=process.env.FRIEND_ADAPTER_SOURCE??path.join(project,'plugins/companion-adapter/src');
const module=name=>import(pathToFileURL(path.join(source,name)));
const {CorrectionController}=await module('controller.js'),{GrowthController}=await module('growth.js'),{PreviewController}=await module('preview.js'),{ApplicationController}=await module('apply.js'),{RuntimeWriter}=await module('apply-runtime.js'),{ApplyBackend}=await module('apply-backend.js'),{hash}=await module('validation.js'),{attachApplications}=await module('apply-agent.js');
const require=createRequire(path.join(project,'runtime/dev/dsh-home/profiles/web/package.json'));
const {createRuntimeMemorySource}=await import(pathToFileURL(require.resolve('dsh-mnemon-source-runtime')));
const old='纸桥活动当前约定周六15:00集合，取件暗号松塔246810。',updated='纸桥活动当前约定周日16:00集合，取件暗号松塔246810。';
const message='现在把纸桥活动的集合约定改为周日下午四点，暗号不变。请先生成报告，等我要求应用时再实际写入。';
const time=Date.parse('2026-10-27T03:00:00Z');
class Native{
  constructor(){this.rows=new Map();this.version=0;this.writes=0;this.oldId=crypto.randomUUID();this.rows.set(this.oldId,{id:this.oldId,content:old,category:'context',importance:3,tags:[],entities:[],source:'user',created_at:new Date(time).toISOString()});}
  assertStore(store){if(store!=='default')throw new Error('wrong store');}
  async show(_store,id,signal){signal?.throwIfAborted();const row=this.rows.get(id);return row&&!row.deleted?structuredClone(row):null;}
  showReadOnly(...args){return this.show(...args);}
  findExact(_store,content){return [...this.rows.values()].find(row=>!row.deleted&&row.content===content)?.id??null;}
  readRevision(){return String(this.version);}
  async remember(_store,content,metadata,_step,signal){signal?.throwIfAborted();const existing=this.findExact('default',content);if(existing)return {id:existing,action:'skipped'};const id=crypto.randomUUID();this.rows.set(id,{...metadata,id,content,created_at:new Date(time+this.version+1).toISOString()});this.version++;this.writes++;if(this.addAckLost){this.addAckLost=false;throw new Error('Native add acknowledgment lost');}return {id,action:'added'};}
  async forget(_store,id,signal){signal?.throwIfAborted();this.rows.get(id).deleted=true;this.version++;if(this.forgetAckLost){this.forgetAckLost=false;throw new Error('forget acknowledgment lost');}}
}
function persistence(workspace,sourceText=message){
  const sourceEvent={seq:1,time,data:{id:'source-message',source:{kind:'user'},content:[{type:'text',text:sourceText}]},type:'user/message'};
  const rows=new Map([['source-session',{header:{id:'source-session',createdAt:time,cwd:workspace,agentPreset:'companion',isSeeded:false},events:[{seq:0,time,type:'turn/start',data:{turn:1}},sourceEvent,{seq:2,time:time+1,type:'assistant/message',data:{message:{content:[{type:'text',text:'明白，先把约定变化作为整理依据。'}]}}},{seq:3,time:time+2,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]}],['command-session',{header:{id:'command-session',createdAt:time+10,cwd:workspace,agentPreset:'companion',isSeeded:false},events:[]}]]);
  return {rows,async flush(){},async list(){return [...rows.values()].map(row=>({header:row.header,eventCount:row.events.length}));},async open(id,mode){assert.equal(mode,'read');const row=rows.get(id);if(!row)throw new Error('missing source');return {header:row.header,read:async(offset,length)=>({events:structuredClone(row.events.slice(offset,offset+length))}),close:async()=>{}};}};
}
async function fixture(t,{self=false,action='temporal_change',applicationConfig={},sourceText=message,critical=false}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-apply-test-')),memoryDir=path.join(directory,'memory'),workspace=path.join(directory,'workspace');await fs.mkdir(workspace);
  const native=new Native(),state={writeEnabled:true,calls:0},clock={now:time};
  const policy=()=>({enabled:true,writeEnabled:state.writeEnabled,previewRuntimeSupported:true,spaces:[{id:'default',active:true,name:'测试空间'}],runtimeLimits:{memoryLimitBytes:10240,userLimitBytes:4096}});
  const persisted=persistence(workspace,sourceText);let correction,growth,preview,runtime,backend,app;
  const open=()=>{
    correction=new CorrectionController({directory,client:native,policy,memoryDir});growth=new GrowthController({journal:correction.journal,serial:(fn,signal)=>correction.serial(fn,signal),now:()=>new Date(clock.now)});
    runtime=new RuntimeWriter({memoryDir,policy,createSource:createRuntimeMemorySource});
    const reader={async token(){return hash(JSON.stringify({entries:(await runtime.snapshot()).entries,native:native.version,growth:growth.store.revision()}));},async read(queries){
      const entries=(await runtime.snapshot()).entries,items=entries.map(row=>({id:`runtime:${row.target}:${hash(row.content)}`,kind:'runtime',target:row.target,importance:row.importance,text:row.content,createdAt:row.created_at,updatedAt:row.updated_at,revision:hash(JSON.stringify(row))}));
      for(const row of native.rows.values())if(!row.deleted)items.push({id:`native:default:${row.id}`,kind:'native',storeId:'default',recordId:row.id,text:row.content,createdAt:row.created_at});
      for(const row of growth.read().states)items.push({id:`self:${row.id}`,kind:'self',key:row.key,text:row.statement,status:row.effectiveStatus});
      return {items,queries,coverage:{native:'sampled',nativeIsComplete:false},notices:[],token:await this.token()};
    }};
    preview=new PreviewController({journal:correction.journal,workspace,memoryReader:reader,now:()=>new Date(clock.now)});backend=new ApplyBackend({runtime,correction,growth});
    app=new ApplicationController({journal:correction.journal,preview,backend,memoryReader:reader,growth,policy,workspace,config:applicationConfig,now:()=>new Date(clock.now)});growth.pendingReviewKeys=()=>app.pendingStateKeys();
  };open();
  await runtime.manage('mutate','mutate',{action:'add',target:'memory',content:old,importance:critical?'critical':'normal'});
  if(self){
    const base=growth.store.put({kind:'trait',key:'trait:纸桥联系时间',statement:'我把纸桥计划的周六15点当作联系时间。',status:'tentative',supports:['original-event'],dependsOn:[],reason:'测试夹具中的旧安排。',batchId:'fixture'});
    growth.store.put({kind:'personal_prompt',key:'personal_prompt:current',statement:'纸桥计划周六下午可以问一下进展。',status:'tentative',supports:['original-event'],dependsOn:[base.id],reason:'测试中的旧安排派生偏好。',batchId:'fixture'});
  }
  const sourceRow={id:`event:${hash('source-session:1:user_message')}`,sessionId:'source-session',seq:1,messageId:'source-message',kind:'user_message',occurredAt:new Date(time).toISOString(),text:sourceText,contentHash:hash(sourceText)};
  const memory=await preview.memoryReader.read([]),refs=memory.items.filter(row=>action==='leave_hot'?row.kind==='runtime':row.kind!=='self').map(row=>row.id);
  const snapshot={protocol:'fixture-preview',sources:{sources:[sourceRow],ranges:[{sessionId:'source-session',from:0,upper:4,nextSeq:4}],excluded:[],notices:[],completedTurns:1},memories:memory};
  const report=preview.store.begin('fixture-report',snapshot,6,false).row;preview.store.finish(report.id,'completed',{decision:{summary:'测试提案',proposals:[{action,summary:'核对纸桥安排。',reason:'原话明确更正，需同步旧副本。',evidence:[{sourceId:sourceRow.id,quote:sourceText}],referenceIds:refs}]}});
  const close=async()=>{await app.close();await preview.close();await growth.close();await correction.close();};
  t.after(async()=>{await close();const actual=await fs.realpath(directory),temp=await fs.realpath(os.tmpdir());assert.ok(actual.startsWith(temp+path.sep)&&path.basename(actual).startsWith('friend-apply-test-'));await fs.rm(actual,{recursive:true});});
  return {directory,workspace,memoryDir,native,state,clock,policy,persistence:persisted,source:sourceRow,reportId:report.id,get app(){return app;},get runtime(){return runtime;},get growth(){return growth;},get preview(){return preview;},get backend(){return backend;},get journal(){return correction.journal;},async reopen(){await close();open();},caller(){return {owner:true,sessionId:'command-session',messageId:'apply-command',seq:1,turnStart:0,quote:'应用这份报告。'};}};
}
function plan(frame,{self=true,onlyRuntime=false}={}){
  const evidence=frame.proposals[0].evidence;const operations=frame.memories.items.filter(row=>['runtime','native'].includes(row.kind)&&row.text===old).filter(row=>!onlyRuntime||row.kind==='runtime').map(row=>({kind:row.kind==='runtime'?'runtime_replace':'native_correct',referenceId:row.id,content:updated,evidence}));
  const state=frame.memories.items.find(row=>row.kind==='self'&&row.key==='trait:纸桥联系时间');if(self&&state)operations.push({kind:'review_self',referenceId:state.id,becauseRefs:[operations[0].referenceId],evidence});
  return {decision:{decisions:[{proposalIndex:0,verdict:'apply',timing:'current',reason:'当前约定已更正，保留暗号，复核确实依赖旧时间的状态。',operations}]},provider:'fixture',model:'fixture',usage:{inputTokens:80,outputTokens:60}};
}
const run=(f,review=frame=>plan(frame),args={},signal)=>f.app.run({reportId:f.reportId,...args},f.caller(),f.persistence,frame=>{f.state.calls++;return review(frame);},signal);

test('public Runtime CAS changes the intended entry and keeps unrelated content and metadata',async t=>{
  const f=await fixture(t);await f.runtime.manage('mutate','mutate',{action:'add',target:'user',content:'用户称呼保持原样。',importance:'critical'});const before=(await f.runtime.snapshot()).entries.find(row=>row.target==='user');
  const result=await run(f);assert.equal(result.status,'completed');assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content===updated));assert.deepEqual((await f.runtime.snapshot()).entries.find(row=>row.target==='user'),before);assert.equal(f.native.rows.get(f.native.oldId).deleted,true);
  assert.ok(result.steps.every(step=>step.receipt.verified));assert.ok(f.journal.history('default',undefined,5).some(row=>row.old_content===old&&row.new_content===updated));
});
test('cross-layer correction pauses related self-state and recursively invalidates its dependents without new evidence',async t=>{
  const f=await fixture(t,{self:true});const before=f.growth.store.head('trait:纸桥联系时间');const result=await run(f);assert.equal(result.status,'completed');const states=f.growth.read().states;assert.ok(states.every(row=>row.status==='needs_review'));assert.equal(f.growth.store.head(before.key).supports.length,before.supports.length);assert.ok(!f.growth.context().includes('周六15点'));assert.ok(f.journal.db.prepare('SELECT count(*) AS n FROM apply_links').get().n>0);
});
test('replay of an applied report does not ask the model or create another fact',async t=>{
  const f=await fixture(t);const first=await run(f),count=f.native.writes;const next=await run(f,()=>{throw new Error('must not review');});assert.equal(next.replayed,true);assert.equal(first.applicationId,next.applicationId);assert.equal(f.state.calls,1);assert.equal(f.native.writes,count);
});
test('a historical completed plan never restores an old value after later editing',async t=>{
  const f=await fixture(t);await run(f);await f.runtime.manage('mutate','mutate',{action:'replace',target:'memory',oldText:updated,content:'纸桥活动后来改为周一上午。'});const again=await run(f);assert.equal(again.status,'historical');assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content.includes('周一')));assert.equal(f.state.calls,1);
});
test('runtime acknowledgment loss is reconciled on retry, preserving the fixed plan and model quota',async t=>{
  const f=await fixture(t,{self:true});const write=f.runtime.write.bind(f.runtime);let fault=true;f.runtime.write=async(...args)=>{const result=await write(...args);if(fault){fault=false;throw new Error('runtime ack lost');}return result;};
  const first=await run(f);assert.equal(first.status,'partial');assert.ok(f.growth.read().states.some(row=>row.effectiveStatus==='pending_memory_review'));assert.ok(!f.growth.context().includes('周六15点'));
  const next=await run(f);assert.equal(next.status,'completed');assert.equal(f.state.calls,1);assert.equal(f.native.writes,1);
});
test('Native forget acknowledgment loss resumes the existing correction after restart',async t=>{
  const f=await fixture(t,{self:true});f.native.forgetAckLost=true;assert.equal((await run(f)).status,'partial');await f.reopen();const done=await run(f);assert.equal(done.status,'completed');assert.equal(f.native.writes,1);assert.equal(f.app.store.calls(),1);
});
test('a changed target before plan preparation is rejected without writing',async t=>{
  const f=await fixture(t);await f.runtime.manage('mutate','mutate',{action:'replace',target:'memory',oldText:old,content:'新的安排已经在别处保存。'});await assert.rejects(run(f),/已变化|失效/);assert.equal(f.native.writes,0);
});
test('context changes during model review mark the audit stale with no writes',async t=>{
  const f=await fixture(t);const result=await run(f,frame=>{f.native.version++;return plan(frame);});assert.equal(result.status,'stale');assert.equal(f.native.writes,0);assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content===old));
});
for(const[label,mutate]of [
  ['invented quotation',value=>{value.decision.decisions[0].operations[0].evidence=[{sourceId:'missing',quote:'fake'}];}],
  ['unsupported operation',value=>{value.decision.decisions[0].operations[0].kind='delete_database';}],
  ['unknown reference',value=>{value.decision.decisions[0].operations[0].referenceId='native:default:missing';}],
  ['future activation',value=>{value.decision.decisions[0].timing='future';}],
  ['inconsistent known copy',value=>{value.decision.decisions[0].operations[1].content='另一份未保持一致的更正。';}],
])test(`application audit rejects ${label} before any effect`,async t=>{
  const f=await fixture(t);await assert.rejects(run(f,frame=>{const value=plan(frame);mutate(value);return value;}));assert.equal(f.native.writes,0);assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content===old));assert.equal(f.app.store.calls(),1);
});

test('one canonical correction deterministically propagates to exact known copies',async t=>{
  const f=await fixture(t);const result=await run(f,frame=>plan(frame,{onlyRuntime:true}));
  assert.equal(result.status,'completed');assert.equal(result.steps.length,2);assert.ok(result.steps.every(step=>step.current===updated));assert.equal(f.native.rows.get(f.native.oldId).deleted,true);
});
test('tampering with the original source is detected even if the report still has valid-looking quotes',async t=>{
  const f=await fixture(t);f.persistence.rows.get('source-session').events[1].data.content[0].text='原消息后来不再匹配。';await assert.rejects(run(f),/原始交流不一致/);assert.equal(f.state.calls,0);
});
test('uncertain and conflicting proposals are recorded as deferred without a model request or writes',async t=>{
  const f=await fixture(t,{action:'conflict'});const result=await run(f,()=>{throw new Error('unexpected');});assert.equal(result.status,'deferred');assert.equal(result.applied,false);assert.equal(f.app.store.calls(),0);assert.equal(f.native.writes,0);
});
test('keep proposals are acknowledged without touching the memory or consuming review budget',async t=>{
  const f=await fixture(t,{action:'keep'});const result=await run(f);assert.equal(result.status,'completed');assert.equal(result.applied,false);assert.equal(f.state.calls,0);assert.equal(f.app.store.calls(),0);
});
test('read-only policy prevents new application but retains readable history',async t=>{
  const f=await fixture(t);const done=await run(f);f.state.writeEnabled=false;await assert.rejects(run(f),/不允许/);assert.equal((await f.app.read(done.applicationId)).status,'completed');
});
test('cancellation stops an uncooperative reviewer without applying later output',async t=>{
  const f=await fixture(t);const stop=new AbortController();let entered;const ready=new Promise(resolve=>entered=resolve);
  const pending=run(f,()=>{entered();return new Promise(()=>{});},{},stop.signal);await ready;stop.abort();await assert.rejects(pending);assert.equal(f.native.writes,0);assert.equal(f.app.store.recent()[0].status,'cancelled');await f.reopen();assert.equal(f.app.store.calls(),1);
});
test('frozen model input cannot change the targets that will be committed',async t=>{
  const f=await fixture(t);await assert.rejects(run(f,frame=>{frame.memories.items[0].text='tampered';return plan(frame);}));assert.equal(f.native.writes,0);
});
test('a SQL error during self-state propagation rolls back all self changes and keeps the verified facts',async t=>{
  const f=await fixture(t,{self:true});const states=f.growth.store.heads().map(row=>row.id);f.journal.db.exec("CREATE TRIGGER reject_review BEFORE INSERT ON growth_versions WHEN NEW.status='needs_review' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  const partial=await run(f);assert.equal(partial.status,'partial');assert.deepEqual(f.growth.store.heads().map(row=>row.id),states);assert.ok(f.growth.read().states.every(row=>row.effectiveStatus==='pending_memory_review'));
  f.journal.db.exec('DROP TRIGGER reject_review');assert.equal((await run(f)).status,'completed');assert.equal(f.state.calls,1);
});
test('a later self-state revision is not overwritten by a delayed application',async t=>{
  const f=await fixture(t,{self:true});const write=f.runtime.write.bind(f.runtime);let changed=false;
  f.runtime.write=async(...args)=>{const result=await write(...args);if(!changed){changed=true;const state=f.growth.store.head('trait:纸桥联系时间');f.growth.store.put({...state,statement:'我已经重新理解了联系时间。',batchId:'new-dialogue'});f.growth.store.advanceRevision();}return result;};
  const result=await run(f);assert.equal(result.status,'partial');assert.equal(f.growth.store.head('trait:纸桥联系时间').statement,'我已经重新理解了联系时间。');
});
test('explicit proposal arrays are not mutated and the review budget survives restart',async t=>{
  const f=await fixture(t,{applicationConfig:{dailyCallLimit:1}});await run(f,undefined,{proposalIndexes:Object.freeze([0])});await f.reopen();assert.equal(f.app.store.calls(),1);assert.equal((await run(f)).replayed,true);
});
test('public Runtime CAS refuses a race after planning rather than dropping unrelated writes',async t=>{
  const f=await fixture(t);const manage=f.runtime.manage.bind(f.runtime);let raced=false;
  f.runtime.manage=async(mode,operation,input,signal)=>{const result=await manage(mode,operation,input,signal);if(operation==='maintenance-plan'&&!raced){raced=true;await manage('mutate','mutate',{action:'add',target:'user',content:'前台并发新增资料。'});}return result;};
  const result=await run(f);assert.equal(result.status,'partial');assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content==='前台并发新增资料。'));assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content===old));
});
test('application tools still require a direct owner and exact current request',async()=>{
  const tools=new Map(),ctx={tools:{register:row=>tools.set(row.name,row)},systemPrompt:{section(){},context(){}}};attachApplications(ctx,{applications:{config:{}},preview:{}});
  await assert.rejects(tools.get('friend_memory_apply').execute({reportId:crypto.randomUUID(),requestQuote:'应用报告。'},{agent:{session:{header:{origin:'subagent'}}}}),/主用户/);
});
function single(frame,operation){return {decision:{decisions:[{proposalIndex:0,verdict:'apply',timing:'current',reason:'依据真实原话，使用已核对的目标和回执。',operations:[{...operation,evidence:frame.proposals[0].evidence}]}]}};}
const experience='测试中用户作出一次更改集合约定的决定。';
test('Native additions reconcile a lost acknowledgment without adding another row',async t=>{
  const f=await fixture(t,{action:'supplement'});f.native.addAckLost=true;
  const compile=frame=>single(frame,{kind:'native_add',target:'event',storeId:'default',content:experience});
  const first=await run(f,compile);assert.equal(first.status,'partial');const writes=f.native.writes;await f.reopen();
  const next=await run(f,compile);assert.equal(next.status,'completed');assert.equal(f.native.writes,writes);assert.equal([...f.native.rows.values()].filter(row=>!row.deleted&&row.content===experience).length,1);assert.equal(f.app.store.calls(),1);
});
test('an uncertain Native add is not replayed after a later change removed its original result',async t=>{
  const f=await fixture(t,{action:'supplement'});f.native.addAckLost=true;
  const compile=frame=>single(frame,{kind:'native_add',target:'event',storeId:'default',content:experience});await run(f,compile);
  const id=f.native.findExact('default',experience);await f.native.forget('default',id);const before=f.native.writes;const result=await run(f,compile);assert.equal(result.status,'partial');assert.match(result.error,/拒绝盲目/);assert.equal(f.native.writes,before);assert.equal(f.native.findExact('default',experience),null);
});
test('Runtime addition acknowledgment loss is reconciled without another model request',async t=>{
  const f=await fixture(t,{action:'supplement'}),write=f.runtime.write.bind(f.runtime);let fault=true;
  f.runtime.write=async(...args)=>{const result=await write(...args);if(fault){fault=false;throw new Error('addition ack lost');}return result;};
  const compile=frame=>single(frame,{kind:'runtime_add',target:'memory',content:experience});assert.equal((await run(f,compile)).status,'partial');assert.equal((await run(f,compile)).status,'completed');assert.equal(f.app.store.calls(),1);
});
test('a removed unknown Runtime addition is not silently recreated even if the old JSON content was restored',async t=>{
  const f=await fixture(t,{action:'supplement'}),write=f.runtime.write.bind(f.runtime);let fault=true;
  f.runtime.write=async(...args)=>{const result=await write(...args);if(fault){fault=false;throw new Error('addition ack lost');}return result;};
  const compile=frame=>single(frame,{kind:'runtime_add',target:'memory',content:experience});await run(f,compile);
  await f.runtime.manage('mutate','mutate',{action:'remove',target:'memory',oldText:experience});const result=await run(f,compile);assert.equal(result.status,'partial');assert.match(result.error,/拒绝盲目/);assert.ok(!(await f.runtime.snapshot()).entries.some(row=>row.content===experience));
});
test('working-memory demotion verifies the full Native copy before removing the hot entry',async t=>{
  const f=await fixture(t,{action:'leave_hot',sourceText:'这项工作已经完成，不用继续放在常驻工作记忆，保留原文经历。'});
  const compile=frame=>single(frame,{kind:'runtime_archive',referenceId:frame.memories.items.find(row=>row.kind==='runtime').id,storeId:'default'});
  const result=await run(f,compile);assert.equal(result.status,'completed');assert.ok(!(await f.runtime.snapshot()).entries.some(row=>row.content===old));assert.ok(f.native.findExact('default',old));assert.ok(result.steps[0].receipt.archiveVerified);
});
test('demotion can stop after copying and resume without deleting unverified source data',async t=>{
  const f=await fixture(t,{action:'leave_hot',sourceText:'这项工作完成了，只移出常驻，保留原始内容。'}),write=f.runtime.write.bind(f.runtime);let fault=true;
  f.runtime.write=async(...args)=>{if(fault){fault=false;throw new Error('source removal unavailable');}return write(...args);};
  const compile=frame=>single(frame,{kind:'runtime_archive',referenceId:frame.memories.items.find(row=>row.kind==='runtime').id,storeId:'default'});
  const first=await run(f,compile);assert.equal(first.status,'partial');assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content===old));assert.ok(f.native.findExact('default',old));const next=await run(f,compile);assert.equal(next.status,'completed');assert.equal(f.app.store.calls(),1);
});
test('critical working-memory rules cannot be demoted by this first implementation',async t=>{
  const f=await fixture(t,{action:'leave_hot',critical:true});await assert.rejects(run(f,frame=>single(frame,{kind:'runtime_archive',referenceId:frame.memories.items.find(row=>row.kind==='runtime').id,storeId:'default'})),/关键约定/);assert.ok((await f.runtime.snapshot()).entries.some(row=>row.content===old));
});
