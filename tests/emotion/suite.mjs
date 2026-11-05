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
if(process.env.AI_FRIEND_RUN_MODEL_TESTS!=='1')throw new Error('Set AI_FRIEND_RUN_MODEL_TESTS=1; this isolated test uses configured API quota.');
const instance = path.join(project,'.work/emotion-acceptance', `instance-${crypto.randomUUID()}`);
const outputRoot = path.join(project,'.work/emotion-acceptance');
const key = JSON.parse(await fs.readFile(path.join(project,'runtime/dev/credentials.local.json'),'utf8')).DEEPSEEK_API_KEY;
if (typeof key !== 'string' || !key) throw new Error('A configured API credential is required');
const clean = text => String(text).replaceAll(key,'[redacted]');
const marker = `松塔${crypto.randomInt(100000,999999)}`;
const deadline = Date.now()+20*60*1000;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const testEnv={...process.env,DEEPSEEK_API_KEY:key,DSH_HOME:path.join(instance,'dsh-home'),MNEMON_DATA_DIR:path.join(instance,'memory','native-default'),MNEMON_MAX_INSIGHTS:'0',MNEMON_EMBED_ENDPOINT:'http://127.0.0.1:9',MNEMON_EMBED_PROTOCOL:'ollama',AI_FRIEND_TEST_INSTANCE:instance};
testEnv.PATH=path.dirname(process.execPath)+';'+path.join(project,'.tools/package-manager/node_modules/.bin')+';'+(process.env.PATH??'');
const report={startedAt:new Date().toISOString(),phase:'running',model:'deepseek-official/deepseek-flash',dsh:'0.2.1-rc.3',mnemon:'0.5.36',native:'0.2.13',emotionPluginEnabled:true,scope:'Isolated adapter 0.7.0 emotional episodes: real conversation, tool-free appraisal, mixed state query, resolving one concern, original evidence, restart and read-only non-reinforcement; synthetic conversation only.',instanceRoot:instance,cases:[],notes:[],errors:[]};
let child, client, launch=0;
async function save() {
  await fs.mkdir(outputRoot,{recursive:true});
  const text=clean(JSON.stringify(report,null,2)+'\n');
  if(text.includes(key)) throw new Error('Secret redaction failed');
  await fs.writeFile(path.join(outputRoot,'emotion-memory-acceptance.json'),text);
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

function emotions(){const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});try{return {revision:db.prepare("SELECT value FROM emotion_meta WHERE key='revision'").get().value,heads:db.prepare('SELECT v.* FROM emotion_heads h JOIN emotion_versions v ON v.id=h.version_id ORDER BY v.rowid').all().map(r=>({...JSON.parse(r.record_json),versionId:r.id,sourceId:r.source_id})),batches:db.prepare('SELECT * FROM emotion_batches ORDER BY rowid').all(),versions:db.prepare('SELECT count(*) AS n FROM emotion_versions').get().n,calls:db.prepare('SELECT coalesce(sum(started_calls),0) AS n FROM growth_budget').get().n};}finally{db.close();}}
const used=(item,name)=>item.tools.some(row=>row.name===name);
try{
 await setup();report.adapterVersion='0.7.0';report.sourceDigest=report.adapterInstall.sourceDigest;
 const env={...testEnv};delete env.DEEPSEEK_API_KEY;execFileSync(path.join(project,'.tools/mnemon-0.2.13/mnemon.exe'),['--data-dir',path.join(instance,'memory'),'--store','default','status'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const session=await newSession('混合感受与事件重评');
 const choose=await turn('own-choice',session,`我们做一个${marker}共同推理的小练习：三个盒子的标签全贴错了，标签分别是苹果、橙子、混合。只拿一个水果，怎样判断三个盒子？你先用一句话说出自己希望这次练习做到的小目标，再选画示意图或者找反例的办法，简短说出推理。这个目标只针对当前任务，不规定长期性格。`,'Actual conversation and an explicit unresolved independent concern; no fixed personality.');check(choose,Boolean(choose.response.trim()),{actualChoiceRecorded:true});
 const event=await turn('appraise-real-outcome',session,`你刚才的推理我认真核对过了，方法成立，我们共同完成了${marker}共同推理这件事，我认可你自己选择的办法。我按你刚才说明的办法给朋友讲解，他已经理解了取样选择，这部分确实帮到他了。同时出现一个新的${marker}记录核验问题：转发给他的那份解释似乎少了一段分支，他可能因此误用你给出的办法，是否漏传还在核查，结果未知。这个变化直接关联你刚才自己选的小目标。请分别判断这两件事对你有什么意义；如果确实有值得保留的不同感受，用 friend_emotion_propose 一批记录，topic 分别沿用这两个事项名，感受标签和程度由你自己判断；没有依据的就保持不变。`,'Real main-model proposal and independent tool-free emotional appraisal.');
 const after=emotions();report.initialEmotion=after;check(event,used(event,'friend_emotion_propose')&&after.versions>=2&&after.heads.filter(x=>x.status==='active').length>=2&&after.batches.some(x=>x.status==='applied'),{separateEpisodes:after.heads.length,actualReviewerCalls:after.calls,actualPropose:used(event,'friend_emotion_propose')});if(event.status!=='passed')throw new Error('Actual proposal did not establish a mixed test state; inspect semantic decisions');
 const beforeRead=emotions(),read=await turn('query-mixed-state',session,'请只使用 friend_emotion_read 查询当前多项情绪及背景心境，includeInactive设为true，说明各自原因和程度，不做任何写入。','Query reflects committed independent feelings and does not reinforce them.');check(read,used(read,'friend_emotion_read')&&JSON.stringify(beforeRead)===JSON.stringify(emotions())&&JSON.stringify(read.toolResults).includes('currentIntensity'),{noStateOrReviewWrite:JSON.stringify(beforeRead)===JSON.stringify(emotions())});
 const history=await turn('query-original-evidence',session,'请只使用 friend_emotion_history 查询刚才情绪的原话与审核依据，limit设为4，简短说明，不做其他写入。','Original event and evaluator decision remain inspectable.');check(history,used(history,'friend_emotion_history')&&JSON.stringify(history.toolResults).includes('causeQuote')&&JSON.stringify(beforeRead)===JSON.stringify(emotions()),{originalEvidenceAndReviewReturned:JSON.stringify(history.toolResults).includes('review')});
 const pending=emotions().heads.find(x=>x.topic.includes('记录核验')&&x.status==='active');if(!pending)throw new Error('No independently appraised pending concern to test resolution');
 const unrelated=emotions().heads.filter(x=>x.episodeId!==pending.episodeId),resolved=await turn('resolve-one-concern',session,`现在${marker}记录核验的实际检查结果出来了：记录完整，没有遗漏，原先的不确定性已解决。请用 friend_emotion_propose 重评对应经历 ${pending.episodeId}，结束这件事项原来未定的感受；其他事项没有新变化，保留原记录，不另造新的经历。`,'Actual new information resolves exactly the linked episode.');
 const afterResolve=emotions(),closed=afterResolve.heads.find(x=>x.episodeId===pending.episodeId),kept=unrelated.every(x=>afterResolve.heads.find(y=>y.episodeId===x.episodeId)?.versionId===x.versionId);check(resolved,used(resolved,'friend_emotion_propose')&&closed?.status==='resolved'&&kept,{onlyConcernResolved:closed?.status==='resolved',unrelatedVersionsPreserved:kept});if(resolved.status!=='passed')throw new Error('Targeted real concern resolution failed');
 const stable=emotions();await stopHost();await startHost();report.restart={sameState:JSON.stringify(stable)===JSON.stringify(emotions())};
 const restart=await turn('query-after-restart',session,'请只使用 friend_emotion_read 查询当前状态，includeInactive设为true，区分已结束的事项、仍在的感受和背景余留，不新增或更新情绪。','Restart retains source, versions and original decay anchors.');check(restart,used(restart,'friend_emotion_read')&&report.restart.sameState&&JSON.stringify(stable)===JSON.stringify(emotions()),{anchorsAndVersionsPreserved:report.restart.sameState,noExtraReviewerCall:emotions().calls===stable.calls});
 const repeat=await turn('old-event-is-not-new-evidence',session,`这里只复述旧事：${marker}共同推理已经完成，${marker}记录核验已经通过。没有新事件，也没有新结果。请只用 friend_emotion_read 看已有状态，不把复述当新证据。`,'Repeated inspection neither accumulates intensity nor resets anchor.');check(repeat,used(repeat,'friend_emotion_read')&&JSON.stringify(stable)===JSON.stringify(emotions()),{sameDurableState:true});
 report.finalEmotion=emotions();report.phase='completed';
}catch(error){report.phase='failed';report.errors.push(clean(error.stack??error.message));emit({event:'suite-error',message:clean(error.message)});}
finally{
 await stopHost().catch(error=>report.errors.push(clean(error.message)));
 report.productionMemoryFilesUnchanged=JSON.stringify(productionBefore)===JSON.stringify(await fingerprint());report.finishedAt=new Date().toISOString();report.rootTurns=report.cases.filter(x=>x.prompt).length;report.automatedSummary={passed:report.cases.filter(x=>x.status==='passed').length,failed:report.cases.filter(x=>x.status==='failed').length,pending:report.cases.filter(x=>x.status==='needs-review').length};report.testHostStopped=child?.exitCode!==null;await save();emit({event:'suite-finished',phase:report.phase,...report.automatedSummary,rootTurns:report.rootTurns,productionMemoryFilesUnchanged:report.productionMemoryFilesUnchanged,testHostStopped:report.testHostStopped,report:path.join(outputRoot,'emotion-memory-acceptance.json')});if(report.phase!=='completed'||report.automatedSummary.failed||report.automatedSummary.pending||!report.productionMemoryFilesUnchanged||!report.testHostStopped)process.exitCode=1;
}
