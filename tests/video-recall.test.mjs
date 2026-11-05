import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
const bsource=process.env.FRIEND_BILIBILI_SOURCE??path.join(project,'plugins/bilibili-tool/src');
const bload=name=>import(pathToFileURL(path.join(bsource,name)));
const project=process.env.AI_FRIEND_PROJECT_ROOT??path.resolve(import.meta.dirname,'..'),src=process.env.FRIEND_ADAPTER_SOURCE??path.join(project,'plugins/companion-adapter/src'),load=name=>import(pathToFileURL(path.join(src,name)));
const {Journal}=await load('journal.js'),{ActivityStore}=await bload('activity-store.js'),{VideoNotes}=await bload('video-notes.js'),{ApplyStore}=await load('apply-store.js'),{activityConfig}=await bload('activity-config.js'),{VideoRecall,recallWithMnemon,videoRecallRequest}=await bload('video-recall.js'),{hash}=await load('validation.js');
const bvid='BV1Eb411u7Fw',other='BV1ZHnF6SEp5',body='隔离模拟资料：章鱼拿贝壳挡在身前，躲避鲨鱼。';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'friend-video-recall-')),journal=new Journal(root);let clock=Date.parse('2026-10-30T02:00:00Z');const activity=new ActivityStore(journal,()=>new Date(clock)),applications=new ApplyStore(journal),records=new Map(),lookups=[];
 const adapter={journal,applications:{store:applications},activities:{store:activity,videoNotes:new VideoNotes(activity)},client:{async showReadOnly(store,id,signal){signal?.throwIfAborted();lookups.push([store,id]);return records.get(store+':'+id)??null;}}},recall=new VideoRecall(adapter);
 t.after(()=>{journal.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('friend-video-recall-'));return fs.rm(root,{recursive:true,force:true});});
 function seed({video=bvid,cid='111',page=1,text=body,learn=true,kind='activity',nativeId=randomUUID(),space='default',storedContent,stepStatus='applied'}={}){
  clock+=121000;const runId=activity.begin({learn},'manual',activityConfig()),payload={protocol:'ai-friend/video-observation/1',bvid:video,page,title:'隔离章鱼片段',url:`https://www.bilibili.com/video/${video}/?p=${page}`,scope:'隔离字幕抽样0–60秒，未逐帧观看',dataSource:'multimodal',text:'【片段 0.00–60.00秒】\n【平台字幕】\n'+text,video:{cid,durationSeconds:600,segments:[{startSeconds:0,endSeconds:60,language:{source:'subtitle',text},frames:[]}]}};
  const observation=activity.observe(payload).observation,quote=payload.text.slice(0,300),reflection={summary:'暂定理解：'+text.slice(0,150),quote,interest:null,emotion:null};activity.update(runId,'completed',{observationId:observation.id,decision:{reflection}});
  const source=activity.reportSource(observation.id),content=storedContent??'外部阅读经历：'+text+'\n来源：'+payload.url,frame={protocol:'ai-friend/activity-memory/1',authorization:{kind,policy:'activity-observation-v1',observationId:observation.id},sources:[source]},operation={kind:'native_add',target:'event',storeId:space,content,evidence:[{sourceId:source.id,quote}]};
  const appId=randomUUID(),stepId=randomUUID();journal.db.prepare("INSERT INTO apply_runs VALUES(?,?,?,?,?,'completed',1,?,?,NULL,NULL,?,?)").run(appId,randomUUID(),randomUUID(),'[]','{}',JSON.stringify(frame),'{}',activity.time(),activity.time());journal.db.prepare('INSERT INTO apply_steps VALUES(?,?,?,?,?,?,NULL,?)').run(stepId,appId,0,JSON.stringify(operation),stepStatus,JSON.stringify({nativeId,storeId:space,verified:true}),activity.time());records.set(space+':'+nativeId,{id:nativeId,content});
  return {id:nativeId,memoryBodyId:space,content,observation,stepId,appId,operation,frame};
 }
 return {root,journal,activity,applications,adapter,recall,records,lookups,seed};
}

