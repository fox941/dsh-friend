import fs from 'node:fs/promises';
import { installAdapter } from '../../scripts/install-adapter.mjs';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const workRoot = path.dirname(fileURLToPath(import.meta.url));
const project = fileURLToPath(new URL('../../',import.meta.url));
if(process.env.AI_FRIEND_RUN_MODEL_TESTS!=='1')throw new Error('Set AI_FRIEND_RUN_MODEL_TESTS=1 to run isolated real-model acceptance (uses configured API quota).');
const instance = path.join(project,'.work/protection-acceptance', `instance-${crypto.randomUUID()}`);
const outputRoot = path.join(project,'.work/protection-acceptance');
const key = JSON.parse(await fs.readFile(path.join(project,'runtime/dev/credentials.local.json'),'utf8')).DEEPSEEK_API_KEY;
if (typeof key !== 'string' || !key) throw new Error('A configured API credential is required');
const clean = text => String(text).replaceAll(key,'[redacted]');
const marker = `松塔${crypto.randomInt(100000,999999)}`;
const deadline = Date.now()+20*60*1000;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const testEnv={...process.env,DEEPSEEK_API_KEY:key,DSH_HOME:path.join(instance,'dsh-home'),MNEMON_DATA_DIR:path.join(instance,'memory','native-default'),MNEMON_MAX_INSIGHTS:'0',MNEMON_EMBED_ENDPOINT:'http://127.0.0.1:9',MNEMON_EMBED_PROTOCOL:'ollama',AI_FRIEND_TEST_INSTANCE:instance};
testEnv.PATH=path.dirname(process.execPath)+';'+path.join(project,'.tools/package-manager/node_modules/.bin')+';'+(process.env.PATH??'');
const report={startedAt:new Date().toISOString(),phase:'running',model:'deepseek-official/deepseek-flash',dsh:'0.2.1-rc.3',mnemon:'0.5.36',native:'0.2.13',emotionPluginEnabled:false,scope:'Isolated adapter 0.6.0 protection acceptance: real chat, real preview/application reviews, evidence view, offline graph-preserving undo, restart, withdrawn replay refusal; synthetic input only.',instanceRoot:instance,cases:[],notes:[],errors:[]};
let child, client, launch=0;
async function save() {
  await fs.mkdir(outputRoot,{recursive:true});
  const text=clean(JSON.stringify(report,null,2)+'\n');
  if(text.includes(key)) throw new Error('Secret redaction failed');
  await fs.writeFile(path.join(outputRoot,'protection-memory-acceptance.json'),text);
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
  report.adapterInstall=await installAdapter({projectRoot:project,instanceRoot:instance,sourceDirectory:path.join(project,'plugins/companion-adapter')});
  await startHost();
  const presets=await client.rpc('agentPresets/list');
  if(presets.presets.find(row=>row.id==='companion')?.broken)throw new Error('Companion adapter broke preset composition');
  const created=await client.rpc('dshMnemon/write',{endpoint:'body-create',payload:{name:'隔离验收记忆',description:'仅用于聊天与记忆测试的虚构资料，不代表真实用户，也不得写入其他实例。'}});
  if(!created.ok)throw new Error('Cannot create isolated memory space');
  const activated=await client.rpc('dshMnemon/activation',{endpoint:'body',payload:{memoryBodyId:created.value.id,active:true}});
  if(!activated.ok)throw new Error('Cannot activate isolated memory space');
  report.memorySpace=created.value.id;
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
  const item={id,sessionId,prompt,expectation,response:text,tools,toolResults,elapsedMs:Date.now()-start,turnReason:end.data.reason,usage,snapshot,growth:growthSnapshot(),status:'needs-review'};
  report.cases.push(item);
  await save();
  emit({event:'turn-complete',case:id,seconds:Math.round(item.elapsedMs/1000),tools:tools.map(tool=>tool.name),response:text.slice(0,650)});
  return item;
}
function check(item,passed,details){item.status=passed&&item.turnReason?.kind==='completed'?'passed':'failed';item.automatedCheck={...details,turnCompleted:item.turnReason?.kind==='completed'};}
function activeRows(item){return item.snapshot.nativeRows.filter(row=>!row.deleted_at);}
function recalled(item){return item.tools.some(tool=>/mnemon.*recall/.test(tool.name));}

