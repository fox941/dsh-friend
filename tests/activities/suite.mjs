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
const instance = path.join(project,'.work/activity-acceptance', `instance-${crypto.randomUUID()}`);
const outputRoot = path.join(project,'.work/activity-acceptance');
const key = JSON.parse(await fs.readFile(path.join(project,'runtime/dev/credentials.local.json'),'utf8')).DEEPSEEK_API_KEY;
if (typeof key !== 'string' || !key) throw new Error('A configured API credential is required');
const clean = text => String(text).replaceAll(key,'[redacted]');
const marker = `松塔${crypto.randomInt(100000,999999)}`;
const deadline = Date.now()+20*60*1000;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const testEnv={...process.env,DEEPSEEK_API_KEY:key,DSH_HOME:path.join(instance,'dsh-home'),MNEMON_DATA_DIR:path.join(instance,'memory','native-default'),MNEMON_MAX_INSIGHTS:'0',MNEMON_EMBED_ENDPOINT:'http://127.0.0.1:9',MNEMON_EMBED_PROTOCOL:'ollama',AI_FRIEND_TEST_INSTANCE:instance};
testEnv.PATH=path.dirname(process.execPath)+';'+path.join(project,'.tools/package-manager/node_modules/.bin')+';'+(process.env.PATH??'');
const report={startedAt:new Date().toISOString(),phase:'running',model:'deepseek-official/deepseek-flash',dsh:'0.2.1-rc.3',mnemon:'0.5.36',native:'0.2.13',activitiesEnabled:true,actualDeepSeek:true,actualBilibiliContent:process.env.AI_FRIEND_REAL_BILIBILI==='1',scope:'Isolated real DSH/DeepSeek with recorded synthetic Bilibili fixture; exercises source/review/Native/protection/shared self. Does not prove real Bilibili login or API content.',instanceRoot:instance,cases:[],notes:[],errors:[]};
let child, client, launch=0;
async function save() {
  await fs.mkdir(outputRoot,{recursive:true});
  const text=clean(JSON.stringify(report,null,2)+'\n');
  if(text.includes(key)) throw new Error('Secret redaction failed');
  await fs.writeFile(path.join(outputRoot,process.env.AI_FRIEND_REAL_BILIBILI==='1'?'activity-real-acceptance.json':'activity-acceptance.json'),text);
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
  await fs.mkdir(path.join(instance,'channels/bilibili'),{recursive:true});await fs.writeFile(path.join(instance,'channels/bilibili/credentials.local.json'),JSON.stringify({sessdata:'isolated-test-session',bili_jct:'isolated-test-csrf',dedeuserid:'123456'}));
  if(process.env.AI_FRIEND_REAL_BILIBILI==='1')await fs.copyFile(path.join(project,'runtime/dev/channels/bilibili/credentials.local.json'),path.join(instance,'channels/bilibili/credentials.local.json'));
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
  const item={id,sessionId,prompt,expectation,response:text,tools,toolResults,elapsedMs:Date.now()-start,turnReason:end.data.reason,usage,snapshot,growth:growthSnapshot(),daily:activitySnapshot(),status:'needs-review'};
  report.cases.push(item);
  await save();
  emit({event:'turn-complete',case:id,seconds:Math.round(item.elapsedMs/1000),tools:tools.map(tool=>tool.name),response:text.slice(0,650)});
  return item;
}
function check(item,passed,details){item.status=passed&&item.turnReason?.kind==='completed'?'passed':'failed';item.automatedCheck={...details,turnCompleted:item.turnReason?.kind==='completed'};}
function activeRows(item){return item.snapshot.nativeRows.filter(row=>!row.deleted_at);}
function recalled(item){return item.tools.some(tool=>/mnemon.*recall/.test(tool.name));}

