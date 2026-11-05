import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
const project=process.env.AI_FRIEND_PROJECT_ROOT??path.resolve(import.meta.dirname,'..'),source=process.env.FRIEND_ADAPTER_SOURCE??path.join(project,'plugins/companion-adapter/src');
const bsource=process.env.FRIEND_BILIBILI_SOURCE??path.join(project,'plugins/bilibili-tool/src'),bmodule=name=>import(pathToFileURL(path.join(bsource,name)));
const module=name=>import(pathToFileURL(path.join(source,name)));
const {Journal}=await module('journal.js'),{ActivityStore}=await bmodule('activity-store.js'),{VideoNotes,validateVideoNotes}=await bmodule('video-notes.js'),{activityConfig}=await bmodule('activity-config.js'),{hash}=await module('validation.js'),{ownerMessage,userEvidence}=await module('evidence.js'),{attachVideoNotes}=await bmodule('video-notes-agent.js');
const bvid='BV1Eb411u7Fw',target={bvid,page:1},intro='章鱼最初躲进洞穴，观察者以为它不信任自己。',ending='后来镜头说明它是在躲避鲨鱼，先前的不信任只是猜测。';

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'friend-video-notes-')),journal=new Journal(root),clock={value:Date.parse('2026-10-30T02:00:00Z')},store=new ActivityStore(journal,()=>new Date(clock.value)),notes=new VideoNotes(store);
 t.after(()=>{journal.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('friend-video-notes-'));return fs.rm(root,{recursive:true,force:true});});
 function observe(body,{cid='111',page=1,learn=true,summary=body.slice(0,50),videoNotes,legacy=false}={}){
  clock.value+=121000;const runId=store.begin({learn},'manual',activityConfig()),prefix='【片段 0.00–60.00秒】\n【平台字幕】\n',text=legacy?body:prefix+body;
  const payload={...target,page,title:'隔离章鱼片段',scope:legacy?'只有工具返回的字幕文字，没有画面或声音':'只观察0–60秒的字幕与抽样画面，不代表完整视频',url:'https://www.bilibili.com/video/'+bvid+'/?p='+page,text,dataSource:legacy?'subtitle':'multimodal',...legacy?{}:{protocol:'ai-friend/video-observation/1',video:{cid,durationSeconds:600,segments:[{startSeconds:0,endSeconds:60,language:{source:'subtitle',text:body},frames:[]}]}}};
  const observation=store.observe(payload).observation,reflection={summary,quote:body.slice(0,30),interest:null,emotion:null,...videoNotes===undefined?{}:{videoNotes}};
  store.update(runId,'completed',{observationId:observation.id,decision:{reflection}});return {runId,observation,reflection};
 }
 function apply(run,expected){const receipt=notes.append(run.runId,run.observation.id,run.reflection,expected);const row=store.get(run.runId);store.update(row.id,row.status,{decision:{...row.decision,videoNotesBase:expected,videoNotesReceipt:receipt}});return receipt;}
 return {root,journal,clock,store,notes,observe,apply};
}