function journal(){const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});try{return {previews:db.prepare('SELECT * FROM preview_runs ORDER BY rowid').all(),applications:db.prepare('SELECT * FROM apply_runs ORDER BY rowid').all(),steps:db.prepare('SELECT * FROM apply_steps ORDER BY rowid').all(),snapshots:db.prepare('SELECT * FROM protection_snapshots ORDER BY rowid').all(),undos:db.prepare('SELECT * FROM protection_undos ORDER BY rowid').all()};}finally{db.close();}}
const used=(item,name)=>item.tools.some(tool=>tool.name===name);
async function offline(){if(child?.exitCode===null)throw new Error('Isolated Host is still running');}
try{
  await setup();report.adapterVersion='0.6.0';report.sourceDigest=report.adapterInstall.sourceDigest;
  const old=`${marker}读书会固定周六晚上八点在东门书店举行。`,unrelated=`${marker}下雨时提前十分钟联系组织者。`,nativeEnv={...testEnv};delete nativeEnv.DEEPSEEK_API_KEY;
  const cli=(...args)=>JSON.parse(execFileSync(path.join(project,'.tools/mnemon-0.2.13/mnemon.exe'),['--data-dir',path.join(instance,'memory'),'--store','default',...args],{env:nativeEnv,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const fixture=cli('remember','--cat','context','--imp','3','--source','isolated-protection-fixture','--',old),neighbor=cli('remember','--imp','3','--',unrelated);cli('link',fixture.id,neighbor.id,'--type','causal','--weight','0.8');
  for(const content of [old,unrelated]){const result=await client.rpc('dshMnemon/write',{endpoint:'runtime-memory',payload:{action:'add',target:'memory',content,importance:'normal'}});if(!result.ok)throw new Error('Runtime fixture failed');}
  report.hostFixtures={old,unrelated,nativeId:fixture.id,neighbor:neighbor.id,note:'Synthetic stale records and explicit graph; no model result forged.'};
  const ordinary=await newSession('整理依据'),review=await newSession('保护与查看');
  const a=await turn('original-current-schedule',ordinary,`${marker}读书会现在已经改为周日晚上八点，地点仍为东门书店，原周六安排作废。现在先聊一句，不要当场写入记忆，等我要求整理时再统一处理。`,'Actual original change, no immediate writes.');check(a,Boolean(a.response.trim())&&a.snapshot.runtimeEntries.some(row=>row.content===old)&&activeRows(a).some(row=>row.id===fixture.id),{heldForReview:true});
  const preview=await turn('actual-read-only-preview',review,`请使用 friend_memory_preview 对本实例陪伴会话做记忆整理预演，核对${marker}读书会的时间变化。现在只生成建议，不要应用。简短回答。`,'Real tool-free preview without fact writes.');const pr=journal().previews.findLast(row=>row.status==='completed');check(preview,used(preview,'friend_memory_preview')&&Boolean(pr)&&journal().snapshots.length===0,{noSnapshotBeforeWrite:journal().snapshots.length===0});if(!pr)throw new Error('No completed preview');
  const applied=await turn('actual-protected-application',review,`请使用 friend_memory_apply 应用刚才的预演报告 ${pr.id}，更新已生效的读书会安排，保留时间地点和其他无关条目。简短说明结果，不要额外写其他内容。`,'Real second reviewer, pre-snapshot, Runtime and Native correction.');
  const app=journal().applications.at(-1),snap=journal().snapshots.at(-1),after=await memorySnapshot();if(!app||!snap)throw new Error('No protected real application');report.applicationId=app.id;
  const newNative=after.nativeRows.find(row=>!row.deleted_at&&row.content.includes(marker)&&row.content.includes('周日')),newRuntime=after.runtimeEntries.find(row=>row.content.includes(marker)&&row.content.includes('周日'));
  const corrected=Boolean(newNative&&newRuntime&&after.nativeRows.find(row=>row.id===fixture.id)?.deleted_at);check(applied,used(applied,'friend_memory_apply')&&app.status==='completed'&&snap.status==='sealed'&&corrected,{bothLayersCorrected:corrected,snapshotSealed:snap.status==='sealed'});if(applied.status!=='passed')throw new Error('Real protected application did not finish');
  const beforeView=growthSnapshot();
  const viewed=await turn('actual-change-inspection',review,`请只使用 friend_memory_changes 查看批次 ${app.id}，includeSources、checkUndo、html 都设为 true。简短给出依据、改动和本地报告路径，不做其他检索或写入。`,'Actual new inspection tool, sources/diff, no extra growth or reviewer calls.');
  const beforeStop=journal(),sealed=JSON.parse(beforeStop.snapshots.at(-1).after_json);check(viewed,used(viewed,'friend_memory_changes')&&JSON.stringify(beforeView)===JSON.stringify(growthSnapshot())&&!sealed.nativeUndoReasons.length,{readOnlySelf:JSON.stringify(beforeView)===JSON.stringify(growthSnapshot()),attributionReasons:sealed.nativeUndoReasons});report.beforeUndo=beforeStop;
  await stopHost();
  const require=createRequire(path.join(instance,'dsh-home/profiles/web/package.json')),{openProtection,undoBatch}=await import(pathToFileURL(require.resolve('@ai-friend/companion-adapter/protection-offline')));
  const controller=await openProtection(instance,{assertOffline:offline});
  try{
    const view=await controller.protection.changes(app.id,{includeSources:true,checkUndo:true,html:true});report.changeView=view;if(view.undo.status!=='ready_offline')throw new Error('Actual batch is not safely undoable: '+JSON.stringify(view.undo));
    await controller.protection.backend.runtime.manage('mutate','mutate',{action:'add',target:'user',content:`${marker}后来的无关约定：纸信只用蓝色墨水。`,importance:'normal'});
    const result=await undoBatch(controller.protection,app.id,{kind:'explicit-isolated-offline-acceptance'},{assertOffline:offline});report.undo=result;
    const nativeFile=await controller.protection.snapshots.nativeFile('default'),{databaseHash}=await import(pathToFileURL(path.join(instance,'dsh-home/profiles/web/node_modules/@ai-friend/companion-adapter/src/protection-sql.js'))),manifest=await controller.protection.snapshots.verify(app.id),memory=await controller.protection.backend.runtime.snapshot();
    const checks={completed:result.status==='completed',originalNativeAndGraph:await databaseHash(nativeFile)===manifest.native.default.digest,oldRuntimeRestored:memory.entries.some(row=>row.content===old),laterUnrelatedRuntimeKept:memory.entries.some(row=>row.content.includes('纸信只用蓝色墨水')),sourceHistoryRetained:Boolean(controller.protection.applications.store.get(app.id).frame.sources.length),undoMarked:(await controller.protection.applications.read(app.id)).status==='undone'};
    report.cases.push({id:'actual-offline-undo',status:Object.values(checks).every(Boolean)?'passed':'failed',automatedCheck:checks});if(!Object.values(checks).every(Boolean))throw new Error('Offline undo check failed');
  }finally{await controller.close();}
  await startHost();
  const readBack=await turn('read-after-restart',review,`请只使用 friend_memory_changes 查询批次 ${app.id} 的变更历史，checkUndo 设为 true，说明是否已经撤销。不要调用其他工具。`,'Restart retains original chat, source, history and completed undo.');check(readBack,used(readBack,'friend_memory_changes')&&journal().undos.at(-1).status==='completed'&&JSON.stringify(readBack.toolResults).includes('undone')&&!/无法确认|查询失败|不是可解析/.test(readBack.response),{receiptSurvivedRestart:true});
  const reapply=await turn('reject-withdrawn-report-replay',review,`请使用 friend_memory_apply 再次应用原报告 ${pr.id}。如果已经撤销就报告原因，不要绕过它自行写记忆。`,'A withdrawn report must not replay old changes.');
  check(reapply,used(reapply,'friend_memory_apply')&&journal().applications.length===beforeStop.applications.length&&(await memorySnapshot()).runtimeEntries.some(row=>row.content===old),{withdrawnNotReapplied:true});
  report.finalJournal=journal();report.phase='completed';
}catch(error){report.phase='failed';report.errors.push(clean(error.stack??error.message));emit({event:'suite-error',message:clean(error.message)});}
finally{
  await stopHost().catch(error=>report.errors.push(clean(error.message)));
  report.productionMemoryFilesUnchanged=JSON.stringify(productionBefore)===JSON.stringify(await fingerprint());report.finishedAt=new Date().toISOString();report.rootTurns=report.cases.filter(row=>row.prompt).length;
  report.automatedSummary={passed:report.cases.filter(item=>item.status==='passed').length,failed:report.cases.filter(item=>item.status==='failed').length,pending:report.cases.filter(item=>item.status==='needs-review').length};report.testHostStopped=child?.exitCode!==null;
  await save();emit({event:'suite-finished',phase:report.phase,...report.automatedSummary,rootTurns:report.rootTurns,productionMemoryFilesUnchanged:report.productionMemoryFilesUnchanged,testHostStopped:report.testHostStopped,report:path.join(outputRoot,'protection-memory-acceptance.json')});
  if(report.phase!=='completed'||report.automatedSummary.failed||!report.productionMemoryFilesUnchanged||!report.testHostStopped)process.exitCode=1;
}

