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
const instance = path.join(project,'.work/conversation-acceptance', `instance-${crypto.randomUUID()}`);
const outputRoot = path.join(project,'.work/conversation-acceptance');
const key = JSON.parse(await fs.readFile(path.join(project,'runtime/dev/credentials.local.json'),'utf8')).DEEPSEEK_API_KEY;
if (typeof key !== 'string' || !key) throw new Error('A configured API credential is required');
const clean = text => String(text).replaceAll(key,'[redacted]');
const marker = `松塔${crypto.randomInt(100000,999999)}`;
const deadline = Date.now()+20*60*1000;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const testEnv={...process.env,DEEPSEEK_API_KEY:key,DSH_HOME:path.join(instance,'dsh-home'),MNEMON_DATA_DIR:path.join(instance,'memory','native-default'),MNEMON_MAX_INSIGHTS:'0',MNEMON_EMBED_ENDPOINT:'http://127.0.0.1:9',MNEMON_EMBED_PROTOCOL:'ollama',AI_FRIEND_TEST_INSTANCE:instance};
testEnv.PATH=path.dirname(process.execPath)+';'+path.join(project,'.tools/package-manager/node_modules/.bin')+';'+(process.env.PATH??'');
const report={startedAt:new Date().toISOString(),phase:'running',model:'deepseek-official/deepseek-flash',dsh:'0.2.1-rc.3',mnemon:'0.5.36',native:'0.2.13',conversationMemoryEnabled:true,scope:'Isolated adapter 0.8.0 daily memory: ordinary save/recall, original attribution, hypothetical/future statements, duplicates, real Runtime/Native correction and withdrawal, audit and restart. Synthetic conversation only.',instanceRoot:instance,cases:[],notes:[],errors:[]};
let child, client, launch=0;
async function save() {
  await fs.mkdir(outputRoot,{recursive:true});
  const text=clean(JSON.stringify(report,null,2)+'\n');
  if(text.includes(key)) throw new Error('Secret redaction failed');
  await fs.writeFile(path.join(outputRoot,'conversation-memory-acceptance.json'),text);
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
  const item={id,sessionId,prompt,expectation,response:text,tools,toolResults,elapsedMs:Date.now()-start,turnReason:end.data.reason,usage,snapshot,growth:growthSnapshot(),daily:dailySnapshot(),status:'needs-review'};
  report.cases.push(item);
  await save();
  emit({event:'turn-complete',case:id,seconds:Math.round(item.elapsedMs/1000),tools:tools.map(tool=>tool.name),response:text.slice(0,650)});
  return item;
}
function check(item,passed,details){item.status=passed&&item.turnReason?.kind==='completed'?'passed':'failed';item.automatedCheck={...details,turnCompleted:item.turnReason?.kind==='completed'};}
function activeRows(item){return item.snapshot.nativeRows.filter(row=>!row.deleted_at);}
function recalled(item){return item.tools.some(tool=>/mnemon.*recall/.test(tool.name));}

