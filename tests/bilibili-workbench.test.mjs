import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {fixture,bload} from './bilibili-workbench-fixture.mjs';
const {workbenchResponse}=await bload('workbench-host.js'),{visibleText}=await bload('workbench-view.js'),{hash}=await bload('util.js');
const base='http://localhost:3080',command=body=>new Request(base+'/api/ai-friend-bilibili-workbench-control',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(body)});
test('read pages are observational and preserve all state, model calls and platform traffic',async t=>{
 const f=await fixture(t),before=f.dump(),calls=f.calls.length,traffic=f.reads.length;
 for(const section of ['overview','watch','inbox','actions','settings']){const s=f.view.snapshot({section});assert.equal(s.schema,'ai-friend/bilibili-workbench/1');assert(s.connection.bound);assert(s.notice.includes('刷新不会'));if(section==='watch'){assert.equal(s.tasks.length,1);assert.equal(s.tasks[0].kind,'continuous');assert.equal(s.tasks[0].frameCount,36);assert.equal(s.tasks[0].processedSeconds,15);}}
 const id=f.activity.readings.status().recent[0].id,d=f.view.detail(id);assert.equal(d.language.length,3);assert.equal(d.frames.length,36);assert(d.limits.includes('派生'));assert.equal(f.dump(),before);assert.equal(f.calls.length,calls);assert.equal(f.reads.length,traffic);
});
test('task paging has no skips or duplicates when mixing ordinary and continuous records',async t=>{
 const f=await fixture(t),at='2026-11-06T00:00:00.000Z';for(let i=0;i<30;i++)f.db.prepare("INSERT INTO activity_runs VALUES(?,?,'manual','completed','{}',NULL,NULL,NULL,NULL,?,?)").run(randomUUID(),'2026-11-06',at,at);
 const first=f.view.snapshot({section:'watch',limit:16}),second=f.view.snapshot({section:'watch',limit:16,offset:16});assert.equal(first.counts.tasks,31);assert.equal(first.tasks.length,16);assert.equal(second.tasks.length,15);assert.equal(new Set([...first.tasks,...second.tasks].map(x=>x.id)).size,31);assert(!second.paging.hasMore);
});
test('settings changes preserve whitelist, audit, optimistic conflict and idempotent replay',async t=>{
 const f=await fixture(t),s=f.view.settings(),cmd={kind:'settings',requestId:randomUUID(),expectedRevision:s.revision,changes:{activity:{dailyLimit:7}}};
 const result=f.view.command(cmd);assert.equal(result.applied[0].value,7);assert.equal(f.view.settings().values.activity.dailyLimit,7);assert.equal(f.activity.config.dailyLimit,7);const after=f.dump();assert(f.view.command(cmd).replayed);assert.equal(f.dump(),after);
 assert.throws(()=>f.view.command({...cmd,requestId:randomUUID(),changes:{activity:{dailyLimit:8}}}),{status:409});
 assert.throws(()=>f.view.command({...cmd,changes:{activity:{dailyLimit:8}}}),{status:409});
 const current=f.view.settings();assert.throws(()=>f.view.command({...cmd,requestId:randomUUID(),expectedRevision:current.revision,changes:{activity:{dailyLimit:99}}}),/白名单/);assert.equal(f.dump(),after);
});
test('reading pause and resume reuse existing checkpoints; terminal tasks cannot restart',async t=>{
 const f=await fixture(t),r=f.activity.readings.status().recent[0],cmd={kind:'reading',id:r.id,action:'pause',expectedRevision:r.revision,requestId:randomUUID()},calls=f.calls.length;
 const paused=f.view.command(cmd);assert.equal(paused.status,'paused');const revision=f.activity.readings.get(r.id).revision;assert(f.view.command(cmd).replayed);assert.equal(f.activity.readings.get(r.id).revision,revision);
 assert.throws(()=>f.view.command({...cmd,requestId:randomUUID()}),{status:409});
 const resume={...cmd,action:'resume',expectedRevision:revision,requestId:randomUUID()};assert.equal(f.view.command(resume).status,'pending');assert.equal(f.calls.length,calls);
 const row=f.activity.readings.get(r.id);f.activity.readings.save({...row,status:'completed'});assert.throws(()=>f.view.command({...cmd,requestId:randomUUID(),expectedRevision:row.revision+1}),{status:409});
});
test('mutations reject read-only instances and invalid command IDs',async t=>{
 const f=await fixture(t),before=f.dump();f.controller.writeEnabled=()=>false;assert.throws(()=>f.view.command({kind:'reading',requestId:randomUUID()}),{status:403});assert.equal(f.dump(),before);f.controller.writeEnabled=()=>true;assert.throws(()=>f.view.command({kind:'reading',requestId:'bad'}),{status:400});
});
test('a settings version cannot revive after values cycle back to an earlier configuration',async t=>{
 const f=await fixture(t),initial=f.view.settings(),cmd={kind:'settings',requestId:randomUUID(),expectedRevision:initial.revision,changes:{activity:{dailyLimit:7}}};
 f.view.command(cmd);f.view.command({kind:'settings',requestId:randomUUID(),expectedRevision:f.view.settings().revision,changes:{activity:{dailyLimit:initial.values.activity.dailyLimit}}});
 assert.equal(f.view.settings().values.activity.dailyLimit,initial.values.activity.dailyLimit);assert.notEqual(f.view.settings().revision,initial.revision);
 f.db.prepare("UPDATE platform_meta SET value='[]' WHERE key='bili-workbench:commands:v1'").run();assert.throws(()=>f.view.command(cmd),{status:409});
});
test('failed management bookkeeping rolls back the actual settings modification',async t=>{
 const f=await fixture(t);f.db.prepare("INSERT INTO platform_meta VALUES('bili-workbench:config-epoch','broken')").run();const before=f.dump();
 assert.throws(()=>f.view.command({kind:'settings',requestId:randomUUID(),expectedRevision:f.view.settings().revision,changes:{activity:{dailyLimit:7}}}),{status:503});assert.equal(f.dump(),before);
});
test('inbox classification separates model deferral, unconfirmed output and verified replies',async t=>{
 const f=await fixture(t,{run:false}),a=f.event('一条真实原话','deferred'),b=f.event('另一条原话'),c=f.event('没有回应依据');
 const at='2026-11-05T03:00:00Z',turn=randomUUID();f.db.prepare("INSERT INTO bili_social_turns VALUES(?,?,?,'unconfirmed',?,NULL,NULL,?,?)").run(turn,'private:6789',JSON.stringify([b]),JSON.stringify({disposition:'reply',reason:'想接一句'}),at,at);
 f.db.prepare("INSERT INTO bili_social_outbox VALUES(?,?,?,?,?,'unconfirmed',NULL,?,NULL,?,?)").run(randomUUID(),turn,'private:6789','{}','回复正文',JSON.stringify({readBackVerified:false}),at,at);
 const page=f.view.snapshot({section:'inbox'});assert.equal(page.events.find(e=>e.id===a).status,'暂缓');assert.equal(page.events.find(e=>e.id===b).status,'异常');assert.equal(page.events.find(e=>e.id===c).status,'待关注');assert.equal(page.events.find(e=>e.id===c).reason,'');
 f.db.prepare("UPDATE bili_social_outbox SET status='sent',receipt_json=? WHERE turn_id=?").run(JSON.stringify({readBackVerified:true}),turn);const e=f.view.detail(b,'event').event;assert.equal(e.status,'已回应');assert(e.outbox.readBackVerified);
});
test('source details refuse corrupt reading checksums; credential patterns stay hidden',async t=>{
 const f=await fixture(t),id=f.activity.readings.status().recent[0].id;f.db.prepare("UPDATE activity_video_readings SET value_json='{}' WHERE id=?").run(id);assert.equal(f.view.snapshot({section:'watch'}).tasks[0].status,'unverified');assert.throws(()=>f.view.detail(id),/校验/);
 for(const v of ['sk-'+'a'.repeat(32),'Cookie: SESSDATA=secret','C:\\private\\config.json','https://example.test/?token=secret'])assert(visibleText(v).includes('隐藏'));
});
test('frame access is restricted to validated task membership and original hash',async t=>{
 const f=await fixture(t),r=f.activity.readings.status().recent[0],d=f.view.detail(r.id);await assert.rejects(()=>f.view.frame(r.id,randomUUID(),d.frames[0].sha256),{status:404});await assert.rejects(()=>f.view.frame('../outside',d.frames[0].observationId,d.frames[0].sha256),{status:400});
 f.view.attachments={readImage:async()=>({data:Buffer.from('wrong'),ref:{mediaType:'image/jpeg'}})};await assert.rejects(()=>f.view.frame(r.id,d.frames[0].observationId,d.frames[0].sha256),{status:503});
});
test('HTTP boundary rejects malformed queries, methods, oversized bodies and foreign Origins',async t=>{
 const f=await fixture(t),get=workbenchResponse(f.view),post=workbenchResponse(f.view,'control'),before=f.dump();
 for(const q of ['?section=other','?offset=-1','?limit=49','?limit=1&limit=2','?file=../../secret'])assert.equal((await get(new Request(base+'/api/ai-friend-bilibili-workbench'+q))).status,400);
 assert.equal((await get(new Request(base+'/api/ai-friend-bilibili-workbench',{method:'POST'}))).status,405);
 const cmd={kind:'settings',requestId:randomUUID(),expectedRevision:f.view.settings().revision,changes:{activity:{dailyLimit:7}}};
 for(const origin of ['https://outside.test','null',base+'/path'])assert.equal((await post(new Request(base+'/api/ai-friend-bilibili-workbench-control',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(cmd)}))).status,403);
 assert.equal((await post(new Request(base+'/api/ai-friend-bilibili-workbench-control',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'x'.repeat(9000)}))).status,413);
 assert.equal((await post(command({...cmd,extra:'unexpected'}))).status,400);assert.equal(f.dump(),before);
 const applied=await post(command(cmd));assert.equal(applied.status,200);assert.equal((await applied.json()).applied[0].value,7);
});
