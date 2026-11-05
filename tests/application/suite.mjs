import fs from 'node:fs/promises';
import { installAdapter } from '../../scripts/install-adapter.mjs';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const project = fileURLToPath(new URL('../../',import.meta.url));
const workRoot = path.join(project,'.work/memory-application-eval');
await fs.mkdir(workRoot,{recursive:true});
const instance = path.join(workRoot, `instance-${crypto.randomUUID()}`);
const outputRoot = path.join(workRoot,'reports');
const key = JSON.parse(await fs.readFile(path.join(project,'runtime/dev/credentials.local.json'),'utf8')).DEEPSEEK_API_KEY;
if (typeof key !== 'string' || !key) throw new Error('A configured API credential is required');
const clean = text => String(text).replaceAll(key,'[redacted]');
const marker = `松塔${crypto.randomInt(100000,999999)}`;
const deadline = Date.now()+20*60*1000;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const testEnv={...process.env,DEEPSEEK_API_KEY:key,DSH_HOME:path.join(instance,'dsh-home'),MNEMON_DATA_DIR:path.join(instance,'memory','native-default'),MNEMON_MAX_INSIGHTS:'0',MNEMON_EMBED_ENDPOINT:'http://127.0.0.1:9',MNEMON_EMBED_PROTOCOL:'ollama',AI_FRIEND_TEST_INSTANCE:instance};
testEnv.PATH=path.dirname(process.execPath)+';'+path.join(project,'.tools/package-manager/node_modules/.bin')+';'+(process.env.PATH??'');
const report={startedAt:new Date().toISOString(),phase:'running',model:'deepseek-official/deepseek-flash',dsh:'0.2.1-rc.3',mnemon:'0.5.36',native:'0.2.13',emotionPluginEnabled:false,scope:'Isolated adapter 0.4.0 application acceptance: actual DSH/DeepSeek preview and compilation, Runtime and Native writeback, replay and restart; synthetic input only.',instanceRoot:instance,cases:[],notes:[],errors:[]};
let child, client, launch=0;
async function save() {
  await fs.mkdir(outputRoot,{recursive:true});
  const text=clean(JSON.stringify(report,null,2)+'\n');
  if(text.includes(key)) throw new Error('Secret redaction failed');
  await fs.writeFile(path.join(outputRoot,'memory-application-acceptance.json'),text);
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
  child=spawn(process.execPath,[fileURLToPath(new URL('./host.mjs',import.meta.url))],{cwd:path.join(instance,'workspace'),env:{...testEnv,AI_FRIEND_TEST_PORT:String(port)},windowsHide:true,stdio:['ignore',stdout,stderr,'ipc']});
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
  const item={id,sessionId,prompt,expectation,response:text,tools,elapsedMs:Date.now()-start,turnReason:end.data.reason,usage,snapshot,growth:growthSnapshot(),status:'needs-review'};
  report.cases.push(item);
  await save();
  emit({event:'turn-complete',case:id,seconds:Math.round(item.elapsedMs/1000),tools:tools.map(tool=>tool.name),response:text.slice(0,650)});
  return item;
}
function check(item,passed,details){item.status=passed&&item.turnReason?.kind==='completed'?'passed':'failed';item.automatedCheck={...details,turnCompleted:item.turnReason?.kind==='completed'};}
function activeRows(item){return item.snapshot.nativeRows.filter(row=>!row.deleted_at);}
function recalled(item){return item.tools.some(tool=>/mnemon.*recall/.test(tool.name));}


