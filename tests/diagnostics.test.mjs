import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire,registerHooks} from 'node:module';
const source=process.env.FRIEND_ADAPTER_SOURCE??path.resolve(import.meta.dirname,'../runtime/dev/dsh-home/profiles/web/node_modules/@ai-friend/companion-adapter/src');
// DSH's launcher resolves Harness peers. Standalone tests use that same pinned installation.
const project=process.env.AI_FRIEND_PROJECT_ROOT??path.resolve(import.meta.dirname,'..');
const coreRequire=createRequire(await fs.realpath(path.join(project,'node_modules/@deepseek-ai/dsh/package.json')));
const coreUrl=pathToFileURL(coreRequire.resolve('@deepseek-ai/dsh-llm')).href;
registerHooks({resolve(specifier,context,next){return specifier==='@deepseek-ai/dsh-llm'?{url:coreUrl,shortCircuit:true}:next(specifier,context);}});
const {markAgentLoopRequest}=await import(coreUrl);
const load=name=>import(pathToFileURL(path.join(source,name)));
const {Journal}=await load('journal.js'),{Diagnostics,diagnosticUsage}=await load('diagnostics.js'),{readDiagnostics}=await load('diagnostics-report.js');
const {AttentionController}=await load('attention.js'),{GrowthController}=await load('growth.js'),{attachDiagnosticsHost}=await load('diagnostics-host.js');
const {reviewStructured}=await load('structured-review.js'),{attachAttentionAgent}=await load('attention-agent.js');
const {withDiagnosticContext}=await load('diagnostic-context.js');
async function fixture(t,config={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-diagnostics-')),journal=new Journal(directory),clock={time:Date.parse('2026-10-29T03:00:00Z'),mono:0},now=()=>new Date(clock.time);
  let diagnostics=new Diagnostics({journal,now,monotonic:()=>clock.mono,config}),attention=new AttentionController({journal,now,diagnostics});
  const growth=new GrowthController({journal,now,serial:fn=>Promise.resolve().then(fn)});
  t.after(async()=>{await attention.close();await growth.close();diagnostics.close();journal.close();const real=await fs.realpath(directory),temp=await fs.realpath(os.tmpdir());assert.ok(real.startsWith(temp+path.sep)&&path.basename(real).startsWith('friend-diagnostics-'));await fs.rm(real,{recursive:true});});
  const f={directory,journal,clock,now,growth,get diagnostics(){return diagnostics;},get attention(){return attention;},reopen(){diagnostics.close();diagnostics=new Diagnostics({journal,now,monotonic:()=>clock.mono,config});attention=new AttentionController({journal,now,diagnostics});},offer(key='one'){return attention.offer({key,kind:'message',scope:'owner',summary:'真实待考虑事项',payload:{}});},read(options){return diagnostics.read(options);}};
  return f;
}
const chunks=(usage={inputTokens:10,outputTokens:4})=>[{type:'block-end',block:{type:'text',text:'{"ok":true}'}},...usage?[{type:'usage',usage}]:[],{type:'finish',reason:{kind:'stop'}}];
const handoff=(id='call-1',name='friend_activity_status')=>[{type:'block-end',block:{type:'tool-call',id,name,arguments:'{"private":"do-not-store-input"}'}},{type:'finish',reason:{kind:'tool-calls'}}];
const toolEvent=(f,type,seq,callId='call-1',extra={})=>({type,seq,time:f.clock.time,data:type==='tool/call'?{callId,name:'friend_activity_status',arguments:'do-not-store-input',...extra}:{message:{toolCallId:callId,isError:false,content:[{type:'text',text:'do-not-store-tool-output'}],...extra}}});

test('tool handoff is distinct from completion and failures without changing streamed objects',async t=>{const f=await fixture(t),events=handoff();assert.deepEqual(await consume(f,events),events);const r=f.read();assert.equal(r.costs[0].handoffs,1);assert.equal(r.costs[0].failures,0);assert.equal(r.costs[0].unsuccessful,0);assert.equal(r.modelCalls[0].status,'handoff');assert.equal(r.modelCalls[0].kind,null);assert.equal(r.tools.recent.length,0);});

test('real tool result errors stay separate from a successful model handoff',async t=>{const f=await fixture(t),session={header:{id:'s'}};await consume(f,handoff(),{stage:'expression'},{sessionId:'s'});f.diagnostics.sessionEvent(session,toolEvent(f,'tool/call',2));f.diagnostics.sessionEvent(session,toolEvent(f,'tool/result',3,'call-1',{isError:true}));const r=f.read();assert.equal(r.modelCalls[0].status,'handoff');assert.equal(r.costs[0].failures,0);assert.equal(r.tools.recent[0].status,'failed');assert.equal(r.tools.recent[0].kind,'tool_error');assert.equal(r.tools.recent[0].modelCallId,r.modelCalls[0].id);assert(!JSON.stringify(r).includes('do-not-store'));});

test('successful tool result is not described as sent, approved or fully completed conversation',async t=>{const f=await fixture(t),s={header:{id:'s'}};f.diagnostics.sessionEvent(s,toolEvent(f,'tool/call',2));f.diagnostics.sessionEvent(s,toolEvent(f,'tool/result',3));const r=f.read().tools.recent[0];assert.equal(r.status,'completed');assert.equal(r.source,'call_and_result');assert(r.notice.includes('不证明'));assert.equal(r.modelCallId,null);});

test('consumer stopping on a finish chunk remains incomplete and the source is not drained',async t=>{const f=await fixture(t);let resumed=false;for await(const c of f.diagnostics.observe({provider:'f',model:'m'},async function*(){yield* handoff();resumed=true;},{stage:'expression'})){if(c.type==='finish')break;}const row=f.read().modelCalls[0];assert.equal(row.status,'incomplete');assert.equal(row.kind,'consumer_stopped');assert.equal(resumed,false);});

test('missing tool blocks cannot turn an empty tool-calls finish into a successful handoff',async t=>{const f=await fixture(t);await consume(f,[{type:'finish',reason:{kind:'tool-calls'}}]);assert.equal(f.read().modelCalls[0].status,'incomplete');assert.equal(f.read().modelCalls[0].kind,'missing_tool_call');});

test('an exception after a tool finish remains a real stream failure and propagates',async t=>{const f=await fixture(t),original=Error('private provider exception');await assert.rejects(async()=>{for await(const c of f.diagnostics.observe({provider:'f',model:'m'},async function*(){yield* handoff();throw original;},{stage:'expression'})){}},e=>e===original);assert.equal(f.read().modelCalls[0].status,'failed');assert.equal(f.read().modelCalls[0].kind,'stream_error');});

test('abort signal and provider aborted finish remain cancellations rather than handoffs',async t=>{const f=await fixture(t),stop=new AbortController();stop.abort();await consume(f,handoff(),{stage:'expression'},{signal:stop.signal});await consume(f,[{type:'finish',reason:{kind:'aborted'}}]);assert(f.read().modelCalls.every(r=>r.status==='cancelled'));});

test('max-tokens, provider error and missing finish remain visible with distinct counts',async t=>{const f=await fixture(t);for(const reason of ['max-tokens','error',null])await consume(f,reason?[{type:'finish',reason:{kind:reason}}]:[]);const r=f.read().costs[0];assert.equal(r.limited,1);assert.equal(r.failures,1);assert.equal(r.incomplete,1);assert.equal(r.handoffs,0);});

test('data after finish and duplicate finish cannot be mistaken for normal completion',async t=>{const f=await fixture(t);await consume(f,[...handoff(),{type:'usage',usage:{inputTokens:1,outputTokens:1}}]);await consume(f,[...chunks(),{type:'finish',reason:{kind:'stop'}}]);assert(f.read().modelCalls.every(r=>r.status==='failed'&&r.kind==='stream_protocol'));});

test('legacy failed tool-calls is interpreted read-only without fabricating old tool success',async t=>{const f=await fixture(t);f.journal.db.prepare("INSERT INTO diagnostic_model_calls(id,stage,provider,model,intent_ids,status,started_at,error_kind) VALUES('old-handoff','expression','f','m','[]','failed',?,'tool-calls')").run(f.clock.time);const before=f.journal.db.prepare('SELECT * FROM diagnostic_model_calls').all(),r=f.read();assert.equal(r.modelCalls[0].status,'handoff');assert.equal(r.modelCalls[0].rawStatus,'failed');assert.equal(r.modelCalls[0].rawErrorKind,'tool-calls');assert.equal(r.modelCalls[0].legacyCorrected,true);assert.equal(r.costs[0].legacyHandoffs,1);assert.equal(r.tools.recent.length,0);f.reopen();assert.deepEqual(f.journal.db.prepare('SELECT * FROM diagnostic_model_calls').all(),before);});

test('duplicate tool events are idempotent and an already saved result cannot be overwritten',async t=>{const f=await fixture(t),s={header:{id:'s'}},call=toolEvent(f,'tool/call',2),result=toolEvent(f,'tool/result',3);for(let i=0;i<3;i++){f.diagnostics.sessionEvent(s,call);f.diagnostics.sessionEvent(s,result);}f.diagnostics.sessionEvent(s,toolEvent(f,'tool/result',4,'call-1',{isError:true}));const r=f.read().tools;assert.equal(r.recent.length,1);assert.equal(r.recent[0].status,'completed');});

test('reused call IDs in a later step and in other sessions retain independent actual results',async t=>{const f=await fixture(t);for(const [id,seq,error]of [['a',2,false],['a',5,true],['b',2,false]]){const s={header:{id}};f.diagnostics.sessionEvent(s,toolEvent(f,'tool/call',seq));f.diagnostics.sessionEvent(s,toolEvent(f,'tool/result',seq+1,'call-1',{isError:error}));}assert.equal(f.read().tools.recent.length,3);assert.equal(f.read().tools.recent.filter(r=>r.status==='failed').length,1);});

test('result-only observation remains unlinked and conflicting result identities are ignored',async t=>{const f=await fixture(t),s={header:{id:'s'}};f.diagnostics.sessionEvent(s,toolEvent(f,'tool/result',3));f.diagnostics.sessionEvent(s,toolEvent(f,'tool/result',4,'call-1',{callId:'different'}));const r=f.read().tools.recent;assert.equal(r.length,1);assert.equal(r[0].source,'result_only');assert.equal(r[0].modelCallId,null);assert.equal(r[0].toolName,null);});

test('legacy tool-result callId remains supported when canonical toolCallId is absent',async t=>{const f=await fixture(t),s={header:{id:'s'}};f.diagnostics.sessionEvent(s,toolEvent(f,'tool/call',2));f.diagnostics.sessionEvent(s,toolEvent(f,'tool/result',3,'call-1',{toolCallId:undefined,callId:'call-1'}));assert.equal(f.read().tools.recent[0].source,'call_and_result');});

test('old or mismatched names cannot link a later tool event to a stale model request',async t=>{const f=await fixture(t);await consume(f,handoff(),{stage:'expression'},{sessionId:'s'});f.clock.time+=300001;f.diagnostics.sessionEvent({header:{id:'s'}},toolEvent(f,'tool/call',2));assert.equal(f.read().tools.recent[0].modelCallId,null);await consume(f,handoff('next'),{stage:'expression'},{sessionId:'s'});f.diagnostics.sessionEvent({header:{id:'s'}},toolEvent(f,'tool/call',4,'next',{name:'another_tool'}));assert.equal(f.read().tools.recent[0].modelCallId,null);});

test('hook records only original direct companion tool events and diagnostics faults do not escape',async t=>{const f=await fixture(t),handlers=new Map(),workspace=path.join(f.directory,'workspace');attachDiagnosticsHost({inject:(_names,fn)=>fn({get:()=>({get:()=>null}),on:(name,fn)=>handlers.set(name,fn),effect(){}})},{diagnostics:f.diagnostics,workspace});const hook=handlers.get('session/event'),header={id:'s',cwd:workspace,agentPreset:'companion'};hook({header:{...header,cwd:'elsewhere'}},toolEvent(f,'tool/call',0));assert.equal(f.read().tools.recent.length,0);f.journal.db.exec("CREATE TRIGGER tools_unavailable BEFORE INSERT ON diagnostic_tool_calls BEGIN SELECT RAISE(FAIL,'fixture');END");assert.doesNotThrow(()=>hook({header},toolEvent(f,'tool/call',0)));assert.equal(f.diagnostics.errors,1);});

test('tool records obey retention and row cap without deleting model or actual source records',async t=>{const f=await fixture(t,{retentionDays:7,maxRows:1000}),s={header:{id:'s'}};for(let i=0;i<1005;i++)f.diagnostics.sessionEvent(s,toolEvent(f,'tool/call',i));f.clock.time+=86400000;f.diagnostics.cleanup();assert.equal(f.journal.db.prepare('SELECT count(*) n FROM diagnostic_tool_calls').get().n,1000);f.clock.time+=8*86400000;f.diagnostics.cleanup();assert.equal(f.read().tools.recent.length,0);assert.equal(f.growth.store.revision(),0);});

test('restart records interrupted tool execution and never reexecutes it',async t=>{const f=await fixture(t);f.diagnostics.sessionEvent({header:{id:'s'}},toolEvent(f,'tool/call',2));f.reopen();const r=f.read().tools.recent[0];assert.equal(r.status,'interrupted');assert.equal(r.kind,'process_restart');assert.equal(f.read().modelCalls.length,0);});

test('disabled or closed collector does not capture tool bodies or create metadata',async t=>{const f=await fixture(t,{enabled:false});f.diagnostics.sessionEvent({header:{id:'s'}},toolEvent(f,'tool/call',2));assert.equal(f.read().tools.recent.length,0);f.diagnostics.close();f.diagnostics.sessionEvent({header:{id:'s'}},toolEvent(f,'tool/result',3));assert.equal(f.read().tools.recent.length,0);});

test('old databases without tool metadata are readable without schema initialization',async t=>{const f=await fixture(t);f.journal.db.exec('DROP TABLE diagnostic_tool_calls');const before=f.journal.db.prepare('SELECT total_changes() n').get().n;assert.equal(readDiagnostics(f.journal.db).tools.available,false);assert.equal(f.journal.db.prepare('SELECT total_changes() n').get().n,before);});

test('same call ID in another session never links to the wrong model handoff',async t=>{const f=await fixture(t);await consume(f,handoff(),{stage:'expression'},{sessionId:'a'});f.diagnostics.sessionEvent({header:{id:'b'}},toolEvent(f,'tool/call',2));assert.equal(f.read().tools.recent[0].modelCallId,null);f.diagnostics.sessionEvent({header:{id:'a'}},toolEvent(f,'tool/call',2));assert.equal(f.read().tools.recent[0].modelCallId,f.read().modelCalls[0].id);});

test('normalization never converts cancelled or interrupted records with a legacy finish into handoff',async t=>{const f=await fixture(t);for(const status of ['cancelled','interrupted','incomplete'])f.journal.db.prepare("INSERT INTO diagnostic_model_calls(id,stage,provider,model,intent_ids,status,started_at,error_kind) VALUES(?,'expression','f','m','[]',?,?,'tool-calls')").run(status,status,f.clock.time);const r=f.read();assert.equal(r.costs[0].handoffs,0);assert.equal(r.costs[0].unsuccessful,3);assert(r.modelCalls.every(c=>!c.legacyCorrected));});
test('live progress observes real stream chunks without storing their content and clears on cancellation',async t=>{
  const f=await fixture(t),iterator=f.diagnostics.observe({provider:'fixture',model:'fixture'},async function*(){yield {type:'text-delta',text:'private chunk'};yield {type:'finish',reason:{kind:'stop'}};},{stage:'expression'});
  await iterator.next();assert.equal(f.diagnostics.progress().active.length,1);f.clock.time+=200000;assert.equal(f.diagnostics.progress().active[0].idleMs,200000);await iterator.next();assert.equal(f.diagnostics.progress().active[0].idleMs,0);assert.ok(!JSON.stringify(f.diagnostics.progress()).includes('private chunk'));await iterator.return();assert.equal(f.diagnostics.progress().active.length,0);
});
async function consume(f,events=chunks(),tag={stage:'selection',intentIds:[]},options={}){
  const received=[];const request={provider:'fixture',model:'fixture',messages:[{role:'user',content:[{type:'text',text:'原话内容不应写入统计'}]}],...options};
  for await(const c of f.diagnostics.observe(request,async function*(){for(const c of events){f.clock.mono+=10;yield c;}},tag))received.push(c);
  return received;
}
test('diagnostics begin without inventing historical usage, latency or observed days',async t=>{
  const f=await fixture(t),r=f.read();assert.equal(r.costs.length,0);assert.equal(r.window.historicalCoveragePartial,true);assert.equal(r.window.collectionStartedAt,f.now().toISOString());assert.equal(f.growth.store.revision(),0);
});
test('the observer yields identical chunk objects in the same order and does not make extra requests',async t=>{
  const f=await fixture(t),events=chunks(),received=await consume(f,events);assert.deepEqual(received,events);assert.ok(received.every((r,i)=>r===events[i]));assert.equal(f.read().costs[0].calls,1);assert.equal(f.read().costs[0].latency.p50Ms,30);
});
test('cache counts are disjoint and reasoning tokens are not added to output a second time',async t=>{
  const f=await fixture(t);await consume(f,chunks({inputTokens:10,cacheReadTokens:30,cacheWriteTokens:2,outputTokens:8,reasoningTokens:6}));const r=f.read().costs[0];assert.equal(r.totalTokens,50);assert.equal(r.reasoningTokensDetail,6);assert.equal(r.cacheReadTokens,30);
});
test('missing usage stays unknown rather than becoming a zero-cost request',async t=>{
  const f=await fixture(t);await consume(f,chunks(null));const r=f.read().costs[0];assert.equal(r.usageSamples,0);assert.equal(r.totalTokens,null);assert.equal(r.inputTokens,null);
});
test('several cumulative usage frames use the last report instead of double counting',async t=>{
  const f=await fixture(t);await consume(f,[{type:'usage',usage:{inputTokens:10,outputTokens:1}},...chunks({inputTokens:10,outputTokens:4})]);assert.equal(f.read().costs[0].totalTokens,14);
});
test('zero is a valid reported usage while negative and fractional values are not',()=>{
  assert.equal(diagnosticUsage({inputTokens:0,outputTokens:0}).total,0);assert.equal(diagnosticUsage({inputTokens:-1,outputTokens:1.5}).total,null);assert.equal(diagnosticUsage(undefined),null);
});
test('exceptions retain available usage and propagate the exact original failure',async t=>{
  const f=await fixture(t),original=new Error('provider failed with private detail');
  const stream=f.diagnostics.observe({provider:'fixture',model:'fixture'},async function*(){yield {type:'usage',usage:{inputTokens:5,outputTokens:1}};throw original;},{stage:'emotion'});
  await assert.rejects(async()=>{for await(const _ of stream){}},e=>e===original);const r=f.read().costs[0];assert.equal(r.unsuccessful,1);assert.equal(r.totalTokens,6);assert.ok(!JSON.stringify(f.read()).includes('private detail'));
});
test('consumer cancellation is visible and does not resume or drain the underlying stream',async t=>{
  const f=await fixture(t);let produced=0;for await(const _ of f.diagnostics.observe({provider:'f',model:'m'},async function*(){produced++;yield chunks()[0];produced++;yield chunks()[1];},{stage:'expression'}))break;
  assert.equal(produced,1);assert.equal(f.journal.db.prepare('SELECT status FROM diagnostic_model_calls').get().status,'incomplete');
});
test('diagnostic write failure never changes a successful model stream',async t=>{
  const f=await fixture(t);f.journal.db.exec("CREATE TRIGGER fail_metrics BEFORE INSERT ON diagnostic_model_calls BEGIN SELECT RAISE(FAIL,'fixture metrics failure');END");const events=chunks();assert.deepEqual(await consume(f,events),events);assert.equal(f.diagnostics.errors,1);
});
test('failing diagnostic history inserts do not roll back the actual new intent',async t=>{
  const f=await fixture(t);f.journal.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON diagnostic_intent_events BEGIN SELECT RAISE(FAIL,'fixture history failure');END");const row=f.offer();assert.equal(f.attention.store.get(row.id).status,'pending');assert.equal(f.diagnostics.errors,1);
});
test('full prompts and output text never appear in metrics rows',async t=>{
  const f=await fixture(t);await consume(f);const rows=f.journal.db.prepare('SELECT * FROM diagnostic_model_calls').all();assert.ok(!JSON.stringify(rows).includes('原话内容'));assert.ok(!JSON.stringify(rows).includes('"ok":true'));assert.equal(rows[0].fingerprint.length,64);
});
test('large multimodal or history inputs omit the fingerprint instead of storing truncated duplicate identities',async t=>{
  const f=await fixture(t);await consume(f,chunks(),{stage:'expression'},{messages:[{role:'user',content:[{type:'text',text:'甲'.repeat(150000)}]}]});assert.equal(f.journal.db.prepare('SELECT fingerprint FROM diagnostic_model_calls').get().fingerprint,null);
});
test('identical repeated requests are review clues and never automatically cancelled',async t=>{
  const f=await fixture(t);for(let i=0;i<3;i++)await consume(f);const r=f.read();assert.equal(r.costs[0].calls,3);assert.ok(r.findings.some(x=>x.code==='identical_request_repeated'));assert.equal(f.growth.store.revision(),0);
});
test('passive hooks classify marked expressions and labelled emotion calls without changing frozen requests',async t=>{
  const f=await fixture(t),handlers=new Map(),workspace=path.join(f.directory,'workspace'),agent={session:{header:{id:'s',cwd:workspace,agentPreset:'companion'}}};
  attachDiagnosticsHost({inject:(_names,fn)=>fn({get:name=>name==='agents'?{get:()=>agent}:{},on:(n,fn)=>handlers.set(n,fn),effect(){}})},{diagnostics:f.diagnostics,workspace});
  const hook=handlers.get('llm/stream'),opts=Object.freeze(markAgentLoopRequest({provider:'fixture',model:'fixture',sessionId:'s'}));for await(const _ of hook(opts,async function*(){yield* chunks();})){}
  const llm={stream:options=>hook(options,async function*(){yield* chunks();})};await reviewStructured(llm,null,{source:{origin:{intentId:'known-intent'}}},null,{label:'情绪评价',policy:'fixture',route:{provider:'fixture',model:'fixture'}});
  assert.deepEqual(new Set(f.read().costs.map(r=>r.stage)),new Set(['expression','emotion']));assert.ok(f.journal.db.prepare("SELECT intent_ids FROM diagnostic_model_calls WHERE stage='emotion'").get().intent_ids.includes('known-intent'));
});
test('unknown sessions and unrelated model calls are excluded from companion diagnostics',async t=>{
  const f=await fixture(t),handlers=new Map();attachDiagnosticsHost({inject:(_names,fn)=>fn({get:()=>({get:()=>null}),on:(n,fn)=>handlers.set(n,fn),effect(){}})},{diagnostics:f.diagnostics,workspace:f.directory});let calls=0;
  for await(const _ of handlers.get('llm/stream')({provider:'other',model:'other',sessionId:'unknown'},async function*(){calls++;yield* chunks();})){}assert.equal(calls,1);assert.equal(f.read().costs.length,0);
});
test('async stage labels remain isolated during concurrent reviews',async t=>{
  const f=await fixture(t),seen=[];await Promise.all(['情绪评价','全局行为选择'].map((label,i)=>withDiagnosticContext(label,{},async()=>{await new Promise(r=>setTimeout(r,10-i));const {diagnosticContext}=await load('diagnostic-context.js');seen.push(diagnosticContext().stage);await consume(f,chunks(),diagnosticContext());})));assert.deepEqual(new Set(seen),new Set(['emotion','selection']));
});
test('multi-day time waits wake for reconsideration and the history includes the real transitions',async t=>{
  const f=await fixture(t),row=f.offer();f.attention.store.patch(row.id,'waiting',{wake:{kind:'time',at:f.clock.time+2*86400000},result:{reason:'两天后重新考虑'}});f.clock.time+=3*86400000;f.attention.store.due();
  const report=f.read({hours:120,intentId:row.id});assert.equal(f.attention.store.get(row.id).status,'pending');assert.deepEqual(report.behaviour.history.map(r=>r.status),['pending','waiting','pending']);assert.equal(report.costs.length,0);assert.ok(!report.findings.some(x=>x.code==='reconsideration_time_passed'));
});
test('future waits, event waits and intentional silence are not declared technical failures',async t=>{
  const f=await fixture(t),future=f.offer('future'),event=f.offer('event'),silent=f.offer('silent');f.attention.store.patch(future.id,'waiting',{wake:{kind:'time',at:f.clock.time+10*86400000}});f.attention.store.patch(event.id,'waiting',{wake:{kind:'event'}});f.attention.store.patch(silent.id,'dismissed');f.clock.time+=7*86400000;
  const r=f.read({hours:240});assert.equal(r.findings.length,0);assert.equal(r.behaviour.unfinished.length,2);assert.equal(f.attention.store.get(silent.id).status,'dismissed');
});
test('event and task-end wakeups are recorded, but never force a response',async t=>{
  const f=await fixture(t),r=f.offer();f.attention.store.patch(r.id,'waiting',{wake:{kind:'task_end'}});f.attention.signal('task_end');const h=f.read().behaviour.history;assert.equal(h[0].status,'pending');assert.match(h[0].reason,/task_end/);assert.equal(f.growth.store.revision(),0);
});
test('repeated postponement and overdue consideration are clues only',async t=>{
  const f=await fixture(t),r=f.offer();for(let i=0;i<5;i++){f.attention.store.patch(r.id,'waiting',{wake:{kind:'time',at:f.clock.time+1000}});f.clock.time+=2000;f.attention.store.due();}f.attention.store.patch(r.id,'waiting',{wake:{kind:'time',at:f.clock.time-2*3600000}});
  const report=f.read();assert.ok(report.findings.some(r=>r.code==='repeated_deferral'));assert.ok(report.findings.some(r=>r.code==='reconsideration_time_passed'));assert.equal(f.attention.store.get(r.id).status,'waiting');
});
test('restart records unfinished work reconciliation without replaying it',async t=>{
  const f=await fixture(t),r=f.offer();f.attention.store.patch(r.id,'running');f.clock.time+=86400000;f.reopen();assert.equal(f.attention.store.get(r.id).status,'pending');const history=f.read({hours:48}).behaviour.history;assert.equal(history[0].previous,'running');assert.match(history[0].reason,/重启/);
});
test('crashed model calls are interrupted with unknown duration and usage rather than fictitious running cost',async t=>{
  const f=await fixture(t);f.journal.db.prepare("INSERT INTO diagnostic_model_calls(id,stage,provider,model,intent_ids,status,started_at) VALUES('crash','emotion','f','m','[]','running',?)").run(f.clock.time);f.clock.time+=86400000;f.reopen();const row=f.journal.db.prepare("SELECT * FROM diagnostic_model_calls WHERE id='crash'").get();assert.equal(row.status,'interrupted');assert.equal(row.duration_ms,null);assert.equal(row.total_tokens,null);
});
test('repeated reports make no database changes and invoke no models',async t=>{
  const f=await fixture(t);f.offer();await consume(f);const n=f.journal.db.prepare('SELECT total_changes() n').get().n;for(let i=0;i<10;i++)f.read();assert.equal(f.journal.db.prepare('SELECT total_changes() n').get().n,n);
});
test('diagnostic retention removes only diagnostic rows and reports incomplete coverage',async t=>{
  const f=await fixture(t,{retentionDays:7}),r=f.offer();await consume(f);f.clock.time+=8*86400000;f.diagnostics.cleanup();assert.equal(f.journal.db.prepare('SELECT count(*) n FROM diagnostic_model_calls').get().n,0);assert.ok(f.attention.store.get(r.id));assert.equal(f.read({hours:240}).window.historicalCoveragePartial,true);assert.equal(f.growth.store.meta('identity').length,36);
});
test('row limits bound retained diagnostics without deleting actual waiting intentions',async t=>{
  const f=await fixture(t,{maxRows:1000}),r=f.offer();f.journal.transaction(()=>{for(let i=0;i<1005;i++)f.diagnostics.transition(r,'pending','waiting');});f.clock.time+=86400000;f.diagnostics.cleanup();assert.equal(f.journal.db.prepare('SELECT count(*) n FROM diagnostic_intent_events').get().n,1000);assert.ok(f.attention.store.get(r.id));
});
test('the emotion audit reports source problems as clues and leaves all memory untouched',async t=>{
  const f=await fixture(t),content='请只查询，不保存记忆。';await f.growth.emotions.propose({expectedRevision:0,proposals:[{label:'好奇',topic:'隔离的故意错误样本',statement:'仅用于诊断验证。',reason:'故意建立风险样本。',appraisal:'不代表真实用户。',intensity:'slight',evidenceQuote:content}]},{owner:true,sessionId:'fixture',messageId:'fixture',seq:1,occurredAt:f.now().toISOString(),content,context:[]},()=>({decision:{decisions:[{index:0,verdict:'accept',independent:true,confidence:'medium',reason:'fixture'}]}}));
  const before=f.growth.emotions.store.revision(),r=f.read();assert.ok(r.findings.some(r=>r.code==='no_save_source_needs_review'));assert.equal(f.growth.emotions.store.revision(),before);assert.ok(!JSON.stringify(r).includes(content));
});
test('diagnostic queries validate range and support pre-upgrade databases',async t=>{
  const f=await fixture(t);assert.throws(()=>f.read({hours:0}));assert.throws(()=>f.read({limit:1001}));assert.throws(()=>f.read({intentId:"'; DROP TABLE x"}));f.journal.db.exec('DROP TABLE diagnostic_meta');assert.equal(readDiagnostics(f.journal.db).status,'not_initialized');
});
test('the diagnostic tool is owner-only and keeps disabled attention independent',async t=>{
  const f=await fixture(t),tools=new Map();attachAttentionAgent({tools:{register:r=>tools.set(r.name,r)}},{diagnostics:f.diagnostics,attention:{enabled:()=>false}});
  const make=source=>({session:{header:{},seq:2,eventAt:n=>n===1?{type:'user/message',data:{id:'m',source,content:[{type:'text',text:'查看诊断'}]}}:{type:'turn/start'}}});
  assert.equal((await tools.get('friend_diagnostics_read').execute({}, {agent:make({kind:'user'})})).status,'read');await assert.rejects(tools.get('friend_diagnostics_read').execute({}, {agent:make({kind:'tool'})}));
});
