import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const project=process.env.AI_FRIEND_PROJECT_ROOT??path.resolve(import.meta.dirname,'..');
const load=(base,name)=>import(pathToFileURL(path.join(base,name)));
const source=process.env.FRIEND_ADAPTER_SOURCE??path.join(project,'plugins/companion-adapter/src');
const bsource=process.env.FRIEND_BILIBILI_SOURCE??path.join(project,'plugins/bilibili-tool/src');
const {Journal}=await load(source,'journal.js'),{AttentionController}=await load(source,'attention.js');
const {validateAttention}=await load(source,'attention-protocol.js');
const {bilibiliAttentionCapability}=await load(bsource,'attention-capability.js');
const {validateReflection,ActivityController}=await load(bsource,'activities.js');
const gate=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const answer=(action='rest',targetId=null,executionTarget)=>({decision:{action,targetId,reason:'依据真实任务及资源选择',updates:[],suggestions:[],...(executionTarget?{executionTarget}:{})}});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'friend-reliability-')),journal=new Journal(dir),clock={time:Date.parse('2026-11-05T08:00:00Z')},frames=[],calls=[];
 const a=new AttentionController({journal,now:()=>new Date(clock.time)});
 const activities={active:null,readiness:()=>null,run:async request=>{calls.push(request);return {status:'rested'};}};
 const cap=bilibiliAttentionCapability({activities});
 const host={availability:r=>cap.availability(r),routing:r=>cap.routing(r),beforeStart:(r,s)=>cap.readiness(r,s),snapshot:async()=>({revision:1}),review:async frame=>{frames.push(frame);return answer('rest');},execute:(r,s)=>cap.execute(r,s)};
 a.bind(host);
 t.after(async()=>{await a.close();journal.close();assert.ok(dir.startsWith(os.tmpdir()+path.sep)&&path.basename(dir).startsWith('friend-reliability-'));await fs.rm(dir,{recursive:true});});
 return {a,host,cap,activities,frames,calls,clock,offer:(key,kind='browse',payload={})=>a.offer({key,kind,scope:kind==='message'?'owner':'internal',summary:key,payload})};
}