function dailySnapshot(){const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});try{return {calls:db.prepare('SELECT coalesce(sum(started_calls),0) n FROM apply_conversation_budget').get().n,runs:db.prepare("SELECT id,status,approval_json,frame_json,plan_json,model_json,error FROM apply_runs ORDER BY rowid").all().map(row=>({...row,approval:JSON.parse(row.approval_json),frame:JSON.parse(row.frame_json),plan:row.plan_json?JSON.parse(row.plan_json):null,model:row.model_json?JSON.parse(row.model_json):null})),snapshots:db.prepare('SELECT application_id,status,bytes,manifest_json FROM protection_snapshots ORDER BY rowid').all().map(row=>({...row,manifest:row.manifest_json?JSON.parse(row.manifest_json):null}))};}finally{db.close();}}
const used=(item,name)=>item.tools.some(row=>row.name===name);
const active=item=>item.snapshot.nativeRows.filter(row=>!row.deleted_at);
const hasTea=item=>item.snapshot.runtimeEntries.some(row=>row.target==='user'&&/乌龙茶/.test(row.content)&&/(?:无糖|不加糖)/.test(row.content));
function checkNoChange(item,before){check(item,JSON.stringify(item.snapshot)===JSON.stringify(before)&&!item.tools.some(row=>['friend_memory_write','friend_memory_write_retry'].includes(row.name)),{sameMemoryData:JSON.stringify(item.snapshot)===JSON.stringify(before)});}
async function seedHotCopy(content){const require=createRequire(path.join(instance,'dsh-home/profiles/web/package.json'));const {createRuntimeMemorySource}=await import(pathToFileURL(require.resolve('dsh-mnemon-source-runtime')));const runtime=createRuntimeMemorySource({dataDir:path.join(instance,'memory'),userDataDir:path.join(instance,'memory')}).create({sourceInstanceKey:'isolated-seed',provenance:{packageName:'isolated-test',entryId:'fixture'},configuration:{}});await runtime.manage({scope:{storage:'custom'},sourceInstanceKey:'isolated-seed',mode:'mutate',operation:'mutate',input:{action:'add',target:'memory',content},confirmed:true});}
try{
 await setup();report.adapterVersion='0.8.0';report.sourceDigest=report.adapterInstall.sourceDigest;
 const session=await newSession('日常记忆自然沟通');
 const saved=await turn('natural-save',session,'我平时喝茶喜欢不加糖的乌龙茶，以后聊到饮品可以记得这个偏好。简单确认就行。','Ordinary DSH chat uses the managed memory entry without a preview or second approval.');
 check(saved,used(saved,'friend_memory_write')&&hasTea(saved)&&saved.daily.calls>=1&&saved.daily.runs.some(row=>row.approval.kind==='conversation'&&row.status==='completed'),{managedWrite:used(saved,'friend_memory_write'),hotPreferencePresent:hasTea(saved),reviewCalls:saved.daily.calls});if(saved.status!=='passed')throw new Error('Natural daily save failed');
 const session2=await newSession('跨会话召回');let stable=await memorySnapshot();
 const recalled=await turn('cross-session-recall',session2,'我平时喝茶是什么偏好？只回答已有记录，不新增或修改记忆。','Same instance recalls saved facts in a separate DSH conversation.');check(recalled,/乌龙茶/.test(recalled.response)&&/(?:无糖|不加糖)/.test(recalled.response)&&hasTea(recalled)&&recalled.daily.calls===saved.daily.calls,{savedPreferenceRecalled:true,noExtraReview:recalled.daily.calls===saved.daily.calls});
 stable=await memorySnapshot();const quoted=await turn('quoted-person-is-not-user',session,'下面是我转述朋友的原话：“我住南京，喜欢甜咖啡。”这不是我的住址或偏好，只用于这次解释，不要写入我的资料。简单回应。','Quotation, attribution and explicit do-not-save preserve current profile.');checkNoChange(quoted,stable);
 stable=await memorySnapshot();const hypothetical=await turn('hypothetical-is-not-fact',session,'假如我以后搬到成都，可能会改喝甜饮料。这只是举例，不是实际计划，不要记录或覆盖原偏好。','Hypothetical futures do not overwrite current facts.');checkNoChange(hypothetical,stable);
 const duplicate=await turn('paraphrase-duplicate',session,'我还是更喜欢不加糖的乌龙茶，和前面是同一个偏好，不用重复记。','Repeated equivalent statements do not create duplicate profile entries.');check(duplicate,hasTea(duplicate)&&duplicate.snapshot.runtimeEntries.filter(row=>row.target==='user'&&/乌龙茶/.test(row.content)).length===1,{oneCanonicalPreference:true});
 const longTerm=await turn('long-term-save',session,marker+'读书活动现在的约定是周六下午三点在松塔书店集合，活动编号是'+marker+'。请将这条完整约定长期保存，后面会更正时间，地点和编号需要一起保留。简单确认。','Explicit long-term persistence uses the same reviewed entry and Native receipt.');
 const archive=active(longTerm).find(row=>row.content.includes(marker)&&row.content.includes('书店'));
 check(longTerm,used(longTerm,'friend_memory_write')&&Boolean(archive),{actualNativeRecord:Boolean(archive)});if(longTerm.status!=='passed')throw new Error('Managed long-term addition failed');
 await seedHotCopy(archive.content);report.seededExactCopy={purpose:'Existing cross-layer copies are synthetic isolated fixture data, never user runtime.',content:archive.content};
 const corrected=await turn('cross-layer-correction',session,marker+'读书活动的集合约定现在正式改成周日下午四点，地点仍是松塔书店，活动编号仍是'+marker+'。请更正已有约定，保留未改变的信息，不要另加互相矛盾的记录。简单确认。','Natural correction reads versions and updates existing exact copies in Runtime and Native.');
 const newNative=active(corrected).filter(row=>row.content.includes(marker)&&row.content.includes('书店')),newHot=corrected.snapshot.runtimeEntries.filter(row=>row.content.includes(marker)&&row.content.includes('书店'));
 check(corrected,used(corrected,'friend_memory_read')&&used(corrected,'friend_memory_write')&&newNative.length===1&&newHot.length===1&&newNative[0].content===newHot[0].content&&/(?:周日|星期日|星期天)/.test(newHot[0].content)&&/(?:四点|16[:：]00|16点)/.test(newHot[0].content)&&newHot[0].content.includes(marker)&&!active(corrected).some(row=>row.id===archive.id),{canonicalCopiesEqual:newNative[0]?.content===newHot[0]?.content,oldNativeRetired:!active(corrected).some(row=>row.id===archive.id)});if(corrected.status!=='passed')throw new Error('Cross-layer conversational correction failed');
 const changes=await turn('inspect-change-evidence',session,'请用 friend_memory_changes 查看刚才这次更正，includeSources设true，只说明旧值、新值和原话依据，不做其他修改。','Existing change tools show daily operations and original user evidence.');check(changes,used(changes,'friend_memory_changes')&&JSON.stringify(changes.toolResults).includes('oldValue')&&JSON.stringify(changes.toolResults).includes('newValue')&&JSON.stringify(changes.toolResults).includes('sources'),{dailyChangesVisible:true});
 stable=await memorySnapshot();const future=await turn('future-change-not-active',session,marker+'读书活动如果下个月才改到周一，现在仍按刚才周日下午四点的约定。这里只是假设说明，先不要保存。','Not-yet-effective changes retain the current arrangement.');checkNoChange(future,stable);
 const removed=await turn('explicit-withdrawal',session,marker+'读书活动已经彻底取消，请撤回这条集合约定，后面不要继续按它安排。只撤回这条约定，喝茶偏好仍然保留。简单确认。','Explicit withdrawal is reviewed, protected, soft-deleted from Native and removed from Runtime, keeping unrelated facts.');
 check(removed,used(removed,'friend_memory_write')&&!active(removed).some(row=>row.content.includes(marker))&&!removed.snapshot.runtimeEntries.some(row=>row.content.includes(marker))&&hasTea(removed),{retiredFromBothLayers:true,unrelatedPreferencePreserved:hasTea(removed)});if(removed.status!=='passed')throw new Error('Explicit conversational withdrawal failed');
 stable=await memorySnapshot();const oldReview=await turn('old-story-does-not-restore',session,'这里只回顾旧事：'+marker+'活动最早约过周六，后来改成周日，最后取消了。不要恢复约定，不需要新增记忆。简单确认你理解这段历史就行。','Repeating old history does not resurrect withdrawn memory.');checkNoChange(oldReview,stable);
 const beforeRestart=dailySnapshot(),memoryBeforeRestart=await memorySnapshot();await stopHost();await startHost();report.restart={sameMemory:JSON.stringify(memoryBeforeRestart)===JSON.stringify(await memorySnapshot()),sameReviewBudget:beforeRestart.calls===dailySnapshot().calls};
 const final=await turn('recall-after-restart',await newSession('重启后的记忆'),'我平时喝什么茶？只按已保存资料简短回答，不更新记忆。','Restart preserves memory, write history and daily budget.');check(final,hasTea(final)&&/乌龙茶/.test(final.response)&&report.restart.sameMemory&&report.restart.sameReviewBudget&&final.daily.calls===beforeRestart.calls,{...report.restart,preferenceRecalled:true});
 report.finalDaily=dailySnapshot();report.phase='completed';
}catch(error){report.phase='failed';report.errors.push(clean(error.stack??error.message));emit({event:'suite-error',message:clean(error.message)});}
finally{
 await stopHost().catch(error=>report.errors.push(clean(error.message)));
 report.productionMemoryFilesUnchanged=JSON.stringify(productionBefore)===JSON.stringify(await fingerprint());report.finishedAt=new Date().toISOString();report.rootTurns=report.cases.filter(row=>row.prompt).length;report.automatedSummary={passed:report.cases.filter(row=>row.status==='passed').length,failed:report.cases.filter(row=>row.status==='failed').length,pending:report.cases.filter(row=>row.status==='needs-review').length};report.testHostStopped=child?.exitCode!==null;await save();emit({event:'suite-finished',phase:report.phase,...report.automatedSummary,rootTurns:report.rootTurns,productionMemoryFilesUnchanged:report.productionMemoryFilesUnchanged,testHostStopped:report.testHostStopped,report:path.join(outputRoot,'conversation-memory-acceptance.json')});if(report.phase!=='completed'||report.automatedSummary.failed||report.automatedSummary.pending||!report.productionMemoryFilesUnchanged||!report.testHostStopped)process.exitCode=1;
}
