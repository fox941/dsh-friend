import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import fsSync from 'node:fs';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';import {DatabaseSync} from 'node:sqlite';import {Readable} from 'node:stream';
const project=process.env.AI_FRIEND_PROJECT_ROOT??path.resolve(import.meta.dirname,'..');
const bsource=process.env.FRIEND_BILIBILI_SOURCE??path.join(project,'plugins/bilibili-tool/src'),bload=name=>import(pathToFileURL(path.join(bsource,name)));
const {registerConsoleRoutes,registerConsoleRpc}=await bload('console-web.js');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'friend-bili-console-web-'));
 await fs.mkdir(path.join(root,'companion'),{recursive:true});
 const db=new DatabaseSync(path.join(root,'companion','companion.sqlite'));
 db.exec(`CREATE TABLE activity_runs(id TEXT PRIMARY KEY,day TEXT,trigger TEXT,status TEXT,request_json TEXT,decision_json TEXT,observation_id TEXT,result_json TEXT,error TEXT,created_at TEXT,updated_at TEXT);
 CREATE TABLE activity_control(id INTEGER PRIMARY KEY CHECK(id=1),automatic INTEGER,policy_json TEXT,updated_at TEXT);`);
 const d=today();
 db.prepare("INSERT INTO activity_runs VALUES('run-1',?,'manual','completed',?,NULL,NULL,?,NULL,?,?)").run(d,JSON.stringify({video:'BV1Eb411u7Fw'}),JSON.stringify({summary:'看了章鱼',memory:{verified:true}}),d,d);
 db.prepare("INSERT INTO activity_control VALUES(1,0,?,'2026-10-31T00:00:00Z')").run(JSON.stringify({dailyLimit:3,cooldownMinutes:60}));
 db.close();
 t.after(async()=>{const actual=await fs.realpath(root),parent=await fs.realpath(os.tmpdir());assert.ok(actual.startsWith(parent+path.sep));await fs.rm(actual,{recursive:true,force:true});});
 return {root,dbFile:path.join(root,'companion','companion.sqlite')};
}
function fakeWebServer(){const captured={};return {captured,register(spec){captured.kind=spec.kind;captured.path=spec.path;captured.handler=spec.handler;return ()=>{};}};}
function fakeReq(method,url,body){const req=Readable.from(body?[body]:[]);req.method=method;req.url=url;return req;}
function fakeRes(){const res={statusCode:0,headers:null,body:''};res.writeHead=(code,headers)=>{res.statusCode=code;res.headers=headers;};res.end=text=>{res.body=text;};return res;}

test('面板 API 注册为 prefix 路由，state 返回快照且不含凭据',async t=>{
 const f=await fixture(t);
 const web=fakeWebServer();
 const dispose=registerConsoleRoutes(web,{instance:f.root});
 assert.equal(web.captured.kind,'prefix');assert.equal(web.captured.path,'/dsh-bilibili-tool/api');
 const res=fakeRes();
 await web.captured.handler(fakeReq('GET','/dsh-bilibili-tool/api/state'),res);
 assert.equal(res.statusCode,200);
 const body=JSON.parse(res.body);
 assert.equal(body.ok,true);assert.equal(body.snapshot.initialized,true);assert.equal(body.snapshot.todayActivity.length,1);
 assert.ok(!res.body.includes('sessdata')&&!res.body.includes('bili_jct'));
 assert.equal(typeof dispose,'function');
});

test('HTTP 路由只读：写操作 405，配置应用走 Connection RPC 并保留白名单与审计',async t=>{
 const f=await fixture(t);
 const web=fakeWebServer();
 const handled={};
 const fakeConnection={rpc:{handle(channel,handler){handled.channel=channel;handled.handler=handler;}}};
 registerConsoleRoutes(web,{instance:f.root});
 registerConsoleRpc(fakeConnection,{instance:f.root});
 assert.equal(handled.channel,'/ai-friend-bili-console');
 const denied=fakeRes();
 await web.captured.handler(fakeReq('POST','/dsh-bilibili-tool/api/config',JSON.stringify({changes:{activity:{dailyLimit:5}}})),denied);
 assert.equal(denied.statusCode,405,'原始 HTTP 路由不开放写操作');
 const applied=await handled.handler('config',{changes:{activity:{dailyLimit:5}}},undefined);
 assert.equal(applied.ok,true);assert.deepEqual(applied.applied.map(a=>a.group+'.'+a.key),['activity.dailyLimit']);
 const db=new DatabaseSync(f.dbFile,{readOnly:true});
 try{assert.equal(JSON.parse(db.prepare('SELECT policy_json FROM activity_control').get().policy_json).dailyLimit,5);}finally{db.close();}
 assert.ok(fsSync.existsSync(path.join(f.root,'companion','console','config-audit.jsonl')));
 assert.equal(JSON.parse(fsSync.readFileSync(path.join(f.root,'companion','console','config-audit.jsonl'),'utf8').trim().split('\n').at(-1)).source,'web-ui');
 const bad=await handled.handler('config',{changes:{activity:{dailyLimit:99}}},undefined).then(()=>({ok:true}),error=>({ok:false,message:String(error?.message??error)}));
 assert.equal(bad.ok,false);assert.match(bad.message,/白名单校验/);
 const unknown=await handled.handler('nope',{},undefined).then(()=>({ok:true}),error=>({ok:false,requestInvalid:error.requestInvalid===true}));
 assert.equal(unknown.ok,false);assert.equal(unknown.requestInvalid,true);
});

test('following 端点走真实只读读取并降级',async t=>{
 const f=await fixture(t);
 const web=fakeWebServer();
 registerConsoleRoutes(web,{instance:f.root});
 const res=fakeRes();
 await web.captured.handler(fakeReq('GET','/dsh-bilibili-tool/api/following'),res);
 const body=JSON.parse(res.body);
 assert.equal(body.ok,true);assert.equal(body.following.state,'unconfigured');
});