function previews(){
  const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});
  try{return {calls:db.prepare('SELECT coalesce(sum(started_calls),0) AS n FROM preview_budget').get().n,runs:db.prepare('SELECT * FROM preview_runs ORDER BY rowid').all().map(row=>({...row,snapshot:JSON.parse(row.snapshot_json),result:row.result_json?JSON.parse(row.result_json):null})),cursors:db.prepare('SELECT * FROM preview_cursors ORDER BY session_id').all()};}finally{db.close();}
}
async function preserved(){
  const memory=await memorySnapshot(),growth=growthSnapshot();
  return {runtimeEntries:memory.runtimeEntries,native:memory.nativeRows.map(row=>({id:row.id,content:row.content,deleted_at:row.deleted_at})),growth:{identityId:growth.identityId,revision:growth.revision,heads:growth.heads,reviewCalls:growth.reviewCalls}};
}
function usedPreview(item){return item.tools.some(row=>row.name==='friend_memory_preview');}
function applications(){
  const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});
  try{return {calls:db.prepare('SELECT coalesce(sum(started_calls),0) AS n FROM apply_budget').get().n,runs:db.prepare('SELECT * FROM apply_runs ORDER BY rowid').all(),steps:db.prepare('SELECT * FROM apply_steps ORDER BY rowid').all().map(row=>({...row,operation:JSON.parse(row.operation_json),receipt:row.receipt_json?JSON.parse(row.receipt_json):null}))};}finally{db.close();}
}
const used=(item,name)=>item.tools.some(tool=>tool.name===name);
try{
  await setup();report.adapterVersion='0.4.0';report.sourceDigest=report.adapterInstall.sourceDigest;
  const old=`${marker}线下读书会固定周六晚上八点在东门书店举行。`;
  const unrelated=`${marker}联系约定：下雨时提前十分钟联系组织者。`;
  const nativeEnv={...testEnv};delete nativeEnv.DEEPSEEK_API_KEY;
  const fixture=JSON.parse(execFileSync(path.join(project,'.tools/mnemon-0.2.13/mnemon.exe'),['--data-dir',path.join(instance,'memory'),'--store','default','remember','--cat','context','--imp','3','--source','isolated-application-fixture','--',old],{env:nativeEnv,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  for(const content of [old,unrelated]){
    const result=await client.rpc('dshMnemon/write',{endpoint:'runtime-memory',payload:{action:'add',target:'memory',content,importance:'normal'}});
    if(!result.ok)throw new Error('Runtime fixture failed');
  }
  report.hostFixtures={old,unrelated,nativeId:fixture.id,source:'isolated-application-fixture',note:'Labeled host-created stale facts for writeback testing; not evidence that an LLM created them.'};
  const ordinary=await newSession('读书会时间更正');
  const a=await turn('business-current-schedule',ordinary,`${marker}线下读书会现在已经确定改为周日晚上八点举行，地点仍是东门书店。新的安排现在就生效，原来的周六安排作废。这里只先聊一句，所有记忆写入请等我生成整理预演、再明确要求应用报告时处理。`,'Actual user correction; foreground writes held for explicit later application.');check(a,Boolean(a.response.trim())&&a.snapshot.runtimeEntries.some(row=>row.content===old)&&activeRows(a).some(row=>row.id===fixture.id),{foregroundKeptOldForPreview:true});
  const reviewSession=await newSession('应用整理报告');
  const before=await preserved();
  const preview=await turn('generate-actionable-report',reviewSession,`请对本实例的陪伴会话进行一次记忆整理预演，重点核对${marker}线下读书会的时间变更及常驻、长期记忆里的旧副本。只生成建议报告，现在不应用、不写入。简短告诉我报告编号。`,'Actual report with exact source references; no effects.');
  const p=previews(),row=p.runs.findLast(row=>row.status==='completed');
  check(preview,usedPreview(preview)&&Boolean(row)&&JSON.stringify(before)===JSON.stringify(await preserved()),{readOnly:JSON.stringify(before)===JSON.stringify(await preserved()),completedReport:Boolean(row)});
  if(!row)throw new Error('No completed actual preview report');
  report.firstReport={id:row.id,proposals:row.result.decision.proposals,sources:row.snapshot.sources.sources,memories:row.snapshot.memories.items};
  if(!row.result.decision.proposals.some(item=>item.action==='temporal_change'||item.action==='supplement'))throw new Error('Actual report has no executable correction proposal');
  const growthBeforeApply=growthSnapshot();
  const applied=await turn('apply-real-report',reviewSession,`请应用整理报告 ${row.id} 里可以执行的提案，同步核对并更正常驻、长期记忆里的同一旧事实，保留原话和旧版本。依据不足或有冲突的先保留待定。请使用提案应用工具，告诉我实际完成了什么。`,'New explicit current authorization; actual tool-free application review and verified Runtime/Native writes.');
  let app=applications(),run=app.runs.at(-1);
  const runtimeNew=applied.snapshot.runtimeEntries.find(item=>item.content.includes(marker)&&item.content.includes('读书会')&&item.content.includes('周日'));
  const nativeNew=activeRows(applied).find(item=>item.content.includes(marker)&&item.content.includes('读书会')&&item.content.includes('周日'));
  const oldNative=applied.snapshot.nativeRows.find(item=>item.id===fixture.id);
  const noOld=Boolean(runtimeNew&&nativeNew&&oldNative?.deleted_at)&&!applied.snapshot.runtimeEntries.some(item=>item.content===old);
  const preservedConditions=Boolean(runtimeNew?.content.includes('东门书店')&&runtimeNew?.content.includes('八点')&&nativeNew?.content.includes('东门书店')&&nativeNew?.content.includes('八点'));
  const untouched=applied.snapshot.runtimeEntries.some(item=>item.content===unrelated);
  check(applied,used(applied,'friend_memory_apply')&&noOld&&preservedConditions&&untouched&&app.calls===1&&run?.status==='completed',{actualApplicationTool:used(applied,'friend_memory_apply'),oldCopiesCorrected:noOld,preservedConditions,unrelatedUntouched:untouched,oneApplicationReview:app.calls===1,runStatus:run?.status});
  report.writeback={application:app,runtimeNew,nativeNew,oldNative,growthUnchanged:JSON.stringify(growthBeforeApply)===JSON.stringify(growthSnapshot())};
  if(!run||!nativeNew||!runtimeNew)throw new Error('Real application did not finish the expected writeback; inspect stored actual result');
  const beforeReplay=await memorySnapshot(),callsBefore=app.calls,stepsBefore=app.steps.length;
  const replay=await turn('repeat-application',reviewSession,`请调用 friend_memory_apply 再次应用同一份整理报告 ${row.id} 的全部提案；即使已完成也请通过应用工具核对原回执，不要只查回执。已完成的不要重复新增，也不要重做审核。`,'Same report/selection is idempotent; no extra model or Native write.');
  app=applications();
  check(replay,used(replay,'friend_memory_apply')&&app.calls===callsBefore&&app.steps.length===stepsBefore&&JSON.stringify(beforeReplay)===JSON.stringify(await memorySnapshot()),{sameReviewCalls:app.calls===callsBefore,sameSteps:app.steps.length===stepsBefore,sameMemory:JSON.stringify(beforeReplay)===JSON.stringify(await memorySnapshot())});
  const history=await turn('read-application-receipt',reviewSession,`请查询应用回执 ${run.id} 以及原预演报告 ${row.id}，说明旧事实与原话是否保留、报告是否已实际应用。请只查询。`,'Read both historical report and durable application receipt.');
  check(history,used(history,'friend_memory_apply_read')&&used(history,'friend_memory_preview_read')&&applications().calls===callsBefore,{applicationRead:used(history,'friend_memory_apply_read'),previewRead:used(history,'friend_memory_preview_read'),noReview:applications().calls===callsBefore});
  const beforeRestart=applications(),identity=growthSnapshot().identityId;
  await stopHost();await startHost();
  const afterRestart=applications();
  report.restart={sameIdentity:growthSnapshot().identityId===identity,sameCalls:afterRestart.calls===beforeRestart.calls,sameRuns:JSON.stringify(afterRestart.runs)===JSON.stringify(beforeRestart.runs),sameSteps:JSON.stringify(afterRestart.steps)===JSON.stringify(beforeRestart.steps)};
  const restored=await turn('receipt-after-restart',await newSession('重启后查询回执'),`请查询应用回执 ${run.id}，核对常驻和长期记忆里的结果现在是否仍然有效；只查询，不改动。`,'Persisted receipt and current verification after actual host restart.');
  check(restored,Object.values(report.restart).every(Boolean)&&used(restored,'friend_memory_apply_read')&&applications().calls===callsBefore,{...report.restart,actualRead:used(restored,'friend_memory_apply_read')});
  report.applicationFinal=applications();report.previewFinal=previews();report.phase='completed';

}catch(error){report.phase='failed';report.errors.push(clean(error.stack??error.message));emit({event:'suite-error',message:clean(error.message)});}
finally{
  await stopHost().catch(error=>report.errors.push(clean(error.message)));
  report.productionMemoryFilesUnchanged=JSON.stringify(productionBefore)===JSON.stringify(await fingerprint());report.finishedAt=new Date().toISOString();report.rootTurns=report.cases.length;
  report.automatedSummary={passed:report.cases.filter(item=>item.status==='passed').length,failed:report.cases.filter(item=>item.status==='failed').length,pending:report.cases.filter(item=>item.status==='needs-review').length};report.testHostStopped=child?.exitCode!==null;
  await save();emit({event:'suite-finished',phase:report.phase,...report.automatedSummary,rootTurns:report.rootTurns,productionMemoryFilesUnchanged:report.productionMemoryFilesUnchanged,testHostStopped:report.testHostStopped,report:path.join(outputRoot,'memory-application-acceptance.json')});
  if(report.phase!=='completed'||report.automatedSummary.failed||!report.productionMemoryFilesUnchanged||!report.testHostStopped)process.exitCode=1;
}
