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
const workRoot = path.join(project,'.work/nightly-memory-eval');
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
const report={startedAt:new Date().toISOString(),phase:'running',model:'deepseek-official/deepseek-flash',dsh:'0.2.1-rc.3',mnemon:'0.5.36',native:'0.2.13',emotionPluginEnabled:false,scope:'Isolated adapter 0.5.0 nightly acceptance: scheduled catch-up through public host services, independent cursors, real tool-free reviews and Runtime/Native writes, no-event repeat, pause and restart; synthetic input only.',instanceRoot:instance,cases:[],notes:[],errors:[]};
let child, client, launch=0;
async function save() {
  await fs.mkdir(outputRoot,{recursive:true});
  const text=clean(JSON.stringify(report,null,2)+'\n');
  if(text.includes(key)) throw new Error('Secret redaction failed');
  await fs.writeFile(path.join(outputRoot,'nightly-memory-acceptance.json'),text);
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
  let friend=patches.find(row=>row.id==='friend-adapter');if(!friend){friend={id:'friend-adapter'};patches.push(friend);}friend.config={...friend.config,nightly:{enabled:true,idleSeconds:1,tickSeconds:5,maxBatches:1,retryDelaySeconds:1}};
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
function nightlies(){
  const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});
  try{return {control:db.prepare('SELECT * FROM nightly_control').get(),calls:db.prepare('SELECT coalesce(sum(started_calls),0) AS n FROM nightly_budget').get().n,runs:db.prepare('SELECT * FROM nightly_runs ORDER BY rowid').all(),batches:db.prepare('SELECT * FROM nightly_batches ORDER BY rowid').all(),callRecords:db.prepare('SELECT * FROM nightly_calls ORDER BY rowid').all(),cursors:db.prepare('SELECT * FROM nightly_preview_cursors ORDER BY session_id').all(),applications:db.prepare('SELECT * FROM apply_runs ORDER BY rowid').all(),steps:db.prepare('SELECT * FROM apply_steps ORDER BY rowid').all()};}finally{db.close();}
}
async function waitNight(label,predicate){
  const start=Date.now();let last=start;
  while(Date.now()-start<180000){const value=nightlies();if(predicate(value)){emit({event:'background-complete',label,seconds:Math.round((Date.now()-start)/1000),runs:value.runs.map(row=>({id:row.id,status:row.status,trigger:row.trigger})),calls:value.calls});return value;}if(Date.now()-last>20000){emit({event:'background-pending',label,seconds:Math.round((Date.now()-start)/1000),statuses:value.runs.map(row=>row.status)});last=Date.now();}await sleep(800);}
  report.backgroundAtTimeout=nightlies();throw new Error('Background task did not reach expected state: '+label);
}
const used=(item,name)=>item.tools.some(tool=>tool.name===name);
try{
  await setup();report.adapterVersion='0.5.0';report.sourceDigest=report.adapterInstall.sourceDigest;
  const old=`${marker}读书会固定周六晚上八点在东门书店举行。`,unrelated=`${marker}联系约定：下雨时提前十分钟联系组织者。`;
  const nativeEnv={...testEnv};delete nativeEnv.DEEPSEEK_API_KEY;
  const fixture=JSON.parse(execFileSync(path.join(project,'.tools/mnemon-0.2.13/mnemon.exe'),['--data-dir',path.join(instance,'memory'),'--store','default','remember','--cat','context','--imp','3','--source','isolated-nightly-fixture','--',old],{env:nativeEnv,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  for(const content of [old,unrelated]){const result=await client.rpc('dshMnemon/write',{endpoint:'runtime-memory',payload:{action:'add',target:'memory',content,importance:'normal'}});if(!result.ok)throw new Error('Runtime fixture failed');}
  report.hostFixtures={old,unrelated,nativeId:fixture.id,source:'isolated-nightly-fixture',note:'Synthetic stale host fixtures; not evidence of LLM writeback.'};
  const ordinary=await newSession('夜间整理依据');
  const a=await turn('business-current-schedule',ordinary,`${marker}读书会现在已改为周日晚上八点，地点仍是东门书店。新安排现在生效，原来的周六安排作废。请先只聊一句，不要当场写入记忆，等夜间整理时再统一核对更新。`,'Original user change, held for the already configured nightly policy.');check(a,Boolean(a.response.trim())&&a.snapshot.runtimeEntries.some(row=>row.content===old)&&activeRows(a).some(row=>row.id===fixture.id),{heldForNightly:true});
  const before=await preserved(),reviewSession=await newSession('手动预演先行');
  const preview=await turn('manual-preview-before-nightly',reviewSession,`请对本实例陪伴会话做一次记忆整理预演，核对${marker}读书会的时间变化。现在只生成建议，不应用；稍后由已配置的夜间任务统一处理。简短回答。`,'Manual preview may consume manual cursors, but nightly must independently see the original exchange.');
  const p=previews(),row=p.runs.findLast(row=>row.status==='completed');check(preview,usedPreview(preview)&&Boolean(row)&&JSON.stringify(before)===JSON.stringify(await preserved()),{readOnly:JSON.stringify(before)===JSON.stringify(await preserved()),report:row?.id});
  if(!row)throw new Error('No actual manual preview');report.manualReport={id:row.id,proposals:row.result.decision.proposals,cursors:p.cursors};
  const first=nightlies();if(first.runs.length||first.calls)throw new Error('First boot ran a task before its schedule');report.initialSchedule=first.control;
  await stopHost();
  const offline=new DatabaseSync(path.join(instance,'companion/companion.sqlite'));try{offline.prepare('UPDATE nightly_control SET next_due=? WHERE id=1').run(Date.now()-3*86400000);}finally{offline.close();}
  report.scheduleFixture='While isolated host was stopped, next_due was moved three days into the past to simulate missed nights; no task/model result was forged.';
  await startHost();const after=await waitNight('scheduled-missed-days-catchup',state=>state.runs.some(row=>['completed','needs_attention','failed'].includes(row.status)));
  const memory=await memorySnapshot(),runtimeNew=memory.runtimeEntries.find(item=>item.content.includes(marker)&&item.content.includes('读书会')&&item.content.includes('周日')),nativeNew=memory.nativeRows.find(item=>!item.deleted_at&&item.content.includes(marker)&&item.content.includes('周日')),oldNative=memory.nativeRows.find(item=>item.id===fixture.id);
  const bg={id:'scheduled-background-catchup',status:'needs-review',turnReason:{kind:'completed'},response:'Host job result validated from durable tables and actual memories.',tools:[],automatedCheck:{oneCollapsedRun:after.runs.length===1&&after.runs[0].missed_days>=1,completed:after.runs[0].status==='completed',twoRealReviews:after.calls===2&&after.callRecords.every(row=>row.status==='completed'),bothLayersCorrected:Boolean(runtimeNew&&nativeNew&&oldNative?.deleted_at),preservedDetails:Boolean(runtimeNew?.content.includes('八点')&&runtimeNew?.content.includes('东门书店')&&nativeNew?.content===runtimeNew?.content),unrelatedKept:memory.runtimeEntries.some(item=>item.content===unrelated),separateCursor:after.cursors.some(item=>item.session_id===ordinary),hostAuthorization:after.applications.some(item=>JSON.parse(item.approval_json).kind==='nightly')}};
  bg.status=Object.values(bg.automatedCheck).every(Boolean)?'passed':'failed';report.cases.push(bg);report.background={state:after,memory,runtimeNew,nativeNew,oldNative};await save();if(bg.status!=='passed')throw new Error('Actual scheduled writeback failed; inspect real task and memory records');
  const query=await turn('read-background-result',reviewSession,'请只使用 friend_nightly_read 查询刚才夜间整理的任务和结果，简短说明有没有完成，不要另外调用记忆检索或写入。','Actual status tool, without exposing a synthetic user prompt to the background model.');check(query,used(query,'friend_nightly_read')&&nightlies().calls===2,{actualStatusTool:used(query,'friend_nightly_read'),noExtraReview:nightlies().calls===2});
  const beforeRepeat=await memorySnapshot();
  const repeat=await turn('queue-empty-repeat',reviewSession,'请使用 friend_nightly_control 的 run 动作，现在再整理一次；这次只排队，不要直接调用预演或应用工具。简短确认。','Queue once after this foreground turn, then no new facts means no reviewer calls.');check(repeat,used(repeat,'friend_nightly_control'),{actualControl:used(repeat,'friend_nightly_control')});
  const repeated=await waitNight('no-new-source-repeat',state=>state.runs.length===2&&state.runs.at(-1).status==='completed');
  const repeatCheck={sameCalls:repeated.calls===2,sameSteps:repeated.steps.length===after.steps.length,sameMemory:JSON.stringify(beforeRepeat)===JSON.stringify(await memorySnapshot())};Object.assign(repeat.automatedCheck,repeatCheck);if(!Object.values(repeatCheck).every(Boolean))repeat.status='failed';report.noNewEvents=repeatCheck;
  const paused=await turn('pause-nightly',reviewSession,'请暂停夜间自动整理，之后重启也保持暂停。简短确认。','Pause persists independently of runtime configuration.');check(paused,used(paused,'friend_nightly_control')&&nightlies().control.enabled_override===0,{persistentPause:nightlies().control.enabled_override===0});
  const beforeRestart=nightlies();await stopHost();await startHost();const restored=nightlies();report.restart={pausePreserved:restored.control.enabled_override===0,sameCalls:restored.calls===beforeRestart.calls,sameRuns:JSON.stringify(restored.runs)===JSON.stringify(beforeRestart.runs),sameCheckpoints:JSON.stringify(restored.batches)===JSON.stringify(beforeRestart.batches)};
  const afterRestart=await turn('read-paused-after-restart',await newSession('重启后查询日程'),'请只使用 friend_nightly_read 查询自动整理是否仍暂停，简短回答，不要恢复或运行任务。','Restart preserves paused schedule and durable receipts.');check(afterRestart,used(afterRestart,'friend_nightly_read')&&Object.values(report.restart).every(Boolean),report.restart);
  const resume=await turn('resume-nightly',reviewSession,'请恢复夜间自动整理，继续使用原来的凌晨两点日程。简短确认。','Resume changes control state, not facts or configured schedule.');check(resume,used(resume,'friend_nightly_control')&&nightlies().control.enabled_override===1,{resumed:nightlies().control.enabled_override===1});
  report.nightlyFinal=nightlies();report.previewFinal=previews();report.phase='completed';

}catch(error){report.phase='failed';report.errors.push(clean(error.stack??error.message));emit({event:'suite-error',message:clean(error.message)});}
finally{
  await stopHost().catch(error=>report.errors.push(clean(error.message)));
  report.productionMemoryFilesUnchanged=JSON.stringify(productionBefore)===JSON.stringify(await fingerprint());report.finishedAt=new Date().toISOString();report.rootTurns=report.cases.filter(row=>row.prompt).length;
  report.automatedSummary={passed:report.cases.filter(item=>item.status==='passed').length,failed:report.cases.filter(item=>item.status==='failed').length,pending:report.cases.filter(item=>item.status==='needs-review').length};report.testHostStopped=child?.exitCode!==null;
  await save();emit({event:'suite-finished',phase:report.phase,...report.automatedSummary,rootTurns:report.rootTurns,productionMemoryFilesUnchanged:report.productionMemoryFilesUnchanged,testHostStopped:report.testHostStopped,report:path.join(outputRoot,'nightly-memory-acceptance.json')});
  if(report.phase!=='completed'||report.automatedSummary.failed||!report.productionMemoryFilesUnchanged||!report.testHostStopped)process.exitCode=1;
}
