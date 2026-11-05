import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import fsSync from 'node:fs';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';import {DatabaseSync} from 'node:sqlite';
const project=process.env.AI_FRIEND_PROJECT_ROOT??path.resolve(import.meta.dirname,'..');
const bsource=process.env.FRIEND_BILIBILI_SOURCE??path.join(project,'plugins/bilibili-tool/src'),bload=name=>import(pathToFileURL(path.join(bsource,name)));
const {consoleSnapshot,consoleHtml,fetchFollowing,writeBilibiliConsole,applyConfigRequest,configFields,configRequestSchema}=await bload('console.js');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const yesterday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(Date.now()-86400000));

async function fixture(t,{credentials=true,empty=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'friend-bili-console-'));
 await fs.mkdir(path.join(root,'companion'),{recursive:true});
 if(credentials)await fs.mkdir(path.join(root,'channels/bilibili'),{recursive:true}),await fs.writeFile(path.join(root,'channels/bilibili/credentials.local.json'),JSON.stringify({sessdata:'fixture-session-secret',bili_jct:'fixture-csrf-secret',dedeuserid:'123'}));
 if(!empty){
  const db=new DatabaseSync(path.join(root,'companion','companion.sqlite'));
  db.exec(`CREATE TABLE activity_runs(id TEXT PRIMARY KEY,day TEXT,trigger TEXT,status TEXT,request_json TEXT,decision_json TEXT,observation_id TEXT,result_json TEXT,error TEXT,created_at TEXT,updated_at TEXT);
  CREATE TABLE activity_observations(id TEXT PRIMARY KEY,canonical TEXT,payload_json TEXT,content_hash TEXT,created_at TEXT);
  CREATE TABLE bili_social_turns(id TEXT PRIMARY KEY,thread_key TEXT,status TEXT,decision_json TEXT,created_at TEXT);
  CREATE TABLE bili_social_outbox(id TEXT PRIMARY KEY,turn_id TEXT,status TEXT,platform_id TEXT,body TEXT,receipt_json TEXT,error TEXT,created_at TEXT);
  CREATE TABLE bili_inbox_events(id TEXT PRIMARY KEY,kind TEXT,sender TEXT,status TEXT,payload_json TEXT,created_at TEXT);
  CREATE TABLE bili_inbox_attempts(id TEXT PRIMARY KEY,event_id TEXT,status TEXT,result_json TEXT,error TEXT,created_at TEXT);
  CREATE TABLE bili_account_actions(id TEXT PRIMARY KEY,action TEXT,bvid TEXT,uid TEXT,account_uid TEXT,status TEXT,reason TEXT,undo_of TEXT,error TEXT,created_at TEXT);
  CREATE TABLE platform_operations(id TEXT PRIMARY KEY,action TEXT,args_json TEXT,reason TEXT,status TEXT,receipt_json TEXT,dispatched INTEGER,created_at TEXT);
  CREATE TABLE activity_control(id INTEGER PRIMARY KEY CHECK(id=1),automatic INTEGER,policy_json TEXT,updated_at TEXT);
  CREATE TABLE bili_inbox_control(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER,next_poll_at INTEGER,updated_at TEXT,account_id TEXT);
  CREATE TABLE bili_social_meta(key TEXT PRIMARY KEY,value TEXT);
  CREATE TABLE bili_account_control(id INTEGER PRIMARY KEY CHECK(id=1),policy_json TEXT NOT NULL,revision INTEGER NOT NULL);
  CREATE TABLE platform_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const d=today(),y=yesterday();
  db.prepare("INSERT INTO activity_runs VALUES('run-today',?,'manual','completed',?,NULL,?,?,NULL,?,?)").run(d,JSON.stringify({video:'BV1Eb411u7Fw'}),'obs-1',JSON.stringify({summary:'作者介绍了章鱼的研究方法',scope:'平台字幕；第1P；未观察画面',memory:{verified:true}}),d,d);
  db.prepare("INSERT INTO activity_runs VALUES('run-old',?,'automatic','rested',?,NULL,NULL,?,NULL,?,?)").run(y,JSON.stringify({}),JSON.stringify({summary:'没有新的可读候选'}),y,y);
  db.prepare("INSERT INTO activity_observations VALUES('obs-1','BV1Eb411u7Fw:1',?,?,'2026-10-30T05:00:00Z')").run(JSON.stringify({title:'章鱼研究<script>alert(1)</script>',url:'https://www.bilibili.com/video/BV1Eb411u7Fw',bvid:'BV1Eb411u7Fw',page:1,scope:'平台字幕；第1P',text:'x'.repeat(400)}),'abc');
  db.prepare("INSERT INTO bili_social_turns VALUES('turn-1','private:777:1','published',?,?)").run(JSON.stringify({disposition:'reply',summary:'对方问章鱼习性',draft:'你好，章鱼会…'}),'2026-10-30T06:00:00Z');
  db.prepare("INSERT INTO bili_social_outbox VALUES('out-1','turn-1','sent','9001','你好，章鱼会…',?,NULL,?)").run(JSON.stringify({readBackVerified:true,publishedBody:'回复 @测试用户 :你好，章鱼会…'}),'2026-10-30T06:01:00Z');
  db.prepare("INSERT INTO bili_inbox_events VALUES('event-1','private','777','processed',?,?)").run(JSON.stringify({text:'请问章鱼怎么养？',account:'123'}),'2026-10-30T06:00:00Z');
  db.prepare("INSERT INTO bili_inbox_attempts VALUES('att-1','event-1','processed',?,NULL,?)").run(JSON.stringify({disposition:'reply'}),'2026-10-30T06:00:30Z');
  db.prepare("INSERT INTO bili_account_actions VALUES('acc-1','favorite','BV1Eb411u7Fw',NULL,'123','confirmed','看完后想留作复看',NULL,NULL,?)").run(d+'T06:30:00Z');
  db.prepare("INSERT INTO platform_operations VALUES('op-1','bili_coin',?,?,'accepted',?,1,?)").run(JSON.stringify({bvid:'BV1Eb411u7Fw',count:1}),'真实观看后投币支持',JSON.stringify({verified:true}),d+'T06:35:00Z');
  db.prepare("INSERT INTO platform_operations VALUES('op-2','qq_group_join','{}','加群','queued','{}',0,?)").run(d+'T06:36:00Z');
  db.prepare("INSERT INTO activity_control VALUES(1,0,?,?)").run(JSON.stringify({dailyLimit:3,cooldownMinutes:60}),'2026-10-30T00:00:00Z');
  db.prepare("INSERT INTO bili_inbox_control VALUES(1,1,0,NULL,'123')").run();
  db.prepare("INSERT INTO bili_social_meta VALUES('outgoing','true')").run();
  db.prepare("INSERT INTO bili_account_control VALUES(1,?,0)").run(JSON.stringify({enabled:true,autonomous:true,dailyLimit:12,cooldownSeconds:60,folderId:null}));
  db.prepare("INSERT INTO platform_meta VALUES('legacy-fixture-policy','[]')").run();
  db.close();
 }
 t.after(async()=>{const actual=await fs.realpath(root),parent=await fs.realpath(os.tmpdir());assert.ok(actual.startsWith(parent+path.sep));await fs.rm(actual,{recursive:true,force:true});});
 return {root,dbFile:path.join(root,'companion','companion.sqlite')};
}

test('今日观看只包含当天记录，近期记录保留作后备展示',async t=>{
 const f=await fixture(t),s=consoleSnapshot(f.root,{day:today()});
 assert.equal(s.initialized,true);assert.equal(s.todayActivity.length,1);assert.equal(s.todayActivity[0].id,'run-today');
 assert.equal(s.recentActivity.some(r=>r.id==='run-old'),true);
 assert.equal(s.observations['obs-1'].title,'章鱼研究<script>alert(1)</script>','快照是数据层，保留原始标题；转义由 HTML 层负责');
 assert.equal(s.social[0].disposition,'reply');assert.equal(s.outboxes[0].readBackVerified,true);
 assert.equal(s.events[0].text.includes('章鱼'),true);assert.equal(s.attempts[0].result.disposition,'reply');
 assert.equal(s.accountActions[0].action,'favorite');assert.equal(s.platformOps.filter(o=>o.action.startsWith('bili_')).length,1);
 assert.equal(s.platformOps.some(o=>o.action==='qq_group_join'),false,'控制台只展示B站写操作');
 assert.equal(s.config.activity.automatic,false);assert.equal(s.config.socialOutgoing,'true');
});

test('空库与未初始化实例不抛错且没有凭据字段进入任何输出',async t=>{
 const f=await fixture(t,{credentials:false,empty:true});
 const missing=consoleSnapshot(f.root);assert.equal(missing.initialized,false);
 fsSync.writeFileSync(path.join(f.root,'companion','companion.sqlite'),'');
 const db=new DatabaseSync(path.join(f.root,'companion','companion.sqlite'));db.close();
 const s=consoleSnapshot(f.root);assert.equal(s.initialized,true);assert.deepEqual(s.todayActivity,[]);assert.deepEqual(s.social,[]);
 const html=consoleHtml(s,null);assert.ok(html.includes('配置与开关'));
});

test('HTML 输出转义脚本注入并展示全部区块，不包含凭据',async t=>{
 const f=await fixture(t),s=consoleSnapshot(f.root,{day:today()}),html=consoleHtml(s,{state:'ready',total:1,list:[{mid:'999',name:'关注的UP主<script>',sign:''}]});
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert'));
 assert.ok(html.includes('#watch')&&html.includes('#social')&&html.includes('#events')&&html.includes('#account')&&html.includes('#platform')&&html.includes('#config')&&html.includes('#following'));
 assert.ok(html.includes('关注的UP主&lt;script&gt;'));
 assert.ok(!html.includes('fixture-session-secret')&&!html.includes('fixture-csrf-secret'));
});

test('关注列表走真实只读接口并映射结果，凭据只出现在请求头',async t=>{
 const f=await fixture(t);let seen;
 const fake=async(url,init)=>{seen={url,cookie:init.headers.cookie};return {ok:true,json:async()=>({code:0,data:{total:2,list:[{mid:999,uname:'UP主A',sign:'研究海洋'},{mid:1000,uname:'UP主B'}]}})};};
 const r=await fetchFollowing(f.root,{request:fake});
 assert.equal(seen.url.includes('vmid=123'),true);assert.match(seen.cookie,/SESSDATA=fixture-session-secret/);
 assert.equal(r.state,'ready');assert.equal(r.total,2);assert.deepEqual(r.list[0],{mid:'999',name:'UP主A',sign:'研究海洋'});
 const refuse=async()=>({ok:true,json:async()=>({code:-101,message:'账号未登录'})});
 assert.equal((await fetchFollowing(f.root,{request:refuse})).state,'expired');
});

test('writeBilibiliConsole 写出固定路径文件，live=false 时标注未获取关注列表',async t=>{
 const f=await fixture(t);
 const quiet=await writeBilibiliConsole(f.root,{live:false});
 assert.equal(quiet.following,null);assert.ok(fsSync.existsSync(quiet.file));
 const html=fsSync.readFileSync(quiet.file,'utf8');
 assert.ok(html.includes('本次未获取关注列表'));
 assert.ok(!html.includes('fixture-session-secret')&&!html.includes('fixture-csrf-secret'));
 const live=await writeBilibiliConsole(f.root,{live:true,request:async()=>({ok:false,status:503})});
 assert.equal(live.following.state,'unavailable');
});

test('白名单内变更按组写入对应表，并追加审计文件',async t=>{
 const f=await fixture(t);
 const request={schema:configRequestSchema,requestedAt:'2026-10-31T08:00:00Z',changes:{activity:{automatic:true,dailyLimit:5},inbox:{enabled:false},social:{outgoing:false},account:{dailyLimit:20}}};
 const result=applyConfigRequest(f.root,request,{sourceFile:'config-request.json'});
 assert.equal(result.applied.filter(a=>a.group==='activity').length,2);
 const db=new DatabaseSync(f.dbFile,{readOnly:true});
 try{
  const control=db.prepare('SELECT automatic,policy_json FROM activity_control').get();
  assert.equal(control.automatic,1);assert.equal(JSON.parse(control.policy_json).dailyLimit,5);assert.equal(JSON.parse(control.policy_json).cooldownMinutes,60,'未修改字段保留');
  const inbox=db.prepare('SELECT enabled,next_poll_at FROM bili_inbox_control').get();
  assert.equal(inbox.enabled,0);assert.equal(inbox.next_poll_at,0);
  assert.equal(db.prepare("SELECT value FROM bili_social_meta WHERE key='outgoing'").get().value,'false');
  const account=db.prepare('SELECT policy_json,revision FROM bili_account_control').get();
  assert.equal(JSON.parse(account.policy_json).dailyLimit,20);assert.equal(account.revision,1);
 }finally{db.close();}
 const audit=JSON.parse((await fs.readFile(path.join(f.root,'companion','console','config-audit.jsonl'),'utf8')).trim().split('\n').at(-1));
 assert.equal(audit.source,'console-request');assert.equal(audit.changes.account.dailyLimit,20);assert.equal(audit.requestedAt,'2026-10-31T08:00:00Z');
});

test('越界、未知字段或坏格式在写入前整体拒绝',async t=>{
 const f=await fixture(t),before=consoleSnapshot(f.root);
 assert.throws(()=>applyConfigRequest(f.root,{schema:configRequestSchema,changes:{activity:{dailyLimit:99}}}),/白名单校验/);
 assert.throws(()=>applyConfigRequest(f.root,{schema:configRequestSchema,changes:{activity:{hacked:true}}}),/不支持字段/);
 assert.throws(()=>applyConfigRequest(f.root,{schema:configRequestSchema,changes:{unknownGroup:{x:1}}}),/未知分组/);
 assert.throws(()=>applyConfigRequest(f.root,{schema:'ai-friend-bili-config-request/9',changes:{inbox:{enabled:true}}}),/格式或版本/);
 assert.throws(()=>applyConfigRequest(f.root,{schema:configRequestSchema,changes:{}}),/没有任何字段/);
 const after=consoleSnapshot(f.root);
 assert.deepEqual(after.config.activity.policy,{dailyLimit:3,cooldownMinutes:60});
 assert.deepEqual(after.config.account.policy,{enabled:true,autonomous:true,dailyLimit:12,cooldownSeconds:60,folderId:null});
 assert.equal(fsSync.existsSync(path.join(f.root,'companion','console','config-audit.jsonl')),false,'被拒绝的请求不留审计');
});

test('页面表单覆盖全部白名单字段并包含请求生成脚本',async t=>{
 const f=await fixture(t),s=consoleSnapshot(f.root,{day:today()}),html=consoleHtml(s,null);
 assert.ok(html.includes('cfg-submit'));assert.ok(html.includes('showSaveFilePicker'));assert.ok(html.includes('Bilibili-Config.cmd'));
 for(const group of configFields)for(const field of group.fields)assert.ok(html.includes(`data-group="${group.group}" data-key="${field.key}"`),group.group+'.'+field.key);
 assert.ok(!html.includes('fixture-session-secret'));
});
