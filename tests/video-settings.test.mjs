import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture,bload} from './bilibili-workbench-fixture.mjs';
const {VIDEO_SETTINGS_KEY,readVideoSettings}=await bload('video-config.js'),{VideoObserver}=await bload('video-observer.js'),{applyConfigRequest,configRequestSchema}=await bload('console.js');
function save(f,changes){return f.view.command({kind:'settings',requestId:randomUUID(),expectedRevision:f.view.settings().revision,changes:{video:changes}});}
test('video controls inherit profile defaults until explicitly saved; reads never write or call models',async t=>{
 const f=await fixture(t,{run:false}),before=f.dump(),settings=f.view.settings();assert.deepEqual(settings.values.video,{windowSeconds:5,maxWindows:3,maxFrames:4,continuousFrames:12});assert(settings.fields.find(g=>g.group==='video').fields.length===4);
 assert.equal(readVideoSettings(f.db).revision,0);assert.equal(f.dump(),before);assert.equal(f.calls.length,0);assert.equal(f.reads.length,0);
});
test('partial video settings persist immediately without resetting other profile fields, budgets or identity',async t=>{
 const f=await fixture(t,{run:false}),before=f.view.settings(),budget=f.activity.store.budget(),result=save(f,{continuousFrames:20});
 assert(result.notice.includes('后续批次'));assert.equal(f.activity.video.config.continuousFrames,20);assert.equal(f.activity.video.config.windowSeconds,5);assert.equal(f.activity.video.config.maxFrames,4);assert.equal(f.activity.video.config.evidenceLimitBytes,256*1024*1024);assert.deepEqual(f.activity.store.budget(),budget);
 const next=f.view.settings();for(const key of ['activity','inbox','social','account'])assert.deepEqual(next.values[key],before.values[key]);
 assert.deepEqual(readVideoSettings(f.db).settings,{continuousFrames:20});
 const recreated=new VideoObserver({journal:f.journal,media:{},config:{windowSeconds:5,maxFrames:4,continuousFrames:12}});assert.equal(recreated.config.continuousFrames,20);assert.equal(recreated.config.windowSeconds,5);
 const receipt=JSON.parse(f.db.prepare("SELECT value FROM platform_meta WHERE key='bili-workbench:commands:v1'").get().value).at(-1);assert.equal(receipt.result.applied[0].previous,12);assert.equal(receipt.result.applied[0].value,20);assert.equal(f.calls.length,0);
});
test('changes during a running batch affect the following batch, not the active captured ranges or frame count',async t=>{
 const f=await fixture(t,{run:false}),original=f.activity.video.config;let changed=false,activeSnapshot;
 f.beforeFrames(()=>{if(changed)return;changed=true;save(f,{windowSeconds:10,maxWindows:1,maxFrames:2,continuousFrames:4});activeSnapshot=f.view.settings().video.activeBatch;});
 const first=await f.run();assert(first.pending);assert.equal(first.reading.nextSeconds,15);assert.deepEqual(f.frameCalls.map(x=>x.n),[12,12,12]);assert.equal(activeSnapshot.settings.windowSeconds,5);assert.equal(activeSnapshot.settings.continuousFrames,12);assert.equal(f.activity.video.config.continuousFrames,4);
 assert.deepEqual(f.activity.video.store.state(first.activityId).samplingConfig,original);
 f.advance();const second=await f.activity.readings.execute(first.reading.id,new AbortController().signal);assert.equal(second.status,'completed');assert.equal(f.frameCalls.length,4);assert.equal(f.frameCalls.at(-1).n,4);assert.equal(f.frameCalls.at(-1).range.startSeconds,15);assert.equal(f.frameCalls.at(-1).range.endSeconds,20);
 assert.equal(f.activity.video.store.state(second.activityId).samplingConfig.windowSeconds,10);
});
test('process interruption resumes the original batch policy and does not redo its saved first segment',async t=>{
 const f=await fixture(t,{run:false});let count=0,closing;
 f.beforeFrames(()=>{count++;if(count===2){save(f,{windowSeconds:10,maxWindows:1,continuousFrames:4});closing=f.activity.close();}});
 const interrupted=await f.run();await closing;assert.equal(interrupted.status,'interrupted');const old=f.activity.store.get(interrupted.activityId);assert.equal(f.activity.video.store.segments(old.id).length,1);assert.equal(old.request.videoConfigSnapshot.continuousFrames,12);
 await f.reopen();f.beforeFrames(()=>{});assert.equal(f.activity.video.config.continuousFrames,4);
 const before=f.frameCalls.length,result=await f.activity.run(old.request,'manual',new AbortController().signal,{resume:f.activity.store.get(old.id)});assert(result.pending);assert.equal(f.activity.video.store.segments(old.id).length,3);assert.deepEqual(f.frameCalls.slice(before).map(x=>x.n),[12,12]);assert.equal(f.activity.video.store.state(old.id).samplingConfig.windowSeconds,5);
});
test('request payload cannot supply a larger host batch policy',async t=>{
 const f=await fixture(t,{run:false}),result=await f.activity.run({video:'BV1Eb411u7Fw',viewMode:'continuous',learn:false,videoConfigSnapshot:{windowSeconds:120,maxWindows:3,continuousFrames:24}},'manual',new AbortController().signal);
 assert(result.pending);assert.equal(result.reading.nextSeconds,15);assert.deepEqual(f.frameCalls.map(x=>x.n),[12,12,12]);assert.equal(f.activity.store.get(result.activityId).request.videoConfigSnapshot.windowSeconds,5);
});
test('ordinary observation uses its own saved frame count and window cap',async t=>{
 const f=await fixture(t,{run:false});save(f,{windowSeconds:10,maxWindows:2,maxFrames:3,continuousFrames:20});const review=f.activity.host.review;
 f.activity.host.review=async(role,snapshot,signal)=>{
  if(role==='watch')return {decision:{action:'observe',startSeconds:snapshot.observed.at(-1)?.range[1]??0,durationSeconds:10,reason:'隔离普通观察按保存上限选择窗口'}};
  if(role==='vision')return {decision:{frames:snapshot.frames.map(frame=>({id:frame.id,description:'隔离普通观察的已有采样画面'}))}};
  return review(role,snapshot,signal);
 };
 const r=await f.activity.run({video:'BV1Eb411u7Fw',viewMode:'sample',learn:false},'manual',new AbortController().signal);assert.equal(r.status,'read_only');assert.deepEqual(f.frameCalls.map(x=>x.n),[3,3]);assert.deepEqual(f.frameCalls.map(x=>[x.range.startSeconds,x.range.endSeconds]),[[0,10],[10,20]]);assert(f.frameCalls.every(x=>x.options.sequence===false));
});
test('video values stay within the existing caps and immutable capabilities cannot be edited',async t=>{
 const f=await fixture(t,{run:false});for(const changes of [{windowSeconds:4},{windowSeconds:121},{maxWindows:0},{maxWindows:4},{maxFrames:0},{maxFrames:7},{continuousFrames:3},{continuousFrames:25},{continuousFrames:4.5},{enabled:false},{evidenceLimitBytes:1024}]){const before=f.dump();assert.throws(()=>save(f,changes));assert.equal(f.dump(),before);}
 save(f,{windowSeconds:120,maxWindows:3,maxFrames:6,continuousFrames:24});assert.equal(f.activity.video.config.continuousFrames,24);
});
test('settings conflicts, CLI writes and value cycles are protected by the persisted video version',async t=>{
 const f=await fixture(t,{run:false}),old=f.view.settings(),cmd={kind:'settings',requestId:randomUUID(),expectedRevision:old.revision,changes:{video:{continuousFrames:20}}};
 applyConfigRequest(f.controller.instance,{schema:configRequestSchema,changes:{video:{continuousFrames:16}}});assert.equal(f.activity.video.config.continuousFrames,16);assert.throws(()=>f.view.command(cmd),{status:409});
 applyConfigRequest(f.controller.instance,{schema:configRequestSchema,changes:{video:{continuousFrames:12}}});assert.equal(f.activity.video.config.continuousFrames,12);assert.throws(()=>f.view.command(cmd),{status:409});
 const s=f.view.settings(),fresh={...cmd,requestId:randomUUID(),expectedRevision:s.revision};f.view.command(fresh);const revision=readVideoSettings(f.db).revision;assert(f.view.command(fresh).replayed);assert.equal(readVideoSettings(f.db).revision,revision);
});
test('failed bookkeeping rolls back both video configuration and other groups as one transaction',async t=>{
 const f=await fixture(t,{run:false});f.db.prepare("INSERT INTO platform_meta VALUES('bili-workbench:config-epoch','broken')").run();const before=f.dump();
 assert.throws(()=>f.view.command({kind:'settings',requestId:randomUUID(),expectedRevision:f.view.settings().revision,changes:{video:{continuousFrames:20},activity:{dailyLimit:7}}}),{status:503});assert.equal(f.dump(),before);assert.equal(f.activity.video.config.continuousFrames,12);
});
test('corrupted persisted video settings are not overwritten or silently replaced by defaults',async t=>{
 const f=await fixture(t,{run:false});for(const raw of ['{broken',JSON.stringify({schema:'ai-friend/bili-video-settings/1',revision:1,settings:{continuousFrames:200}}),JSON.stringify({schema:'ai-friend/bili-video-settings/1',revision:1,settings:{evidenceLimitBytes:1024}})]){f.db.prepare('INSERT INTO platform_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(VIDEO_SETTINGS_KEY,raw);const before=f.dump();assert.throws(()=>f.activity.video.config,{status:503});assert.throws(()=>f.view.settings(),{status:503});assert.equal(f.dump(),before);}
});
test('a corrupted old batch snapshot fails before media or model access instead of silently using defaults',async t=>{
 const f=await fixture(t,{run:false}),id=randomUUID(),samplingConfig={...f.activity.video.config};delete samplingConfig.windowSeconds;
 f.activity.video.store.save(id,{plans:[],complete:false,samplingConfig});const before=f.dump();
 await assert.rejects(()=>f.activity.video.observe({id,target:{bvid:'BV1Eb411u7Fw',page:1},request:{},signal:new AbortController().signal}),/原批次采样配置不完整/);assert.equal(f.dump(),before);assert.equal(f.reads.length,0);assert.equal(f.frameCalls.length,0);assert.equal(f.calls.length,0);
});
