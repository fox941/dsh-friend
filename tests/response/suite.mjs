import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const workRoot = path.dirname(fileURLToPath(import.meta.url));
const project = process.env.AI_FRIEND_PROJECT_ROOT??fileURLToPath(new URL('../../',import.meta.url));
const {installAdapter}=await import(pathToFileURL(path.join(project,'scripts/install-adapter.mjs')));
const sourceDirectory=process.env.AI_FRIEND_ADAPTER_DIRECTORY??path.join(project,'plugins/companion-adapter');
if(process.env.AI_FRIEND_RUN_MODEL_TESTS!=='1')throw new Error('Set AI_FRIEND_RUN_MODEL_TESTS=1; this isolated test uses configured API quota.');
const instance = path.join(project,'.work/response-acceptance', `instance-${crypto.randomUUID()}`);
const outputRoot = path.join(project,'.work/response-acceptance');
const key = JSON.parse(await fs.readFile(path.join(project,'runtime/dev/credentials.local.json'),'utf8')).DEEPSEEK_API_KEY;
if (typeof key !== 'string' || !key) throw new Error('A configured API credential is required');
const clean = text => String(text).replaceAll(key,'[redacted]');
const marker = `松塔${crypto.randomInt(100000,999999)}`;
const deadline = Date.now()+20*60*1000;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const testEnv={...process.env,DEEPSEEK_API_KEY:key,DSH_HOME:path.join(instance,'dsh-home'),MNEMON_DATA_DIR:path.join(instance,'memory','native-default'),MNEMON_MAX_INSIGHTS:'0',MNEMON_EMBED_ENDPOINT:'http://127.0.0.1:9',MNEMON_EMBED_PROTOCOL:'ollama',AI_FRIEND_TEST_INSTANCE:instance};
testEnv.PATH=path.dirname(process.execPath)+';'+path.join(project,'.tools/package-manager/node_modules/.bin')+';'+(process.env.PATH??'');
const report={startedAt:new Date().toISOString(),phase:'running',model:'deepseek-official/deepseek-flash',dsh:'0.2.1-rc.3',mnemon:'0.5.36',native:'0.2.13',qqChannelEnabled:true,realQQLogin:false,onebotEndpoint:'local protocol simulator',actualDeepSeek:true,scope:'Isolated 0.11.0 DSH Host and real DeepSeek, authenticated local OneBot WebSocket simulator; fake account IDs and replies never leave loopback. This does not prove a real QQ login or real QQ delivery.',instanceRoot:instance,cases:[],notes:[],errors:[]};
let child, client, launch=0;
async function save() {
  await fs.mkdir(outputRoot,{recursive:true});
  const text=clean(JSON.stringify(report,null,2)+'\n');
  if(text.includes(key)) throw new Error('Secret redaction failed');
  await fs.writeFile(path.join(outputRoot,'response-acceptance.json'),text);
}
function emit(value){ console.log(clean(JSON.stringify(value))); }
async function fingerprint() {
  const root=path.join(project,'runtime/dev/memory');
  const files={};
  async function visit(dir){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const name=path.join(dir,entry.name);
      if(entry.isDirectory()) await visit(name);
      else if(entry.isFile()&&!/-(?:shm|wal)$/.test(name)) files[path.relative(root,name)]=crypto.createHash('sha256').update(await fs.readFile(name)).digest('hex');
    }
  }
  await visit(root); await visit(path.join(project,'runtime/dev/companion')); return files;
}
const productionBefore=await fingerprint();
async function freePort(){
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve)); return port;
}
async function startHost(){
  launch++;
  const port=await freePort();
  const out=path.join(instance,`host-${launch}.out.log`),err=path.join(instance,`host-${launch}.err.log`);
  const stdout=fsSync.openSync(out,'a'),stderr=fsSync.openSync(err,'a');
  child=spawn(process.execPath,[path.join(workRoot,'host.mjs')],{cwd:path.join(instance,'workspace'),env:{...testEnv,AI_FRIEND_TEST_PORT:String(port)},windowsHide:true,stdio:['ignore',stdout,stderr,'ipc']});
  fsSync.closeSync(stdout); fsSync.closeSync(stderr);
  const readyBy=Date.now()+45000;
  let url;
  while(Date.now()<readyBy){
    if(child.exitCode!==null)throw new Error(`Test host exited (${child.exitCode}); private error log: ${err}`);
    const text=await fs.readFile(out,'utf8');
    url=text.match(new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/[^\\r\\n ]*)`))?.[1];
    if(url)break;
    await sleep(500);
  }
  if(!url)throw new Error('Isolated host readiness timed out');
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(response.status!==303)throw new Error(`Test authentication failed (${response.status})`);
  const cookie=response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');
  if(!cookie)throw new Error('Test session cookie missing');
  const origin=new URL(url).origin;
  client={async rpc(method,args={}){
    const response=await fetch(`${origin}/api/${method}`,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}}),signal:AbortSignal.timeout(60000)});
    const body=await response.text();
    let envelope;
    try { envelope=JSON.parse(body); } catch { throw new Error(`RPC ${method} returned non-JSON HTTP ${response.status}`); }
    if(!response.ok||!envelope.result?.ok)throw new Error(`RPC ${method} failed: ${JSON.stringify(envelope.result?.error??envelope.error??{})}`);
    return envelope.result.value;
  }};
  const status=(await client.rpc('dshMnemon/read',{endpoint:'status',payload:{}})).value;
  if(!status.commandFound||!status.memorySystem.serving||path.resolve(status.dataDir)!==path.resolve(instance,'memory'))throw new Error('Test memory isolation is not active');
  emit({event:'host-ready',launch,isolated:true,port});
}
async function stopHost(){
  if(!child||child.exitCode!==null)return;
  const stopped=new Promise(resolve=>child.once('exit',resolve));
  if(child.connected)child.send({command:'stop'});
  let stopTimer;
  const exited=await Promise.race([stopped.then(()=>true),new Promise(resolve=>{stopTimer=setTimeout(()=>resolve(false),30000);})]);
  clearTimeout(stopTimer);
  if(!exited){
    report.notes.push('The isolated host required termination after a 30s graceful shutdown timeout. No user host was targeted.');
    child.kill(); await stopped;
  }
  emit({event:'host-stopped',launch});
}
async function setup(){
  for(const dir of ['workspace','memory','dsh-home/profiles/web'])await fs.mkdir(path.join(instance,dir),{recursive:true});
  const source=path.join(project,'runtime/dev/dsh-home/profiles/web');
  const target=path.join(instance,'dsh-home/profiles/web');
  for(const name of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.yml'])await fs.copyFile(path.join(source,name),path.join(target,name));
  await fs.cp(path.join(source,'.friend-packages'),path.join(target,'.friend-packages'),{recursive:true});
  // DSH's peer resolver is profile-scoped; dependencies must live within the test profile.
  execFileSync(process.execPath,[path.join(project,'.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs'),'--dir',target,'install','--frozen-lockfile','--store-dir',path.join(project,'.work/pnpm-store'),'--config.confirmModulesPurge=false','--fetch-timeout','60000','--fetch-retries','1'],{cwd:target,env:testEnv,encoding:'utf8',windowsHide:true,timeout:180000,stdio:['ignore','pipe','pipe']});
  const require=createRequire(await fs.realpath(path.join(project,'node_modules/@deepseek-ai/dsh/package.json')));
  const yaml=require('js-yaml');
  const patches=yaml.load(await fs.readFile(path.join(source,'cordis.patch.yml'),'utf8'));
  const mnemon=patches.find(row=>row.id==='mnemon');
  if(!mnemon)throw new Error('Configured Mnemon patch is missing');
  mnemon.config.dataDir=path.join(instance,'memory');
  mnemon.config.runtimeUserScope='storage';
  mnemon.config.syncEnabled=false;
  mnemon.config.idleReview={enabled:false,maxPerSession:0};
  let friend=patches.find(row=>row.id==='friend-adapter');if(!friend){friend={id:'friend-adapter',config:{}};patches.push(friend);}friend.config??={};friend.config.nightly={enabled:false};
  await fs.writeFile(path.join(target,'cordis.patch.yml'),yaml.dump(patches,{lineWidth:120,noRefs:true}));
  report.adapterInstall=await installAdapter({projectRoot:project,instanceRoot:instance,sourceDirectory});
  await startMock();
  await fs.mkdir(path.join(instance,'channels/qq'),{recursive:true});
  await fs.writeFile(path.join(instance,'channels/qq/config.local.json'),JSON.stringify({schema:'ai-friend-qq/1',enabled:true,bindingId:crypto.randomUUID(),ownerQQ:owner,botQQ:bot,url:'ws://127.0.0.1:'+mockPort,accessToken:mockToken}));
  await startHost();
  const presets=await client.rpc('agentPresets/list');
  if(presets.presets.find(row=>row.id==='companion')?.broken)throw new Error('Companion adapter broke preset composition');
  const created=await client.rpc('dshMnemon/write',{endpoint:'body-create',payload:{name:'隔离验收记忆',description:'仅用于聊天与记忆测试的虚构资料，不代表真实用户，也不得写入其他实例。'}});
  if(!created.ok)throw new Error('Cannot create isolated memory space');
  const activated=await client.rpc('dshMnemon/activation',{endpoint:'body',payload:{memoryBodyId:created.value.id,active:true}});
  if(!activated.ok)throw new Error('Cannot activate isolated memory space');
  report.memorySpace=created.value.id;
  const cliEnv={...testEnv};delete cliEnv.DEEPSEEK_API_KEY;execFileSync(path.join(project,'.tools/mnemon-0.2.13/mnemon.exe'),['--data-dir',path.join(instance,'memory'),'--store','default','status'],{env:cliEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const catalog=await client.rpc('session/modelCatalog');
  if(catalog.default.provider!=='deepseek-official'||catalog.default.model!=='deepseek-flash')throw new Error('Unexpected test model route');
  report.isolation={separateDshHome:true,separateMemoryRoot:true,separateWorkspace:true,independentDependencyCopy:true};
  await save();
}
async function newSession(label){
  const session=await client.rpc('session/create',{request:{sessionId:`session-${crypto.randomUUID()}`,cwd:path.join(instance,'workspace'),agentPreset:'companion'}});
  await client.rpc('session/rename',{request:{sessionId:session.sessionId,title:`[隔离验收] ${label}`}});
  return session.sessionId;
}
async function page(sessionId){
  const projection=await client.rpc('session/projections',{request:{sessionId}});
  return await client.rpc('session/page',{request:{address:{kind:'session',sessionId},throughSeq:projection.asOfSeq,maxMessages:150}});
}
async function memorySnapshot(){
  const runtime=(await client.rpc('dshMnemon/read',{endpoint:'runtime-memory',payload:{}})).value;
  const dbFile=path.join(instance,'memory/data/default/mnemon.db');
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try{return {runtimeEntries:runtime.entries,nativeRows:db.prepare('SELECT id,content,category,importance,source,created_at,updated_at,deleted_at FROM insights ORDER BY created_at,id').all(),edges:db.prepare('SELECT source_id,target_id,edge_type FROM edges').all(),operations:db.prepare('SELECT operation,insight_id FROM oplog ORDER BY id').all()};}
  finally{db.close();}
}
function growthSnapshot(){
  const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});
  try{return {identityId:db.prepare("SELECT value FROM growth_meta WHERE key='identity'").get().value,revision:Number(db.prepare("SELECT value FROM growth_meta WHERE key='revision'").get().value),heads:db.prepare('SELECT v.* FROM growth_heads h JOIN growth_versions v ON v.id=h.version_id ORDER BY v.rowid').all().map(row=>({...row,supports:JSON.parse(row.supports),dependencies:JSON.parse(row.dependencies)})),batches:db.prepare('SELECT id,status,review,receipt,source_id,last_error FROM growth_batches ORDER BY rowid').all().map(row=>({...row,review:row.review?JSON.parse(row.review):null,receipt:row.receipt?JSON.parse(row.receipt):null})),reviewCalls:db.prepare('SELECT coalesce(sum(started_calls),0) AS n FROM growth_budget').get().n};}finally{db.close();}
}
async function turn(id,sessionId,prompt,expectation){
  if(Date.now()>deadline)throw new Error('Suite time budget reached');
  const prior=await client.rpc('session/projections',{request:{sessionId}});
  const start=Date.now();
  await client.rpc('session/prompt',{request:{requestId:crypto.randomUUID(),sessionId,mode:'queue',content:[{type:'text',text:prompt}],clientTimeZone:'Asia/Shanghai'}});
  let history,end,lastProgress=Date.now();
  while(Date.now()-start<180000){
    history=await page(sessionId);
    const events=history.records.map(row=>row.event).filter(event=>event.seq>prior.asOfSeq);
    end=events.findLast(event=>event.type==='turn/end');
    if(end)break;
    const question=events.findLast(event=>event.type==='tool/call'&&event.data.name==='ask_user_question');
    if(question){await client.rpc('session/cancel',{request:{sessionId}}).catch(()=>{});throw new Error('Isolated test requested clarification; no answer was fabricated.');}
    if(Date.now()-lastProgress>20000){emit({event:'turn-pending',case:id,elapsedSeconds:Math.round((Date.now()-start)/1000)});lastProgress=Date.now();}
    await sleep(900);
  }
  if(!end){await client.rpc('session/cancel',{request:{sessionId}}).catch(()=>{});throw new Error(`Test turn timed out: ${id}`);}
  const events=history.records.map(row=>row.event).filter(event=>event.seq>prior.asOfSeq);
  const text=events.filter(event=>event.type==='assistant/message').flatMap(event=>event.data.message.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
  const tools=events.filter(event=>event.type==='tool/call').map(event=>({name:event.data.name,arguments:event.data.arguments}));
  const usage=events.filter(event=>event.type==='assistant/message').map(event=>event.data.usage).filter(Boolean);
  const snapshot=await memorySnapshot();
  const toolResults=events.filter(event=>event.type.startsWith('tool/')&&event.type!=='tool/call');
  const item={id,sessionId,prompt,expectation,response:text,tools,toolResults,elapsedMs:Date.now()-start,turnReason:end.data.reason,usage,snapshot,growth:growthSnapshot(),daily:qqState(),status:'needs-review'};
  report.cases.push(item);
  await save();
  emit({event:'turn-complete',case:id,seconds:Math.round(item.elapsedMs/1000),tools:tools.map(tool=>tool.name),response:text.slice(0,650)});
  return item;
}
function check(item,passed,details){item.status=passed&&item.turnReason?.kind==='completed'?'passed':'failed';item.automatedCheck={...details,turnCompleted:item.turnReason?.kind==='completed'};}
function activeRows(item){return item.snapshot.nativeRows.filter(row=>!row.deleted_at);}
function recalled(item){return item.tools.some(tool=>/mnemon.*recall/.test(tool.name));}

const owner='123456789',bot='987654321',mockToken=crypto.randomBytes(32).toString('hex');let mock,mockPort,sockets=new Set(),sent=[],loginCalls=0,dropReply=false,wireId=1000;
async function startMock(){
 let wsPackage;for(const entry of [path.join(project,'runtime/dev/dsh-home/profiles/web/node_modules/@ai-friend/companion-adapter/package.json'),path.join(workRoot,'../package.json')]){try{wsPackage=createRequire(await fs.realpath(entry).catch(()=>entry))('ws');break;}catch{}}if(!wsPackage)throw new Error('Test WebSocket dependency missing');
 mock=new wsPackage.WebSocketServer({host:'127.0.0.1',port:0,maxPayload:1048576});await new Promise((resolve,reject)=>{mock.once('listening',resolve);mock.once('error',reject);});mockPort=mock.address().port;
 mock.on('connection',(socket,request)=>{if(request.headers.authorization!=='Bearer '+mockToken){socket.close(4401);return;}sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('message',bytes=>{const message=JSON.parse(bytes.toString());if(message.action==='get_login_info'){loginCalls++;socket.send(JSON.stringify({status:'ok',retcode:0,data:{user_id:Number(bot),nickname:'隔离测试账号'},echo:message.echo}));return;}if(message.action==='send_private_msg'){if(String(message.params.user_id)!==owner)throw new Error('Test attempted to send to an unbound destination');sent.push(message.params);if(dropReply){dropReply=false;socket.terminate();return;}socket.send(JSON.stringify({status:'ok',retcode:0,data:{message_id:2000+sent.length},echo:message.echo}));return;}throw new Error('Unexpected OneBot action: '+message.action);});});
}
async function ready(){for(let n=0;n<150;n++){if(sockets.size&&loginCalls){await sleep(100);return;}await sleep(100);}throw new Error('QQ transport did not authenticate to mock OneBot');}
async function closeMock(){for(const socket of sockets)socket.terminate();if(mock)await new Promise(resolve=>mock.close(resolve));}
function qqState(){const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});try{return {plans:db.prepare('SELECT * FROM qq_reply_plans ORDER BY rowid').all(),replyEvents:db.prepare('SELECT * FROM qq_reply_events ORDER BY id').all(),binding:db.prepare('SELECT * FROM qq_bindings WHERE active=1').get(),inbox:db.prepare('SELECT id,platform_id,message_id,session_id,body,status,event_seq,turn,error FROM qq_inbox ORDER BY rowid').all(),outbox:db.prepare('SELECT id,inbox_id,part,status,body,error FROM qq_outbox ORDER BY rowid').all(),reviewCalls:db.prepare('SELECT coalesce(sum(started_calls),0) n FROM apply_conversation_budget').get().n};}finally{db.close();}}
function sendQQ(body,{id=++wireId,user=owner,type='private'}={}){const socket=[...sockets][0];if(!socket)throw new Error('Mock has no authenticated client');socket.send(JSON.stringify({post_type:'message',message_type:type,sub_type:'friend',self_id:Number(bot),user_id:Number(user),message_id:id,time:Math.floor(Date.now()/1000),sender:{user_id:Number(user),nickname:'隔离测试主用户'},message:[{type:'text',data:{text:body}}]}));return String(id);}
async function qqTurn(id,prompt,{unknown=false}={}){
 await ready();const start=Date.now(),platformId=sendQQ(prompt);let state,row;
 while(Date.now()-start<180000){state=qqState();row=state.inbox.find(item=>item.platform_id===platformId);if(row?.status==='replied'||unknown&&row&&state.outbox.some(item=>item.inbox_id===row.id&&item.status==='unknown'))break;if(row?.status==='interrupted')throw new Error('QQ turn interrupted: '+row.error);await sleep(200);}
 if(!row||!['replied','completed'].includes(row.status))throw new Error('QQ turn did not complete: '+id+'; '+JSON.stringify(row));
 const history=await page(row.session_id),events=history.records.map(item=>item.event),response=state.outbox.filter(item=>item.inbox_id===row.id).map(item=>item.body).join(''),tools=events.filter(item=>item.type==='tool/call'&&item.seq>row.event_seq).map(item=>item.data.name),item={id,prompt,platformId,response,tools,qq:state,snapshot:await memorySnapshot(),growth:growthSnapshot(),status:'needs-review',elapsedMs:Date.now()-start};report.cases.push(item);await save();emit({event:'qq-turn-complete',case:id,seconds:Math.round(item.elapsedMs/1000),tools,response:response.slice(0,350)});return item;
}
const checkQQ=(item,passed,details={})=>{item.status=passed?'passed':'failed';item.automatedCheck=details;};
const facts=value=>JSON.stringify({runtime:value.runtimeEntries,native:value.nativeRows.filter(row=>!row.deleted_at).map(({id,content})=>({id,content}))});
async function responseTurn(id,prompt,expected){
 await ready();const start=Date.now(),platformId=sendQQ(prompt);let state,row,plan;
 while(Date.now()-start<180000){state=qqState();row=state.inbox.find(x=>x.platform_id===platformId);plan=state.plans.find(x=>x.inbox_id===row?.id);if(row&&['replied','silent','deferred','superseded','expired'].includes(row.status))break;if(row?.status==='interrupted')throw new Error('QQ turn interrupted: '+row.error);await sleep(150);}
 if(!row||!['replied','silent','deferred','superseded','expired'].includes(row.status))throw new Error('Response turn timed out: '+id);
 const history=await page(row.session_id),events=history.records.map(x=>x.event).filter(x=>x.seq>row.event_seq),end=events.find(x=>x.type==='turn/end');
 const bounded=events.filter(x=>!end||x.seq<=end.seq),toolResults=bounded.filter(x=>x.type==='tool/result'),tools=bounded.filter(x=>x.type==='tool/call').map(x=>({name:x.data.name,arguments:x.data.arguments}));
 const item={id,prompt,platformId,plan,row,tools,toolResults,turnReason:end?.data.reason,response:state.outbox.filter(x=>x.inbox_id===row.id).map(x=>x.body).join(''),status:'needs-review',elapsedMs:Date.now()-start};
 report.cases.push(item);await save();emit({event:'response-turn',case:id,seconds:Math.round(item.elapsedMs/1000),intent:plan?.action,state:plan?.status,tools:tools.map(x=>x.name)});
 checkQQ(item,plan?.action===expected&&toolResults.every(x=>!x.data.message?.isError)&&end?.data.reason?.kind==='completed',{expectedIntent:expected});return item;
}
async function waitPlan(id,status){const until=Date.now()+35000;while(Date.now()<until){const p=qqState().plans.find(x=>x.inbox_id===id);if(p?.status===status)return p;await sleep(150);}throw new Error('Expected reply state '+status);}
try{
 await setup();await ready();report.adapterVersion='0.11.0';report.sourceDigest=report.adapterInstall.sourceDigest;
 const saved=await qqTurn('qq-memory-write','我平时喝茶喜欢不加糖的乌龙茶，以后聊到饮品可以记得这个偏好。简单确认。');checkQQ(saved,saved.tools.includes('friend_memory_write')&&saved.snapshot.runtimeEntries.some(x=>/乌龙茶/.test(x.content)),{sharedMemoryWrite:true});
 const web=await newSession('网页与QQ仍共用记忆'),read=await turn('web-shared-memory',web,'我平时喝茶是什么偏好？只根据保存的资料回答，不更新记忆。','Web sees QQ durable fact');check(read,/乌龙茶/.test(read.response)&&read.toolResults.every(x=>!x.data.message?.isError),{sameMemory:true});
 const normal=await responseTurn('normal-question','不要保存这条测试记忆。一个星期有几天？请简短回答。','reply');checkQQ(normal,normal.status==='passed'&&/七|7/.test(normal.response),{normalQuestionAnswered:true});
 let sentBefore=sent.length;const quiet=await responseTurn('explicit-closing-silence','这段聊完了，晚安。不要保存这条测试。请用 friend_qq_reply_plan 设置 action=silent、category=closing，理由写我已结束对话。这条不需要发文字。','silent');checkQQ(quiet,quiet.status==='passed'&&sent.length===sentBefore&&quiet.row.status==='silent',{noNetworkSend:true});
 const delayed=await responseTurn('defer-then-restart','这是延后发送机制测试，不要保存记忆。请用 friend_qq_reply_plan 设置 action=defer、category=other、delaySeconds=20，理由写主用户要求测试延后。正文只写“延后正文甲”。','defer');const due=delayed.plan?.due_at,prepared=qqState().outbox.filter(x=>x.inbox_id===delayed.row.id);await stopHost();await startHost();await ready();const restored=qqState().plans.find(x=>x.inbox_id===delayed.row.id);await waitPlan(delayed.row.id,'delivered');checkQQ(delayed,delayed.status==='passed'&&restored.due_at===due&&prepared.map(x=>x.body).join('')==='延后正文甲'&&qqState().outbox.filter(x=>x.inbox_id===delayed.row.id).every(x=>x.status==='sent'),{deadlineSurvivedRestart:true,noModelRegeneration:true});
 const stale=await responseTurn('new-message-supersedes','不要保存记忆。再做延后测试：用 friend_qq_reply_plan 设置 action=defer、category=other、delaySeconds=20，理由写测试新消息取代。正文只写“旧草稿乙”。','defer');sentBefore=sent.length;
 const fresh=await responseTurn('new-topic','前一条延后测试取消，换个话题。只回复“新话题收到”，不要保存记忆。','reply');await sleep(21000);checkQQ(stale,stale.status==='passed'&&qqState().plans.find(x=>x.inbox_id===stale.row.id).status==='superseded'&&!sent.slice(sentBefore).some(x=>x.message.some(y=>y.data.text.includes('旧草稿乙'))),{staleBodyNeverSent:true});checkQQ(fresh,fresh.status==='passed'&&/新话题收到/.test(fresh.response),{newTurnIndependent:true});
 const cancelled=await responseTurn('web-cancels-deferred','不要保存记忆。用 friend_qq_reply_plan 设置 action=defer、category=other、delaySeconds=20，理由写测试网页取消。正文只写“待取消草稿丙”。','defer');
 const cancel=await turn('web-cancel-tool',web,'请取消尚未发出的QQ延后回复。只调用 friend_qq_reply_cancel，requestQuote 使用我的本句原文；不要保存记忆。','Web cancels same bound QQ queue');check(cancel,cancel.tools.some(x=>x.name==='friend_qq_reply_cancel')&&cancel.toolResults.every(x=>!x.data.message?.isError)&&qqState().plans.find(x=>x.inbox_id===cancelled.row.id).status==='cancelled',{explicitCancellation:true});checkQQ(cancelled,cancelled.status==='passed'&&cancel.status==='passed',{cancelledWithAudit:true});
 const status=await turn('response-status-tool',web,'只用 friend_qq_status 查看当前QQ回应队列。简短说明是否有等待发送的回复，不保存记忆。','Status returns strict JSON and no body/credentials');check(status,status.tools.some(x=>x.name==='friend_qq_status')&&status.toolResults.every(x=>!x.data.message?.isError),{statusExposed:true});
 report.finalQQ=qqState();report.simulatedSends=sent.length;report.phase='completed';
}catch(error){report.phase='failed';report.errors.push(clean(error.stack??error.message));emit({event:'suite-error',message:clean(error.message)});}
finally{await stopHost().catch(error=>report.errors.push(clean(error.message)));await closeMock();report.productionMemoryFilesUnchanged=JSON.stringify(productionBefore)===JSON.stringify(await fingerprint());report.finishedAt=new Date().toISOString();report.rootTurns=report.cases.filter(x=>x.prompt).length;report.automatedSummary={passed:report.cases.filter(x=>x.status==='passed').length,failed:report.cases.filter(x=>x.status==='failed').length,pending:report.cases.filter(x=>x.status==='needs-review').length};report.testHostStopped=child?.exitCode!==null;await save();emit({event:'suite-finished',phase:report.phase,...report.automatedSummary,rootTurns:report.rootTurns,productionMemoryFilesUnchanged:report.productionMemoryFilesUnchanged,testHostStopped:report.testHostStopped});if(report.phase!=='completed'||report.automatedSummary.failed||report.automatedSummary.pending||!report.productionMemoryFilesUnchanged||!report.testHostStopped)process.exitCode=1;}