function activitySnapshot(){const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});try{return {runs:db.prepare('SELECT id,status,decision_json,result_json,error FROM activity_runs ORDER BY rowid').all(),observations:db.prepare('SELECT id,canonical,payload_json FROM activity_observations').all(),calls:db.prepare('SELECT role,status,count(*) n FROM activity_calls GROUP BY role,status').all(),applications:db.prepare("SELECT id,status,approval_json,frame_json FROM apply_runs WHERE json_extract(approval_json,'$.kind')='activity'").all(),snapshots:db.prepare('SELECT application_id,status FROM protection_snapshots').all(),growth:growthSnapshot()};}finally{db.close();}}
const nativeFacts=snapshot=>snapshot.nativeRows.filter(row=>!row.deleted_at).map(row=>row.content);
function receipt(item){return item.toolResults.find(row=>row.name==='friend_bilibili_explore');}
const originalCheck=check;check=(item,passed,details={})=>originalCheck(item,passed&&item.toolResults.every(event=>!event.data.message?.isError),details);
try{
 if(process.env.AI_FRIEND_REAL_BILIBILI==='1')report.scope='Real isolated DSH/DeepSeek and real Bilibili account, live subtitle content and Native/protection/shared state; no platform write actions, no production character writes.';
 await setup();report.adapterVersion='0.10.0';report.sourceDigest=report.adapterInstall.sourceDigest;
 const a=await newSession('活动原件及真实写入审核');
 const read=await turn('manual-video-experience',a,'请读取B站视频 BV1Eb411u7Fw。可以保存这次有来源的阅读经历，有确实依据才提出暂时兴趣或情绪；不要改我的个人资料。只用 friend_bilibili_explore 发起，简短说明实际读到了什么。','Real DSH tool calls capture fixture observation, independent real-model audit writes Native with a full protection snapshot.');
 let state=activitySnapshot();check(read,read.tools.some(row=>row.name==='friend_bilibili_explore')&&state.observations.length===1&&['completed','completed_without_memory'].includes(state.runs[0].status)&&(nativeFacts(read.snapshot).some(text=>/外部阅读经历/.test(text))?state.snapshots.some(row=>row.status==='sealed'):state.applications.length===1),{activity:state});
 if(read.status!=='passed')throw new Error('Manual experience, independent review or source snapshot was not valid');
 const b=await newSession('新会话共享活动经历');const recalled=await turn('new-session-experience-recall',b,'你最近实际读取过什么B站内容？请查 friend_activity_read 核对真实来源与阅读范围，再用 mnemon_recall 查找是否保存了对应阅读经历；不要发起新活动，不更新记忆。简短回答。','A different conversation sees the same observation and Native record, not a separate personality.');check(recalled,recalled.tools.some(row=>['friend_activity_read','friend_activity_status'].includes(row.name))&&recalled.tools.some(row=>row.name==='mnemon_recall')&&nativeFacts(recalled.snapshot).length===nativeFacts(read.snapshot).length,{sharedExperience:true});
 if(process.env.AI_FRIEND_REAL_BILIBILI!=='1'){
 const fixtureClock=new DatabaseSync(path.join(instance,'companion/companion.sqlite'));fixtureClock.prepare('UPDATE activity_runs SET created_at=?').run(new Date(Date.now()-121*60000).toISOString());fixtureClock.close();report.notes.push('Only the isolated activity cooldown timestamp was advanced to exercise another manual turn without waiting two hours.');
 const protectedRead=await turn('no-save-reading',a,'请读取B站视频 BV1ZHnF6SEp5，这次不要保存记忆，不要学习兴趣或改变情绪。用 friend_bilibili_explore 并设置 learn=false，简短回答。','Explicit no-learning request leaves memory and self unchanged.');state=activitySnapshot();check(protectedRead,state.observations.length===2&&state.runs.at(-1).status==='read_only'&&nativeFacts(protectedRead.snapshot).length===nativeFacts(read.snapshot).length,{noLearningPreserved:true});
 }
 const settings=await turn('activity-pause-control',a,'请暂停自主活动。使用 friend_activity_control 的 pause，然后读取 friend_activity_status 确认，简短确认。','Owner can disable automatic activities.');check(settings,settings.tools.some(row=>row.name==='friend_activity_control')&&settings.tools.some(row=>row.name==='friend_activity_status'),{controlExposed:true});
 const before=activitySnapshot(),memoryBefore=await memorySnapshot();await stopHost();await startHost();state=activitySnapshot();report.restart={sameObservations:JSON.stringify(before.observations)===JSON.stringify(state.observations),sameDailyBudget:before.runs.length===state.runs.length,sameMemory:JSON.stringify(memoryBefore)===JSON.stringify(await memorySnapshot())};
 const after=await turn('restart-activity-receipts',b,'请用 friend_activity_read 查看最近一次B站活动，说明当时是否保存记忆，以及实际阅读范围。不要重新探索或改变状态。','Receipts and source scope survive restart.');check(after,after.tools.some(row=>row.name==='friend_activity_read')&&Object.values(report.restart).every(Boolean),report.restart);
 report.finalActivities=activitySnapshot();report.phase='completed';
}catch(error){report.phase='failed';report.errors.push(clean(error.stack??error.message));emit({event:'suite-error',message:clean(error.message)});}
finally{await stopHost().catch(error=>report.errors.push(clean(error.message)));report.productionMemoryFilesUnchanged=JSON.stringify(productionBefore)===JSON.stringify(await fingerprint());report.finishedAt=new Date().toISOString();report.rootTurns=report.cases.length;report.automatedSummary={passed:report.cases.filter(row=>row.status==='passed').length,failed:report.cases.filter(row=>row.status==='failed').length,pending:report.cases.filter(row=>row.status==='needs-review').length};report.testHostStopped=child?.exitCode!==null;await save();emit({event:'suite-finished',phase:report.phase,...report.automatedSummary,rootTurns:report.rootTurns,actualBilibiliContent:process.env.AI_FRIEND_REAL_BILIBILI==='1',productionMemoryFilesUnchanged:report.productionMemoryFilesUnchanged,testHostStopped:report.testHostStopped});if(report.phase!=='completed'||report.automatedSummary.failed||report.automatedSummary.pending||!report.productionMemoryFilesUnchanged)process.exitCode=1;}