test('exhausted automatic video resources wait before model selection, without new calls or false silence',async t=>{
 const f=await fixture(t),at=f.clock.time+3600000;let checks=0;
 f.activities.readiness=()=>{checks++;return {waiting:true,resource:'bilibili_activity',wake:{kind:'time',at},reason:'实际观看额度用完'};};
 const r=f.offer('先读一个视频');for(let i=0;i<8;i++)await f.a.tick();
 const parked=f.a.store.get(r.id);assert.equal(parked.status,'waiting');assert.equal(parked.result.notStarted,true);assert.equal(parked.wake.at,at);
 assert.equal(checks,1);assert.equal(f.frames.length,0);assert.equal(f.calls.length,0);
 assert.equal(f.a.status().decisionState.current.code,'waiting_resources');assert.equal(f.a.status().decisionState.lastDecision,null);
 f.clock.time=at+1;f.activities.readiness=()=>null;await f.a.choose();assert.equal(f.frames.length,1);assert.equal(f.a.store.get(r.id).status,'pending');
});
test('blocked browsing leaves a QQ message available to the same model, which can still choose rest',async t=>{
 const f=await fixture(t);f.activities.readiness=()=>({waiting:true,resource:'bilibili_activity',wake:{kind:'time',at:f.clock.time+60000},reason:'冷却'});
 f.offer('浏览');const qq=f.offer('QQ新原话','message',{message:{id:'qq-original'}});await f.a.choose();
 assert.deepEqual(f.frames[0].candidates.map(r=>r.id),[qq.id]);assert.equal(f.a.store.get(qq.id).status,'pending');assert.equal(f.calls.length,0);
});
test('a policy or arrival during availability invalidates success and failure before parking stale state',async t=>{
 for(const fail of [false,true]){
  const f=await fixture(t),r=f.offer('原任务'),entered=gate(),release=gate();
  f.host.availability=async()=>{entered.resolve();await release.promise;if(fail)throw Error('过期检查错误');return {waiting:true,wake:{kind:'time',at:f.clock.time+60000},reason:'过期额度'};};
  const pending=f.a.choose();await entered.promise;f.a.signal('activity_policy');release.resolve();assert.equal(await pending,null);
  assert.equal(f.a.store.get(r.id).status,'pending');assert.equal(f.frames.length,0);
 }
});
test('a failed resource check parks only its own task and does not block other ready input',async t=>{
 const f=await fixture(t),bad=f.offer('检查失败'),qq=f.offer('可处理QQ','message');
 f.host.availability=async r=>{if(r.id===bad.id)throw Error('资源查询暂不可用');};await f.a.choose();
 assert.equal(f.a.store.get(bad.id).status,'waiting');assert.match(f.a.store.get(bad.id).error,/暂不可用/);
 assert.deepEqual(f.frames[0].candidates.map(r=>r.id),[qq.id]);assert.equal(f.a.status().decisionState.recent.find(r=>r.id===bad.id).state.code,'processing_error');
});
test('resource exhaustion after model selection is checked again before executing',async t=>{
 const f=await fixture(t),r=f.offer('视频任务');
 f.host.review=async()=>{f.activities.readiness=()=>({waiting:true,resource:'bilibili_activity',wake:{kind:'time',at:f.clock.time+60000},reason:'选后资源变化'});return answer('start',r.id,'bilibili_video');};
 const selected=await f.a.choose();await f.a.dispatch(selected);assert.equal(f.a.store.get(r.id).status,'waiting');assert.equal(f.calls.length,0);
});
test('the model routes a paper-original task to capability waiting without Bili discovery or execution',async t=>{
 const f=await fixture(t),r=f.offer('打开PubMed的章鱼镜像识别论文原文');
 f.host.review=async frame=>{assert.equal(frame.candidates[0].executionRouting.required,true);return answer('start',r.id,'external_document');};
 await f.a.dispatch(await f.a.choose());const parked=f.a.store.get(r.id);
 assert.equal(parked.status,'waiting');assert.equal(parked.wake.kind,'capability_change');assert.equal(parked.result.executionTarget,'external_document');assert.equal(parked.result.resource,'external_document');assert.equal(f.calls.length,0);
 f.a.signal('task_end');f.a.signal('activity_policy');assert.equal(f.a.store.get(r.id).status,'waiting');
 f.a.signal('capability_change');await f.a.choose();assert.equal(f.a.store.get(r.id).status,'waiting');assert.equal(f.calls.length,0);
});
test('a genuine paper-search tutorial video is allowed through semantic routing, without keyword exclusion',async t=>{
 const f=await fixture(t),r=f.offer('我想看PubMed原文检索教程视频','browse',{topic:'PubMed原文检索教程视频'});
 f.host.review=async()=>answer('start',r.id,'bilibili_video');await f.a.dispatch(await f.a.choose());
 assert.deepEqual(f.calls,[{query:'PubMed原文检索教程视频'}]);assert.equal(f.a.store.get(r.id).status,'completed');
});
test('missing semantic routing uses the existing single correction boundary; invalid correction cannot execute',async t=>{
 for(const validRepair of [true,false]){
  const f=await fixture(t),r=f.offer('浏览任务');let repairs=0;f.host.review=async()=>answer('start',r.id);
  f.host.repair=async({problem})=>{repairs++;assert.ok(problem.issues.some(i=>i.path==='executionTarget'));return answer('start',r.id,validRepair?'bilibili_video':undefined);};
  const selected=await f.a.choose();assert.equal(repairs,1);
  if(validRepair){assert.equal(selected.result.executionTarget,'bilibili_video');await f.a.dispatch(selected);assert.equal(f.calls.length,1);}
  else{assert.equal(selected,null);assert.equal(f.calls.length,0);assert.equal(f.a.store.get(r.id).status,'pending');}
 }
});
test('manual video requests, checkpoints, account operations and QQ platform events keep their original routing',async t=>{
 const f=await fixture(t);let checks=0;f.activities.readiness=()=>{checks++;return {waiting:true};};
 for(const payload of [{requestId:'manual'},{runId:'checkpoint'},{biliActionId:'account'},{platformActionId:'qq-action'},{platformEventId:'qq-group'}]){
  const r={kind:'browse',payload};assert.equal(f.cap.routing(r),undefined);assert.equal(f.cap.availability(r),undefined);
 }
 assert.equal(checks,0);await assert.rejects(f.cap.execute({kind:'browse',payload:{}},new AbortController().signal),/缺少已核验/);assert.equal(f.calls.length,0);
});
test('activity interest validation uses growth storage key constraints without silently stripping or merging names',()=>{
 const observation={text:'真实原文。'},value=key=>({summary:'读到的事实。',quote:'真实原文。',interest:{key,statement:'对方法有一点好奇',reason:'来源明确',evidenceQuote:'真实原文。'},emotion:null});
 for(const key of ['镜子测试、章鱼','interest:检索结果','方法/方法'])assert.throws(()=>validateReflection(value(key),observation),/兴趣状态键/);
 assert.equal(validateReflection(value('ＡＢＣ_方法-1'),observation).interest.key,'abc_方法-1');
 assert.throws(()=>validateReflection({...value('方法'),interest:{...value('方法').interest,statement:'长'.repeat(401)}},observation));
});
test('activity origin is assigned from trusted trigger and cannot be spoofed by input',async t=>{
 const f=await fixture(t),seen=[];
 for(const trigger of ['automatic','manual']){
  const controller=Object.create(ActivityController.prototype);Object.assign(controller,{closed:false,config:{enabled:true,timeoutMs:1000},host:{},video:null,active:null,now:()=>new Date(f.clock.time),execute:async request=>{seen.push(request);return {status:'rested'};}});
  await controller.run({query:'自然主题',origin:trigger==='automatic'?'explicit_request':'autonomous'},trigger);
 }
 assert.deepEqual(seen.map(r=>r.origin),['autonomous','explicit_request']);
});