test('a vague question resolves only through verified Native write receipts and returns actual timestamped evidence',async t=>{
 const f=await fixture(t),r=f.seed(),seen=[],result=await f.recall.find({query:'以前那个拿东西挡鲨鱼的片段'},async q=>{seen.push(q);return {results:[r]};},new AbortController().signal);
 assert.equal(result.status,'candidates');assert.equal(result.candidates[0].bvid,bvid);assert.equal(seen.length,1);assert.ok(result.candidates[0].evidence.some(e=>e.observationId===r.observation.id&&e.text.includes('贝壳')));assert.deepEqual(result.candidates[0].evidence[0].ranges,[{startSeconds:0,endSeconds:60}]);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM activity_observations').get().n,1);
});
test('a single model-supplied alternate query runs only after no traceable video and still honors notRun',async t=>{
 const f=await fixture(t),r=f.seed(),queries=[],result=await f.recall.find({query:'那个保护自己的片段',alternateQuery:'章鱼 贝壳 鲨鱼'},async q=>{queries.push(q);return {results:queries.length===1?[]:[r]};});assert.equal(queries.length,2);assert.equal(result.candidates.length,1);
 const blocked=await f.recall.find({query:'已用完',alternateQuery:'不能再查'},async()=>({results:[],notRun:true,budgetExhausted:true}));assert.equal(blocked.status,'budget_limited');assert.equal(blocked.retrieval.calls.length,1);
});
test('duplicate Native hits and a supplied refinement do not multiply the same video or add unused recall calls',async t=>{
 const f=await fixture(t),r=f.seed();let calls=0;const out=await f.recall.find({query:'章鱼',alternateQuery:'贝壳'},async()=>{calls++;return {results:[r,r]};});assert.equal(out.candidates.length,1);assert.equal(out.candidates[0].anchors.length,1);assert.equal(calls,1);assert.equal(f.lookups.length,2,'one validation plus final current-content check');
});
test('different videos, parts and CIDs are separate ambiguous candidates rather than one invented experience',async t=>{
 const f=await fixture(t),a=f.seed(),b=f.seed({video:other}),c=f.seed({cid:'222'}),d=f.seed({page:2}),out=await f.recall.find({query:'贝壳',limit:4},async()=>({results:[a,b,c,d]}));assert.equal(out.candidates.length,4);assert.equal(out.ambiguous,true);assert.equal(new Set(out.candidates.map(c=>`${c.bvid}:${c.page}:${c.cid}`)).size,4);
});
test('a memory merely mentioning a BV, an unconfirmed step, a non-activity write and a no-save observation cannot become viewing evidence',async t=>{
 const f=await fixture(t),unlinked={id:randomUUID(),memoryBodyId:'default',content:'用户说想看'+bvid},a=f.seed({video:other,kind:'conversation'}),b=f.seed({cid:'333',learn:false}),c=f.seed({cid:'444',stepStatus:'written'});f.records.set('default:'+unlinked.id,unlinked);
 const out=await f.recall.find({query:'章鱼'},async()=>({results:[unlinked,a,b,c]}));assert.equal(out.candidates.length,0);assert.equal(out.status,'not_found');assert.ok(!f.lookups.some(([,id])=>id===unlinked.id));
});
test('deleted, corrected or withdrawn Native experience records never revive old video evidence',async t=>{
 const f=await fixture(t),a=f.seed(),b=f.seed({cid:'222'}),c=f.seed({cid:'333'});f.records.delete('default:'+a.id);f.records.get('default:'+b.id).content='后来已更正';f.adapter.applications.protection={withdrawnReport:()=>true};const out=await f.recall.find({query:'章鱼'},async()=>({results:[a,b,c]}));assert.equal(out.candidates.length,0);
});
test('rehashed source changes invalidate the original applied provenance rather than silently relinking an old memory',async t=>{
 const f=await fixture(t),r=f.seed(),payload={...r.observation.payload,text:r.observation.payload.text+'后来篡改'},raw=JSON.stringify(payload);f.journal.db.prepare('UPDATE activity_observations SET payload_json=?,content_hash=? WHERE id=?').run(raw,hash(raw),r.observation.id);assert.equal((await f.recall.find({query:'章鱼'},async()=>({results:[r]}))).candidates.length,0);
});
test('a Native change during original-fragment lookup is caught by the final current-content validation',async t=>{
 const f=await fixture(t),r=f.seed(),read=f.adapter.activities.videoNotes.read.bind(f.adapter.activities.videoNotes);f.adapter.activities.videoNotes.read=(...args)=>{const value=read(...args);f.records.get('default:'+r.id).content='刚刚被修正';return value;};const out=await f.recall.find({query:'章鱼'},async()=>({results:[r]}));assert.equal(out.candidates.length,0);assert.ok(out.retrieval.invalidLinks);
});
test('unavailable recall cannot bypass the Source or claim that no relevant videos exist',async t=>{
 const f=await fixture(t),out=await f.recall.find({query:'旧片段',alternateQuery:'别的问法'},async()=>({results:[],unavailable:'provider down'}));assert.equal(out.status,'unavailable');assert.equal(out.retrieval.calls.length,1);assert.equal(f.lookups.length,0);
});
test('composite dispatch preserves parent scope, guards, signal and terminal/context forwarding',async()=>{
 const agent={},signal=new AbortController().signal,token=Symbol(),context={source:{kind:'plugin'},content:[]},deferred=[];let input,terminal=false;
 const ctx={tools:{get:(name,scope)=>name==='mnemon_recall'&&scope===agent?{}:undefined,execute:async exec=>{input=exec;return {isError:false,value:{results:[]},additionalContexts:[context],concludesTurn:true};}}},exec={agent,signal,token,callId:'outer-call',rootCallId:'root-call',deferContext:c=>deferred.push(c),concludeTurn:()=>terminal=true};
 await recallWithMnemon(ctx,exec,'旧片段');assert.equal(input.parent,token);assert.equal(input.rootCallId,'root-call');assert.equal(input.agent,agent);assert.equal(input.signal,signal);assert.equal(input.name,'mnemon_recall');assert.deepEqual(deferred,[context]);assert.equal(terminal,true);
 const unavailable=await recallWithMnemon({tools:{get:()=>undefined,execute:()=>assert.fail('must not bypass')}},exec,'旧片段');assert.ok(unavailable.unavailable);
});
test('bounded results retain the anchor citation and distinguish truncation from a unique confident match',async t=>{
 const f=await fixture(t),entries=Array.from({length:4},(_,i)=>f.seed({cid:String(111+i),text:body+'有界背景。'.repeat(650)})),out=await f.recall.find({query:'贝壳',limit:1},async()=>({results:entries}));assert.ok(JSON.stringify(out).length<=12000);for(const candidate of out.candidates)assert.ok(candidate.evidence.some(e=>e.id===candidate.evidenceId));assert.equal(out.ambiguous,true,'one returned candidate is not proof of a unique match');assert.ok(out.retrieval.limited);
});
test('invalid requests and cancellation stop before any Native source access',async t=>{
 const f=await fixture(t);for(const args of [{query:''},{query:'旧片段',limit:5},{query:'旧片段',keywords:Array(9).fill('词')}])assert.throws(()=>videoRecallRequest(args));const stop=new AbortController();stop.abort(new Error('cancelled'));await assert.rejects(()=>f.recall.find({query:'旧片段'},()=>assert.fail(),stop.signal),/cancelled/);assert.equal(f.lookups.length,0);
});