test('working notes retain exact raw references and sampled ranges without touching personality or memory',async t=>{
 const f=await fixture(t),r=f.observe(intro),applied=f.apply(r,0),read=f.notes.read(bvid);
 assert.equal(applied.status,'applied');assert.equal(read.notes[0].text,intro);assert.equal(read.evidence[0].observationId,r.observation.id);assert.match(read.evidence[0].text,/章鱼/);assert.deepEqual(read.evidence[0].ranges,[{startSeconds:0,endSeconds:60}]);assert.equal(read.notes[0].status,'tentative_interpretation');assert.equal(f.store.get(r.runId).status,'completed');
});
test('Chinese question retrieval finds older material beyond three recent observations and beyond the leading excerpt',async t=>{
 const f=await fixture(t),old=f.observe('普通背景。'.repeat(360)+'章鱼用贝壳防御鲨鱼。');f.apply(old,0);
 for(let i=0;i<5;i++)f.apply(f.observe('后来片段'+i+'只描述海水。'),i+1);
 const read=f.notes.read(bvid,{query:'之前章鱼怎样使用贝壳？',limit:4});assert.ok(read.evidence.some(e=>e.observationId===old.observation.id&&e.text.includes('贝壳')));assert.equal(read.retrieval.observationsSearched,6);assert.match(read.retrieval.method,/字面/);
});
test('a cut excerpt preserves subtitle modality even when its label is far outside the returned text',async t=>{
 const f=await fixture(t),r=f.observe('背景信息。'.repeat(400)+'贝壳挡住鲨鱼。');f.apply(r,0);const read=f.notes.read(bvid,{query:'贝壳',limit:1});assert.deepEqual(read.evidence[0].evidenceTypes,['subtitle']);assert.equal(read.evidence[0].sourceType,'multimodal');
});
test('legacy subtitle-only observations are never labeled as model visual interpretation',async t=>{
 const f=await fixture(t),r=f.observe('仅字幕提到贝壳。',{legacy:true});f.apply(r,0);assert.deepEqual(f.notes.read(bvid).evidence[0].evidenceTypes,['subtitle']);
});
test('unknown legacy rendering is explicitly unclassified rather than guessed as an image or speech',async t=>{
 const f=await fixture(t),r=f.observe(intro);const p={...r.observation.payload,text:'不同旧版排版：'+r.observation.payload.text},raw=JSON.stringify(p);f.journal.db.prepare('UPDATE activity_observations SET payload_json=?,content_hash=? WHERE id=?').run(raw,hash(raw),r.observation.id);f.apply(r,0);assert.deepEqual(f.notes.read(bvid).evidence[0].evidenceTypes,['unclassified_legacy_excerpt']);
});
test('a later interpretation explicitly supersedes an active note while history and original evidence survive',async t=>{
 const f=await fixture(t),first=f.observe(intro);f.apply(first,0);const old=f.notes.read(bvid).notes[0];
 const second=f.observe(ending,{videoNotes:[{kind:'understanding',text:'洞穴行为可能是在躲避鲨鱼，不能据此断言不信任。',evidenceId:'excerpt-0',supersedes:[old.id],reason:'新片段出现了鲨鱼解释，改变先前猜测。'}]});f.apply(second,1);
 const read=f.notes.read(bvid,{includeHistory:true});assert.equal(read.revision,2);assert.equal(read.notes.length,1);assert.equal(read.history.length,2);assert.equal(read.history[1].entries[0].id,old.id);assert.ok(f.store.observation(first.observation.id));
 const raw=f.notes.read(bvid,{evidenceId:old.source.id,limit:1});assert.equal(raw.evidence[0].id,old.source.id);assert.match(raw.evidence[0].text,/不信任/);
});
test('source revision compare, restart reconstruction and duplicate calls do not duplicate or overwrite notes',async t=>{
 const f=await fixture(t),first=f.observe(intro);f.apply(first,0);const ids=f.notes.read(bvid).notes.map(e=>e.id);
 assert.equal(f.notes.append(first.runId,first.observation.id,first.reflection,0).status,'already_applied');
 const next=f.observe(ending);assert.equal(f.apply(next,0).status,'source_changed');assert.equal(f.notes.read(bvid).revision,1);
 f.journal.db.exec('DELETE FROM activity_video_notebooks');const rebuilt=new VideoNotes(f.store).read(bvid);assert.deepEqual(rebuilt.notes.map(e=>e.id),ids);assert.equal(rebuilt.revision,1);assert.equal(f.store.get(first.runId).status,'completed');
});
test('CID, part and legacy text identities stay separate and callers can select an old version',async t=>{
 const f=await fixture(t),d=f.observe('旧版仅有文字。',{legacy:true}),a=f.observe(intro),b=f.observe(ending,{cid:'222'}),c=f.observe('第二P有海鸟。',{page:2});
 for(const r of [d,a,b,c])f.apply(r,0);
 const current=f.notes.read(bvid);assert.equal(current.cid,'222');assert.equal(f.notes.read(bvid,{cid:null}).notes[0].text,'旧版仅有文字。');assert.equal(current.availableVersions.length,3);
 const old=f.notes.read(bvid,{cid:'111'});assert.equal(old.notes.length,1);assert.match(old.notes[0].text,/不信任/);assert.equal(f.notes.read(bvid,{cid:'222'}).notes.length,1);
 assert.throws(()=>f.notes.read(bvid,{cid:'222',evidenceId:old.evidence[0].id}),/未找到/);assert.equal(f.notes.read(bvid,{cid:'999'}).notes.length,0);
});
test('no-save material never becomes a note, an implicit old-version index, or recall evidence',async t=>{
 const f=await fixture(t),r=f.observe('不保存：仅测试的秘密灯塔。',{learn:false});assert.equal(f.apply(r,0).status,'disabled_by_request');const read=f.notes.read(bvid,{query:'灯塔'});assert.equal(read.notes.length,0);assert.equal(read.evidence.length,0);assert.equal(read.availableVersions.length,0);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM activity_video_notebooks').get().n,0);
});
test('empty proposals allow no change and invalid IDs, kinds, arbitrary fields or unsourced revisions fail closed',async t=>{
 const f=await fixture(t),r=f.observe(intro,{videoNotes:[]});assert.equal(f.apply(r,0).status,'no_change');assert.equal(f.notes.read(bvid).revision,0);
 const valid={kind:'question',text:'为什么躲藏？',evidenceId:'excerpt-0'};assert.ok(validateVideoNotes([valid],r.observation.payload));
 for(const entry of [{...valid,evidenceId:'excerpt-999'},{...valid,kind:'fact'},{...valid,permissions:'all'},{...valid,supersedes:['vn-'+'a'.repeat(32)]},{...valid,supersedes:['vn-'+'a'.repeat(32)],reason:'无效引用'}]){
  const bad=f.observe('不同原件'+JSON.stringify(entry),{videoNotes:[entry]});assert.throws(()=>f.apply(bad,0));
 }
 assert.equal(f.journal.db.prepare('SELECT count(*) n FROM activity_video_notebooks').get().n,0);
});
test('two proposals cannot supersede the same old note and a foreign video version cannot be revised',async t=>{
 const f=await fixture(t),r=f.observe(intro);f.apply(r,0);const old=f.notes.read(bvid).notes[0],proposal={kind:'understanding',text:'暂时改变看法。',evidenceId:'excerpt-0',supersedes:[old.id],reason:'新信息'};
 const other=f.observe(ending,{cid:'222',videoNotes:[proposal]});assert.throws(()=>f.apply(other,0),/同版/);
 const double=f.observe('后续有解释。',{videoNotes:[proposal,{...proposal,text:'第二份解释。'}]});assert.throws(()=>f.apply(double,1),/重复/);
});
test('corrupt notes and even rehashed changes to source originals invalidate derived notes',async t=>{
 const f=await fixture(t),r=f.observe(intro);f.apply(r,0);f.journal.db.prepare('UPDATE activity_video_notebooks SET payload_json=?').run('{}');assert.throws(()=>f.notes.read(bvid),/校验/);
 f.journal.db.exec('DELETE FROM activity_video_notebooks');f.notes.read(bvid);const original=f.store.observation(r.observation.id),payload={...original.payload,text:original.payload.text+'篡改'};const raw=JSON.stringify(payload);f.journal.db.prepare('UPDATE activity_observations SET payload_json=?,content_hash=? WHERE id=?').run(raw,hash(raw),r.observation.id);assert.throws(()=>f.notes.read(bvid),/原件/);
});
test('legacy reflections lazily derive deterministic notes without changing old runs or making new evidence',async t=>{
 const f=await fixture(t),r=f.observe('旧字幕：一步一步核验。',{legacy:true}),before=JSON.stringify(f.store.get(r.runId)),count=f.journal.db.prepare('SELECT count(*) n FROM activity_observations').get().n;
 const read=f.notes.read(bvid);assert.equal(read.notes.length,1);assert.deepEqual(read.evidence[0].ranges,[]);assert.equal(JSON.stringify(f.store.get(r.runId)),before);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM activity_observations').get().n,count);
});
test('history pagination and bounded recall retain citation consistency and disclose truncation',async t=>{
 const f=await fixture(t);for(let i=0;i<9;i++){const r=f.observe('海洋观察'+i+'。'.repeat(420),{summary:'暂定理解'+i+'。'.repeat(200)});f.apply(r,i);}
 const read=f.notes.read(bvid,{includeHistory:true,limit:12});assert.ok(JSON.stringify(read).length<=12000);for(const note of read.notes)assert.ok(read.evidence.some(e=>e.id===note.source.id));assert.ok(read.nextBeforeRevision);const next=f.notes.read(bvid,{includeHistory:true,beforeRevision:read.nextBeforeRevision});assert.ok(next.history.every(r=>r.revision<read.nextBeforeRevision));assert.ok(read.retrieval.limited);
});
test('literal retrieval handles quoted query text safely and returns no invented semantic match',async t=>{
 const f=await fixture(t);f.apply(f.observe(intro),0);const read=f.notes.read(bvid,{query:"' OR 1=1 --"});assert.equal(read.evidence.length,0);assert.equal(read.notes.length,0);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM activity_observations').get().n,1);assert.throws(()=>f.notes.read(bvid,{keywords:Array(9).fill('词语')}));
});
test('the shared conversation tool is owner-scoped and only uses the existing activity store',async t=>{
 const f=await fixture(t);f.apply(f.observe(intro),0);const tools=new Map();attachVideoNotes({systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}},{activities:{videoNotes:f.notes},ports:{evidence:{ownerMessage,userEvidence}}});
 const event={type:'user/message',seq:1,data:{id:'owner',source:{kind:'user'},content:[{type:'text',text:'前面视频讲了什么？'}]}},agent={id:'web-fixture',session:{header:{cwd:f.root},seq:2,eventAt:n=>n===1?event:null}};
 const tool=tools.get('friend_video_notes_read'),read=await tool.execute({video:bvid,query:'章鱼'},{agent});assert.ok(read.evidence.length);
 await assert.rejects(()=>tool.execute({video:bvid},{agent:{...agent,session:{...agent.session,eventAt:()=>null}}}));
});
