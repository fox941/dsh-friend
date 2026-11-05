import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const source=process.env.FRIEND_ADAPTER_SOURCE??fileURLToPath(new URL('../plugins/companion-adapter/src',import.meta.url));
const load=name=>import(pathToFileURL(path.join(source,name)));
const {Journal}=await load('journal.js');
const {PreviewController}=await load('preview.js');
const {PreviewMemoryReader}=await load('preview-memory.js');
const {NativeClient}=await load('native-client.js');
const {collectPreviewSources}=await load('preview-sessions.js');
const {reviewPreview}=await load('preview-reviewer.js');
const {attachPreview}=await load('preview-agent.js');
const {attachGrowth}=await load('growth-agent.js');

const baseTime=Date.parse('2026-10-27T03:00:00Z');
function makeEvents(turns){
  const events=[];const push=(type,data)=>events.push({seq:events.length,time:baseTime+events.length,type,data});
  turns.forEach((turn,index)=>{
    push('turn/start',{turn:index+1});
    push('user/message',{id:`message-${index+1}`,source:turn.source??{kind:'user'},content:[{type:'text',text:turn.text??'我以前喜欢游戏视频，最近更想看鸟类观察。'}]});
    for(const extra of turn.extra??[])push(extra.type,extra.data);
    push('assistant/message',{turn:index+1,message:{content:[{type:'reasoning',text:'不应复制的隐藏推理'},{type:'text',text:turn.response??'我理解这是一段有时间条件的偏好变化。'}]},...turn.interrupted?{interrupted:true}:{}});
    if(!turn.open)push('turn/end',{turn:index+1,reason:{kind:turn.cancelled?'cancelled':'completed'}});
  });return events;
}
class Persistence{
  constructor(workspace){this.workspace=workspace;this.rows=new Map();this.opened=[];this.reads=[];this.flushed=0;}
  add(id,turns,header={}){this.rows.set(id,{header:{id,cwd:this.workspace,createdAt:baseTime,agentPreset:'companion',isSeeded:false,...header},events:makeEvents(turns)});}
  async flush(){this.flushed++;}
  async list(){return [...this.rows.values()].map(row=>({header:structuredClone(row.header),eventCount:row.events.length}));}
  async open(id,mode){assert.equal(mode,'read');this.opened.push(id);const row=this.rows.get(id);let closed=false;return {header:structuredClone(row.header),read:async(offset,length)=>{assert.equal(closed,false);this.reads.push({id,offset,length});return {events:structuredClone(row.events.slice(offset,offset+length))};},close:async()=>{closed=true;}};}
}
async function fixture(t,config={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-preview-test-')),workspace=path.join(directory,'workspace');await fs.mkdir(workspace);
  const persistence=new Persistence(workspace);persistence.add('session-a',[{}]);
  const state={token:'context-1',calls:0,decisionCalls:0};
  const memory={items:[{id:'runtime:user:old',kind:'runtime',target:'user',text:'10月初喜欢游戏视频。',revision:'r1'},{id:'runtime:memory:task',kind:'runtime',target:'memory',text:'本周核对观鸟活动时间。',revision:'r2'},{id:'self:interest-one',kind:'self',text:'暂时对鸟类观察感到好奇。',stateKind:'interest',status:'tentative',revision:'0'}],coverage:{runtime:'complete',native:'sampled',nativeIsComplete:false},notices:[]};
  const memoryReader={read:async queries=>{state.calls++;return {...structuredClone(memory),queries,token:state.token};},token:async()=>state.token};
  const clock={value:baseTime};let journal,preview;
  const open=()=>{journal=new Journal(directory);preview=new PreviewController({journal,workspace,memoryReader,config,now:()=>new Date(clock.value)});};open();
  t.after(async()=>{await preview.close();if(journal.db.isOpen)journal.close();const actual=await fs.realpath(directory),temp=await fs.realpath(os.tmpdir());assert.ok(actual.startsWith(temp+path.sep)&&path.basename(actual).startsWith('friend-preview-test-'));await fs.rm(actual,{recursive:true});});
  const f={directory,workspace,persistence,state,memory,clock,memoryReader,get journal(){return journal;},get preview(){return preview;},caller(){return {owner:true,sessionId:'session-a',turnStart:persistence.rows.get('session-a').events.length};},async reopen(){await preview.close();if(journal.db.isOpen)journal.close();open();}};
  return f;
}
function good(snapshot,overrides={}){
  const entry=snapshot.sources.sources.find(row=>row.kind==='user_message');
  return {decision:{summary:'仅预演：保留过去偏好，核对当前变化；未提交任何修改。',proposals:[{action:'temporal_change',summary:'保留10月初的历史，同时复核最近的偏好变化。',reason:'有真实原话及旧资料，适用时间仍需保留。',evidence:[{sourceId:entry.id,quote:entry.text}],referenceIds:['runtime:user:old'],...overrides}]},usage:{inputTokens:100,outputTokens:80,totalTokens:180},provider:'fixture',model:'fixture'};
}
const run=(f,review=snapshot=>good(snapshot),args={},signal)=>f.preview.run(args,f.caller(),f.persistence,review,signal);

test('preview output defaults to 8192 but preserves a deliberately smaller explicit budget',async t=>{const f=await fixture(t);assert.equal(f.preview.config.maxTokens,8192);const explicit=await fixture(t,{maxTokens:4096});assert.equal(explicit.preview.config.maxTokens,4096);});

test('canonical toolCallId observations and legacy callId observations retain their exact original sources',async t=>{for(const field of ['toolCallId','callId']){const f=await fixture(t);f.persistence.add('session-a',[{extra:[{type:'tool/call',data:{callId:'read-1',name:'bili_subtitle'}},{type:'tool/result',data:{message:{[field]:'read-1',content:[{type:'text',text:'片段原文：章鱼躲回洞穴。'}],isError:false}}}]}]);const result=await run(f);const items=f.preview.read(result.reportId,true).sources.filter(x=>x.kind==='tool_observation');assert.equal(items.length,1);assert.equal(items[0].text,'片段原文：章鱼躲回洞穴。');assert.equal(items[0].seq,3);}});

test('conflicting result identifiers, failed results and internal writes cannot become new observations',async t=>{const f=await fixture(t);f.persistence.add('session-a',[{extra:[{type:'tool/call',data:{callId:'read-1',name:'bili_subtitle'}},{type:'tool/call',data:{callId:'write-1',name:'friend_memory_record'}},{type:'tool/result',data:{message:{toolCallId:'read-1',callId:'other',content:[{type:'text',text:'冲突来源'}]}}},{type:'tool/result',data:{message:{toolCallId:'read-1',isError:true,content:[{type:'text',text:'失败结果'}]}}},{type:'tool/result',data:{message:{toolCallId:'write-1',content:[{type:'text',text:'内部状态写入'}]}}}]}]);const result=await run(f);assert.equal(f.preview.read(result.reportId,true).sources.filter(x=>x.kind==='tool_observation').length,0);});

test('preview has separate schema, empty history and no autonomous model work',async t=>{
  const f=await fixture(t);assert.equal(f.preview.status().automatic,false);assert.equal(f.preview.read().status,'no_report');assert.equal(f.preview.store.budget(),0);assert.equal(f.state.calls,0);
  assert.equal(f.journal.db.prepare('SELECT count(*) AS n FROM adapter_corrections').get().n,0);
});
test('completed report has exact provenance and writes only preview tables',async t=>{
  const f=await fixture(t);const result=await run(f);
  assert.equal(result.status,'completed');assert.equal(result.applied,false);assert.equal(result.proposals[0].evidence[0].quote,f.persistence.rows.get('session-a').events[1].data.content[0].text);
  assert.ok(result.sources.every(row=>!('text'in row)));assert.ok(f.preview.read(result.reportId,true).sources.some(row=>row.text));assert.equal(f.preview.store.budget(),1);
  assert.equal(f.journal.db.prepare('SELECT count(*) AS n FROM adapter_corrections').get().n,0);assert.equal(f.journal.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='insights'").get().n,0);
});
test('source scope excludes unrelated workspaces, presets, forks and delegated sessions',async t=>{
  const f=await fixture(t);for(const[id,header]of [['other',{cwd:path.join(f.workspace,'other')}],['coding',{agentPreset:'default'}],['child',{origin:'subagent'}],['fork',{isSeeded:true}],['depth',{delegationDepth:1}]])f.persistence.add(id,[{}],header);
  const result=await run(f,undefined,{scope:'companion'});assert.equal(result.status,'completed');assert.deepEqual(f.persistence.opened,['session-a']);
});
test('optional event counts are handled by a bounded public snapshot',async t=>{
  const f=await fixture(t);f.persistence.add('session-b',[{text:'没有目录计数时仍应读到的真实交流。'}]);
  const original=f.persistence.list.bind(f.persistence);f.persistence.list=async()=>{const rows=await original();return rows.map(({header})=>({header}));};
  const result=await run(f,undefined,{scope:'companion'});assert.equal(result.status,'completed');const full=f.preview.read(result.reportId,true);assert.ok(full.sources.some(row=>row.sessionId==='session-b'));assert.ok(f.persistence.reads.every(row=>row.length<=f.preview.config.maxScannedEvents));
});
test('source attribution rejects synthetic recall, other principals and hidden reasoning',async t=>{
  const f=await fixture(t);f.persistence.add('session-a',[{source:{kind:'compaction'},text:'摘要声称永远喜欢游戏。'},{source:{kind:'user',principal:'other'},text:'别人的资料。'},{text:'这是主用户真实表达。'}]);
  const result=await run(f,snapshot=>{const input=JSON.stringify(snapshot.sources);assert.ok(!input.includes('摘要声称')&&!input.includes('别人的资料')&&!input.includes('隐藏推理'));return good(snapshot);});assert.equal(result.status,'completed');assert.ok(result.excluded.some(row=>/身份/.test(row.reason)));
});
test('unfinished turns are not consumed and maintenance turns never form new evidence',async t=>{
  const f=await fixture(t);f.persistence.add('session-a',[{extra:[{type:'tool/call',data:{callId:'preview-1',name:'friend_memory_preview',arguments:'{}'}}]},{open:true,text:'尚未结束的对话。'}]);
  const result=await run(f,()=>{throw new Error('must not call reviewer');});assert.equal(result.status,'empty');assert.equal(f.preview.store.budget(),0);assert.ok(result.excluded.some(row=>/预演/.test(row.reason)));
  assert.equal(result.sourceProgress[0].waitingForTurn,true);assert.equal(f.preview.store.cursors()['session-a'].nextSeq,5);
});
test('secret-shaped or oversized messages are omitted without copying their content',async t=>{
  const f=await fixture(t);const credential='sk-'+crypto.randomBytes(20).toString('hex');f.persistence.add('session-a',[{text:credential},{text:'很长'.repeat(4000)},{text:'这里是可以处理的交流。'}]);
  const result=await run(f);const stored=JSON.stringify(f.preview.store.get(result.reportId));assert.ok(!stored.includes(credential));assert.ok(result.excluded.some(row=>/凭据/.test(row.reason)));assert.ok(result.excluded.some(row=>/过长/.test(row.reason)));
});
test('turn budget pauses at complete boundaries and a later run processes only the remaining event',async t=>{
  const f=await fixture(t,{maxTurns:1});f.persistence.add('session-a',[{text:'第一个阶段偏好。'},{text:'第二个不同的阶段偏好。'}]);
  const first=await run(f);assert.equal(first.sourceProgress[0].nextSeq,4);assert.equal(first.sourceProgress[0].limited,true);
  const second=await run(f);assert.ok(f.preview.read(second.reportId,true).sources.some(row=>row.text==='第二个不同的阶段偏好。'));assert.ok(!f.preview.read(second.reportId,true).sources.some(row=>row.text==='第一个阶段偏好。'));
});
for(const[name,change]of [
  ['invented quotation',row=>{row.evidence[0].quote='并未说过的原话';}],
  ['unknown old record',row=>{row.referenceIds=['native:other:unknown'];}],
  ['assistant-only evidence',(row,snapshot)=>{const item=snapshot.sources.sources.find(row=>row.kind==='assistant_response');row.evidence=[{sourceId:item.id,quote:item.text}];}],
  ['user profile eviction',row=>{row.action='leave_hot';}],
  ['self review without a self record',row=>{row.action='review_self';}],
])test(`grounding refuses ${name} without advancing progress`,async t=>{
  const f=await fixture(t);await assert.rejects(run(f,snapshot=>{const value=good(snapshot);change(value.decision.proposals[0],snapshot);return value;}));assert.deepEqual(f.preview.store.cursors(),{});assert.equal(f.preview.store.budget(),1);assert.equal(f.preview.store.list()[0].status,'failed');
});
test('a repeat with no new exchange does not invoke a model or replace the prior report',async t=>{
  const f=await fixture(t);let calls=0;const first=await run(f,snapshot=>{calls++;return good(snapshot);});const next=await run(f,()=>{calls++;throw new Error('unexpected');});assert.equal(next.status,'no_new_events');assert.equal(calls,1);assert.equal(f.preview.read().reportId,first.reportId);
});
test('review failure preserves evidence, persists quota and can be explicitly retried after restart',async t=>{
  const f=await fixture(t);await assert.rejects(run(f,()=>{throw new Error('temporary failure');}));const id=f.preview.store.list()[0].id;await f.reopen();assert.equal(f.preview.store.budget(),1);assert.deepEqual(f.preview.store.cursors(),{});
  const done=await run(f);assert.equal(done.reportId,id);assert.equal(done.attempts,2);assert.equal(f.preview.store.budget(),2);assert.equal(f.journal.db.prepare('SELECT count(*) AS n FROM preview_attempts').get().n,2);
});
test('cancellation returns even when the reviewer ignores abort and cannot later commit',async t=>{
  const f=await fixture(t);const stop=new AbortController();let entered;const ready=new Promise(resolve=>entered=resolve);
  const pending=run(f,()=>{entered();return new Promise(()=>{});},{},stop.signal);await ready;stop.abort();await assert.rejects(pending);assert.equal(f.preview.store.list()[0].status,'cancelled');assert.deepEqual(f.preview.store.cursors(),{});assert.equal(f.preview.store.budget(),1);await f.preview.close();
});
test('changed context marks a stale report and keeps the source cursor for another review',async t=>{
  const f=await fixture(t);const first=await run(f,snapshot=>{f.state.token='context-2';return good(snapshot);});assert.equal(first.status,'stale');assert.deepEqual(f.preview.store.cursors(),{});const second=await run(f);assert.equal(second.status,'completed');assert.notEqual(second.reportId,first.reportId);
});
test('concurrent source progress cannot be overwritten by an old review',async t=>{
  const f=await fixture(t);await assert.rejects(run(f,snapshot=>{f.journal.db.prepare('INSERT INTO preview_cursors VALUES(?,?,?)').run('session-a',1,new Date().toISOString());return good(snapshot);}));assert.equal(f.preview.store.cursors()['session-a'].nextSeq,1);assert.equal(f.preview.store.list()[0].status,'failed');
});
test('a database failure rolls back every session cursor in one completed batch',async t=>{
  const f=await fixture(t);f.persistence.add('session-b',[{text:'第二个会话的新交流。'}]);f.journal.db.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON preview_cursors WHEN NEW.session_id='session-b' BEGIN SELECT RAISE(ABORT,'fixture fault'); END;");
  await assert.rejects(run(f,undefined,{scope:'companion'}));assert.deepEqual(f.preview.store.cursors(),{});assert.equal(f.preview.store.list()[0].status,'failed');
});
test('quota is persistent across restart and rolls over at Shanghai midnight',async t=>{
  const f=await fixture(t,{dailyCallLimit:1});f.clock.value=Date.parse('2026-10-27T15:59:59Z');await run(f);await f.reopen();assert.equal((await run(f)).status,'budget_exhausted');f.clock.value+=2000;assert.equal(f.preview.store.budget(),0);assert.equal((await run(f)).status,'no_new_events');
});
test('one active preview prevents duplicate concurrent model work',async t=>{
  const f=await fixture(t);let release,entered;const ready=new Promise(resolve=>entered=resolve);const pending=run(f,async snapshot=>{entered();await new Promise(resolve=>release=resolve);return good(snapshot);});await ready;assert.equal((await run(f)).status,'busy');release();await pending;assert.equal(f.preview.store.budget(),1);
});
test('a reviewer cannot mutate frozen input or smuggle unsupported output fields',async t=>{
  const f=await fixture(t);await assert.rejects(run(f,snapshot=>{snapshot.sources.sources[0].text='fake';return good(snapshot);}));assert.deepEqual(f.preview.store.cursors(),{});
  await assert.rejects(run(f,snapshot=>({...good(snapshot),decision:{...good(snapshot).decision,sql:'DROP TABLE growth_heads'}})));assert.deepEqual(f.preview.store.cursors(),{});
});
test('interrupted attempts become inspectable on reopen without automatic model calls',async t=>{
  const f=await fixture(t);const snapshot={sources:{sources:[],ranges:[],excluded:[],notices:[]},memories:{items:[]}};f.preview.store.begin('interrupted-fixture',snapshot,6,true);await f.reopen();assert.equal(f.preview.store.list()[0].status,'interrupted');assert.equal(f.preview.store.budget(),1);assert.equal(f.state.calls,0);
});
test('structured preview uses low auxiliary reasoning without changing main routing and rejects truncation',async()=>{
  let request;const llm={resolveModelInfo:async()=>({reasoning:{efforts:[{id:'low'}]}}),async *stream(options){request=options;yield {type:'block-end',block:{type:'text',text:'{"summary":"无变化","proposals":[]}'}};yield {type:'finish',reason:{kind:'stop'}};}};
  const config={provider:'fixture',model:'fixture',reasoningEffort:'high'},agent={id:'test',session:{requestHeader:()=>({config})}};
  const response=await reviewPreview(llm,agent,{sources:[]});assert.equal(response.decision.proposals.length,0);assert.equal(request.reasoningEffort,'low');assert.equal(config.reasoningEffort,'high');assert.equal(request.tools,undefined);
  llm.stream=async function*(){yield {type:'block-end',block:{type:'text',text:'{"summary":"未完成"'}};yield {type:'finish',reason:{kind:'max-tokens'}};};await assert.rejects(reviewPreview(llm,agent,{}),/未完成/);
});
test('preview guard blocks subsequent writes, allows reads, and releases on the next user turn',async t=>{
  const f=await fixture(t),tools=new Map(),guards=[];const events=makeEvents([{}]);const agent={id:'session-a',session:{header:{},get seq(){return events.length;},eventAt:seq=>events[seq]}};
  const ctx={tools:{guard:fn=>guards.push(fn),register:tool=>tools.set(tool.name,tool)},systemPrompt:{section(){}}};attachPreview(ctx,{preview:f.preview});
  assert.equal(guards[0]({name:'friend_memory_preview',agent}),undefined);assert.match(guards[0]({name:'mnemon_runtime_memory',agent}),/预演/);assert.match(guards[0]({name:'friend_state_propose',agent}),/预演/);assert.equal(guards[0]({name:'friend_state_read',agent}),undefined);
  for(let i=0;i<1001;i++)events.push({seq:events.length,type:'metadata',data:{}});assert.match(guards[0]({name:'friend_state_propose',agent}),/预演/);
  events.push({seq:events.length,type:'turn/start',data:{turn:2}});assert.equal(guards[0]({name:'friend_state_propose',agent}),undefined);
  const foreign={id:'foreign',session:{header:{origin:'subagent'},seq:0,eventAt(){}}};await assert.rejects(tools.get('friend_memory_preview_read').execute({}, {agent:foreign,signal:new AbortController().signal}),/主用户/);
});
test('growth after-response hook is suppressed in a protected preview turn',async()=>{
  let calls=0,hook;const growth={config:{},afterResponse:async()=>{calls++;}};
  const ctx={systemPrompt:{section(){},context(){}},tools:{register(){}},on:(_name,fn)=>{hook=fn;}};
  attachGrowth(ctx,{growth,preview:{isProtectedTurn:()=>true}});await hook({agent:{},signal:new AbortController().signal});assert.equal(calls,0);
});
test('Native read-only recall and Runtime format reads leave stored bytes and access counters unchanged',async t=>{
  const f=await fixture(t),project=process.env.AI_FRIEND_PROJECT_ROOT??fileURLToPath(new URL('../',import.meta.url)),memoryDir=path.join(f.directory,'memory'),runtimeDir=path.join(memoryDir,'runtime');await fs.mkdir(runtimeDir,{recursive:true});
  const file=path.join(runtimeDir,'memories.json');await fs.writeFile(file,JSON.stringify({version:1,entries:[{target:'user',content:'用户周末看鸟类观察视频。',importance:'normal',created_at:'2026-10-01',updated_at:'2026-10-01'}]}));
  const binary=path.join(project,'.tools/mnemon-0.2.13/mnemon.exe'),env={...process.env,MNEMON_MAX_INSIGHTS:'0',MNEMON_EMBED_ENDPOINT:'http://127.0.0.1:9'};delete env.DEEPSEEK_API_KEY;
  execFileSync(binary,['--data-dir',memoryDir,'--store','default','remember','--cat','fact','--imp','3','--source','test-fixture','--','纸桥观鸟活动在周六清晨开始。'],{env,windowsHide:true,stdio:'pipe'});
  const require=createRequire(path.join(project,'runtime/dev/dsh-home/profiles/web/package.json')),runtimeContract=await import(pathToFileURL(require.resolve('dsh-mnemon-source-runtime/contracts')));
  const policy=()=>({enabled:true,writeEnabled:true,previewRuntimeSupported:true,spaces:[{id:'default',active:true}],cliPath:binary});
  const growth={store:{revision:()=>0},read:()=>({revision:0,states:[]})},client=new NativeClient({memoryDir,policy}),reader=new PreviewMemoryReader({memoryDir,client,policy,runtimeContract,growth});
  const db=path.join(memoryDir,'data/default/mnemon.db'),before=await fs.readFile(db),beforeRuntime=await fs.readFile(file);const output=await reader.read(['纸桥']);assert.ok(output.items.some(row=>row.kind==='native'&&row.text.includes('周六清晨')));assert.equal(output.changedDuringRead,false);assert.deepEqual(await fs.readFile(db),before);assert.deepEqual(await fs.readFile(file),beforeRuntime);
});

function repairReviewer(f,{change=()=>{},repairChange=()=>{},initialHook=()=>{},repairHook=()=>{}}={}){
 let saved;const calls=[];const review=async(snapshot,signal)=>{calls.push('initial');saved=good(snapshot);change(saved.decision);await initialHook(snapshot,signal);return saved;};
 review.repair=async(request,signal)=>{calls.push('repair');assert(Object.isFrozen(request.snapshot));assert.equal(request.problem.code,'PREVIEW_SCHEMA_INVALID');const fixed=good(request.snapshot);repairChange(fixed.decision);await repairHook(request,signal);return fixed;};return {review,calls};
}
test('one structure correction is durable, separately audited, budgeted twice and never contaminates approved output',async t=>{
 const f=await fixture(t),r=repairReviewer(f,{change:d=>d.proposals[0].evidence=d.proposals[0].evidence[0]});const result=await run(f,r.review);assert.equal(result.status,'completed');assert.deepEqual(r.calls,['initial','repair']);assert.equal(f.preview.store.budget(),2);assert.equal(result.attempts,1);
 const phases=result.attemptDiagnostics[0].reviewPhases;assert.deepEqual(phases.map(p=>[p.phase,p.status]),[['initial','invalid'],['repair','validated']]);assert(!JSON.stringify(result).includes('unvalidatedDecision'));assert.equal(phases[0].problem.issues[0].path,'proposals.0.evidence');assert(f.preview.read(result.reportId,true).attemptDiagnostics[0].reviewPhases[0].unvalidatedDecision);assert(!JSON.stringify(f.preview.store.get(result.reportId).result).includes('unvalidatedDecision'));
 await f.reopen();assert.equal(f.preview.store.budget(),2);assert.equal(f.preview.read(result.reportId,true).attemptDiagnostics[0].reviewPhases.length,2);
});
test('a second malformed output stops after exactly two calls and leaves source cursors unchanged',async t=>{
 const f=await fixture(t),r=repairReviewer(f,{change:d=>d.proposals[0].action='keep|defer',repairChange:d=>d.proposals[0].referenceIds='wrong'});await assert.rejects(run(f,r.review),e=>e.code==='PREVIEW_SCHEMA_INVALID');assert.deepEqual(r.calls,['initial','repair']);assert.equal(f.preview.store.budget(),2);assert.deepEqual(f.preview.store.cursors(),{});assert.equal(f.preview.read().attemptDiagnostics[0].reviewPhases[1].status,'invalid');
});
for(const [label,change]of [['unfounded quote',d=>d.proposals[0].evidence[0].quote='不存在的原话'],['secret',d=>d.proposals[0].secret='sk-'+'q'.repeat(25)],['oversized text',d=>d.proposals[0].summary='过'.repeat(501)]])test('unsafe preview does not trigger correction: '+label,async t=>{
 const f=await fixture(t),r=repairReviewer(f,{change});await assert.rejects(run(f,r.review));assert.deepEqual(r.calls,['initial']);assert.deepEqual(f.preview.store.cursors(),{});if(label==='secret')assert(!JSON.stringify(f.preview.read(undefined,true)).includes('sk-'));
});
test('repair refuses to change meaningful text and preserves the failed original',async t=>{
 const f=await fixture(t),r=repairReviewer(f,{change:d=>d.proposals[0].referenceIds='runtime:user:old',repairChange:d=>d.proposals[0].summary='不同的建议'});await assert.rejects(run(f,r.review),e=>e.code==='PREVIEW_GROUNDING_INVALID');assert.deepEqual(f.preview.store.cursors(),{});assert(f.preview.read(undefined,true).attemptDiagnostics[0].reviewPhases.every(p=>p.unvalidatedDecision));
});
test('repair quota cannot bypass the preview daily limit',async t=>{
 const f=await fixture(t,{dailyCallLimit:1}),r=repairReviewer(f,{change:d=>d.proposals[0].referenceIds='runtime:user:old'});await assert.rejects(run(f,r.review),e=>e.code==='PREVIEW_BUDGET');assert.deepEqual(r.calls,['initial']);assert.equal(f.preview.read().attemptDiagnostics[0].reviewPhases[0].repairSkipped,'preview_model_budget');assert.equal(f.preview.store.budget(),1);
});
test('changed memory before correction yields stale without a second model call',async t=>{
 const f=await fixture(t),r=repairReviewer(f,{change:d=>d.proposals[0].referenceIds='runtime:user:old',initialHook:()=>{f.state.token='changed';}});assert.equal((await run(f,r.review)).status,'stale');assert.deepEqual(r.calls,['initial']);assert.deepEqual(f.preview.store.cursors(),{});
});
test('changed memory during correction does not advance source cursors',async t=>{
 const f=await fixture(t),r=repairReviewer(f,{change:d=>d.proposals[0].referenceIds='runtime:user:old',repairHook:()=>{f.state.token='changed';}});assert.equal((await run(f,r.review)).status,'stale');assert.deepEqual(r.calls,['initial','repair']);assert.deepEqual(f.preview.store.cursors(),{});
});
test('ignored cancellation during correction cannot commit its late result',async t=>{
 const f=await fixture(t),stop=new AbortController();let release;const r=repairReviewer(f,{change:d=>d.proposals[0].referenceIds='runtime:user:old',repairHook:()=>new Promise(done=>{release=done;})});const task=run(f,r.review,{},stop.signal);while(!release)await new Promise(r=>setImmediate(r));stop.abort(Error('cancel correction'));await assert.rejects(task,/cancel correction/);release();await new Promise(r=>setImmediate(r));assert.deepEqual(f.preview.store.cursors(),{});assert.equal(f.preview.read().status,'cancelled');assert.equal(f.preview.store.budget(),2);
});
test('initial and correction share one overall timeout',async t=>{
 const f=await fixture(t,{timeoutMs:1000}),r=repairReviewer(f,{change:d=>d.proposals[0].referenceIds='runtime:user:old',initialHook:()=>new Promise(r=>setTimeout(r,600)),repairHook:()=>new Promise(r=>setTimeout(r,600))});const start=Date.now();await assert.rejects(run(f,r.review),e=>e.code==='PREVIEW_TIMEOUT');assert(Date.now()-start<1600);assert.deepEqual(f.preview.store.cursors(),{});
});
test('truncated and syntactically invalid responses cannot request an extra model call',async t=>{
 for(const code of ['STRUCTURED_INCOMPLETE','STRUCTURED_JSON_INVALID']){const f=await fixture(t);let repaired=0;const reviewer=()=>{throw Object.assign(Error('invalid JSON'),{code,rawOutput:'{'})};reviewer.repair=()=>{repaired++;};await assert.rejects(run(f,reviewer));assert.equal(repaired,0);assert.equal(f.preview.store.budget(),1);}
});
test('legacy reports without phase audits remain readable',async t=>{
 const f=await fixture(t),result=await run(f);f.journal.db.prepare('UPDATE preview_attempts SET result_json=NULL WHERE run_id=?').run(result.reportId);assert.deepEqual(f.preview.read(result.reportId).attemptDiagnostics[0].reviewPhases,[]);
});

test('manual preview attaches the same-route repair callback and progress without releasing its write guard',async()=>{
 const events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'user/message',data:{id:'owner-request',source:{kind:'user'},content:[{type:'text',text:'预演整理记忆。'}]}}],tools=new Map(),guards=[];let captured,calls=0,route={provider:'fixture',model:'first'};
 const agent={id:'manual-session',options:route,session:{header:{},seq:2,eventAt:n=>events[n],requestHeader:()=>({config:route})}},preview={config:{maxTokens:8192},protectTurn(){this.protected=true;},isProtectedTurn(){return this.protected;},async run(_args,_caller,_persistence,reviewer){captured=reviewer;return {status:'captured'};}};
 const llm={async *stream(o){calls++;assert.equal(o.maxTokens,8192);assert.equal(o.tools,undefined);yield{type:'block-end',block:{type:'text',text:'{"summary":"仅建议","proposals":[]}'}};yield{type:'finish',reason:{kind:'stop'}};}};
 attachPreview({llm,tools:{guard:fn=>guards.push(fn),register:tool=>tools.set(tool.name,tool)},systemPrompt:{section(){}}},{preview});await tools.get('friend_memory_preview').execute({requestQuote:'预演整理记忆。'},{agent,signal:new AbortController().signal});assert.equal(typeof captured.repair,'function');
 const request={snapshot:{sources:{sources:[]},memories:{items:[]}},previous:{summary:'仅建议',proposals:[]},problem:{code:'PREVIEW_SCHEMA_INVALID'},route:{...route}},progress=[];await captured.repair(request,new AbortController().signal,e=>progress.push(e.phase));assert(progress.includes('parsed'));assert.match(guards[0]({name:'mnemon_runtime_memory',agent}),/预演/);
 route={provider:'fixture',model:'other'};assert.throws(()=>captured.repair(request,new AbortController().signal),e=>e.code==='PREVIEW_ROUTE_CHANGED');assert.equal(calls,1);
});
test('repair input envelope is bounded independently of the initial snapshot',async t=>{
 const {previewInputCharacters,previewRepairInputCharacters}=await load('preview-reviewer.js'),f=await fixture(t);let repaired=0;const reviewer=snapshot=>{const value=good(snapshot);value.decision.proposals[0].evidence=value.decision.proposals[0].evidence[0];const initial=previewInputCharacters(snapshot),repair=previewRepairInputCharacters({snapshot,previous:value.decision,problem:{code:'PREVIEW_SCHEMA_INVALID'}});assert(repair>initial);f.preview.config.maxInputChars=initial;return value;};reviewer.repair=()=>{repaired++;};await assert.rejects(run(f,reviewer),e=>e.code==='PREVIEW_SCHEMA_INVALID');assert.equal(repaired,0);assert.equal(f.preview.read().attemptDiagnostics[0].reviewPhases[0].repairSkipped,'repair_input_budget');assert.equal(f.preview.store.budget(),1);
});
test('a durable repair reservation cannot be charged twice even before model dispatch',async t=>{
 const f=await fixture(t),snapshot={sources:{sources:[],ranges:[]},memories:{items:[]}},row=f.preview.store.begin('reservation-test',snapshot,6,true).row;f.preview.store.reserveRepair(row.id,6);assert.equal(f.preview.store.budget(),2);assert.throws(()=>f.preview.store.reserveRepair(row.id,6),/最多一次/);assert.equal(f.preview.store.budget(),2);await f.reopen();assert.equal(f.preview.read(row.id).status,'interrupted');assert.equal(f.preview.read(row.id).attemptDiagnostics[0].reviewPhases[0].status,'reserved');assert.equal(f.preview.store.budget(),2);
});
