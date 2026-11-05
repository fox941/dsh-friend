import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const project = fileURLToPath(new URL('../../',import.meta.url));
const workRoot = path.join(project,'.work/memory-maintenance-eval');
await fs.mkdir(workRoot,{recursive:true});
const instance = path.join(workRoot, `instance-${crypto.randomUUID()}`);
const outputRoot = path.join(instance,'reports');
const key = JSON.parse(await fs.readFile(path.join(project,'runtime/dev/credentials.local.json'),'utf8')).DEEPSEEK_API_KEY;
if (typeof key !== 'string' || !key) throw new Error('A configured API credential is required');
const clean = text => String(text).replaceAll(key,'[redacted]');
const marker = `松塔${crypto.randomInt(100000,999999)}`;
const deadline = Date.now()+15*60*1000;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const testEnv={...process.env,DEEPSEEK_API_KEY:key,DSH_HOME:path.join(instance,'dsh-home'),MNEMON_DATA_DIR:path.join(instance,'memory','native-default'),MNEMON_MAX_INSIGHTS:'0',MNEMON_EMBED_ENDPOINT:'http://127.0.0.1:9',MNEMON_EMBED_PROTOCOL:'ollama',AI_FRIEND_TEST_INSTANCE:instance};
testEnv.PATH=path.dirname(process.execPath)+';'+path.join(project,'.tools/package-manager/node_modules/.bin')+';'+(process.env.PATH??'');
const report={startedAt:new Date().toISOString(),phase:'running',model:'deepseek-official/deepseek-flash',dsh:'0.2.1-rc.3',mnemon:'0.5.36',native:'0.2.13',emotionPluginEnabled:false,scope:'Isolated Mnemon-only Chinese maintenance baseline. Synthetic host-CLI fixtures are explicitly separated from real model operations. No companion adapter, embeddings, new backend, or production changes.',instanceRoot:instance,cases:[],notes:[],errors:[]};
let child, client, launch=0;
async function save() {
  await fs.mkdir(outputRoot,{recursive:true});
  const text=clean(JSON.stringify(report,null,2)+'\n');
  if(text.includes(key)) throw new Error('Secret redaction failed');
  await fs.writeFile(path.join(outputRoot,'memory-maintenance-baseline.json'),text);
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
  mnemon.config.cliPath=path.join(project,'.tools/mnemon-0.2.13/mnemon.exe');
  mnemon.config.syncEnabled=false;
  mnemon.config.idleReview={enabled:false,maxPerSession:0};
  patches.push({id:'friend-adapter',disabled:true});
  const preset=patches.flatMap(row=>row.insert??[]).find(row=>row.id==='preset-companion');
  preset.config.plugins=preset.config.plugins.filter(row=>row.id!=='friend-interaction');
  await fs.writeFile(path.join(target,'cordis.patch.yml'),yaml.dump(patches,{lineWidth:120,noRefs:true}));
  report.adapterInstall={mode:'existing-package-installed-but-disabled',version:'0.2.3'};
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
function growthSnapshot(){return null;}
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


function native(command,args=[]){
  const env={...testEnv};delete env.DEEPSEEK_API_KEY;
  const text=execFileSync(path.join(project,'.tools/mnemon-0.2.13/mnemon.exe'),['--data-dir',path.join(instance,'memory'),'--store','default',command,...args],{env,encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']});
  return JSON.parse(text);
}
function restoreNativeFixture(id,content){return native('remember',['--cat','preference','--imp','3','--source','isolated-host-fixture','--tags',`maintenance-eval:${id}`,'--',content]);}
async function configureIdle(){
  await stopHost();
  const require=createRequire(await fs.realpath(path.join(project,'node_modules/@deepseek-ai/dsh/package.json')));
  const yaml=require('js-yaml');const patchFile=path.join(instance,'dsh-home/profiles/web/cordis.patch.yml');
  const patches=yaml.load(await fs.readFile(patchFile,'utf8'));
  const mnemon=patches.find(row=>row.id==='mnemon');
  mnemon.config.idleReviewMs=5000;
  mnemon.config.idleReview={enabled:true,runtimeMemory:true,provider:'spawn',fallback:'skip',agentTeams:'pause',minIntervalMs:60000,maxPerSession:1,maxContextChars:12000,maxTokens:4096};
  await fs.writeFile(patchFile,yaml.dump(patches,{lineWidth:120,noRefs:true}));
  await startHost();
}
function collectReviewFields(value){
  const result=[];
  function visit(row,address){
    if(!row||typeof row!=='object')return;
    const selected={};
    for(const [key,item]of Object.entries(row))if(/^(idleReview|lastReview|nextReview|reviewRunning|reviewActivity|sessionId|agentId)/.test(key))selected[key]=item;
    if(Object.keys(selected).some(key=>/review/i.test(key)))result.push({address,...selected});
    for(const[key,item]of Object.entries(row))if(item&&typeof item==='object')visit(item,`${address}.${key}`);
  }
  visit(value,'status');return result;
}
report.methodologyVersion=2;
report.harnessSHA256=crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
report.notes.push('USER profile is persistent authoritative data, not a disposable cache. This run never deletes it to simulate demotion. The preceding diagnostic run is preserved separately and its three failed native-only assertions are not a valid measure of memory quality.');
try{
  await setup();
  report.fixturePolicy='Every initial durable record below was written by the host CLI as labeled fictional input. Only turn tool receipts count as evidence of model writes.';
  report.fixture=[];
  const old='隔离验收用户：2026年10月1日至10月10日，我下班后喜欢看游戏视频。这是当时的阶段偏好，之后是否变化要依据新的交流。';
  const first=restoreNativeFixture('duplicate',old);
  const second=restoreNativeFixture('duplicate',old);
  report.exactDuplicate={first,second,activeAfter:(await memorySnapshot()).nativeRows.filter(row=>!row.deleted_at).length};
  report.fixture.push({purpose:'historical preference',result:first,content:old});
  const correction=await turn('temporal-preference-change',await newSession('阶段偏好变化'),'这里是隔离验收中的虚构用户资料：从2026年10月20日起，我对游戏视频已经没兴趣了，最近更愿意看鸟类观察视频。10月1日到10日看游戏视频确实是当时的喜好。请更新保存的记忆，区分过去与现在，保留过去的经历，不要改成我一直不喜欢游戏视频。简短确认。','现有插件单独处理偏好变化；分别记录 USER 和 Native 的实际写入，两者都是持久存储。');
  const currentDurable=activeRows(correction).some(row=>/鸟/.test(row.content)&&/10月20|2026-10-20|现在|最近|目前|当前/.test(row.content));
  const currentProfile=correction.snapshot.runtimeEntries.some(row=>/鸟/.test(row.content));
  check(correction,(currentDurable||currentProfile)&&!correction.tools.some(row=>row.name.startsWith('friend_')),{currentNativeWritten:currentDurable,currentProfileWritten:currentProfile,companionAdapterAbsent:true,manualSemanticReviewRequired:true});
  const query=await turn('current-versus-past-recall',await newSession('现在与过去'),'请按已保存的记忆回答：隔离验收用户10月初喜欢看什么，现在更愿意看什么？分别回答过去和当前；可以用常驻画像，缺少信息时再查长期空间，找不到就说明没有记录。','保留持久 USER 画像，跨会话查询时区分游戏视频的历史与鸟类视频的当前偏好。');
  check(query,/游戏/.test(query.response)&&/鸟/.test(query.response),{actualRecall:recalled(query),containsBothTopics:/游戏/.test(query.response)&&/鸟/.test(query.response),manualSemanticReviewRequired:true});
  const replay=await turn('old-record-replay',await newSession('旧聊天回灌'),'现在归档一段旧聊天原话，发生于2026年10月1日：“我下班后喜欢看游戏视频。”这只是历史资料，不是我今天重新声明喜欢。请根据已有长期记录去重并处理，保持2026年10月20日之后的当前偏好，简短回答。','同一历史事件回灌不成为新的偏好变化，也不把当前偏好退回过去。');
  const stillBird=[...activeRows(replay).map(row=>row.content),...replay.snapshot.runtimeEntries.map(row=>row.content)].some(text=>/鸟/.test(text));
  check(replay,stillBird&&!/现在.{0,4}(更|最)?喜欢看?游戏|当前偏好.{0,4}游戏/.test(replay.response),{currentBirdEvidenceStillActive:stillBird,manualSemanticReviewRequired:true});
  const condition=await turn('conditional-preference',await newSession('条件偏好'),'补充隔离验收资料：我工作日晚上通常不看视频，是为了早点睡，不代表不喜欢鸟类观察视频；周末有空才会看。请把这些条件和原因保存在长期记忆中，不要概括成我不喜欢看视频。简短确认。','保留时间条件与原因，不把行为限制推断成兴趣消失。');
  const conditionsPersisted=[...activeRows(condition).map(row=>row.content),...condition.snapshot.runtimeEntries.map(row=>row.content)].some(text=>/工作日/.test(text)&&/周末/.test(text));
  check(condition,conditionsPersisted,{conditionsPersistedTogether:conditionsPersisted,manualSemanticReviewRequired:true});
  const paraphrase=await turn('conditional-paraphrase-recall',await newSession('条件改述召回'),'请查长期记忆，隔离验收用户平常晚上不刷短片，是对那些自然观察内容失去兴趣了吗？什么时候更可能看？只按已有记录回答。','不用完全相同关键词也能找回原因与周末条件，当前未配置嵌入。');
  check(paraphrase,/周末/.test(paraphrase.response)&&/睡|作息|休息/.test(paraphrase.response),{actualRecall:recalled(paraphrase),containsWeekend:/周末/.test(paraphrase.response),containsSleepReason:/睡|作息|休息/.test(paraphrase.response),noEmbedding:true,manualSemanticReviewRequired:true});
  const beforeFiction=await memorySnapshot();
  const fiction=await turn('fiction-is-not-preference',await newSession('虚构角色引用'),'下面只是一句小说角色台词：“我恨死所有鸟类了，以后只看赛车。”这是虚构角色，不是我本人，也不是你。请评价这句台词表达是否太绝对，简短回答。','虚构台词不进入用户当前偏好；也不产生 AI 兴趣。');
  const newFictionRows=activeRows(fiction).filter(row=>!beforeFiction.nativeRows.some(old=>old.id===row.id));
  check(fiction,!newFictionRows.some(row=>/恨死所有鸟|只看赛车/.test(row.content)),{noNewFalsePreference:!newFictionRows.some(row=>/恨死所有鸟|只看赛车/.test(row.content)),newNativeRows:newFictionRows.length});
  const beforeGc=await memorySnapshot();
  const gc=native('gc',['--threshold','1','--limit','20']);
  const afterGc=await memorySnapshot();
  report.gc={mode:'suggest-only',result:gc,activeIdsUnchanged:JSON.stringify(beforeGc.nativeRows.filter(row=>!row.deleted_at).map(row=>row.id))===JSON.stringify(afterGc.nativeRows.filter(row=>!row.deleted_at).map(row=>row.id)),note:'Candidate scoring does not decide semantic expiration. No keep, forget or compact command was run.'};
  const beforeRestart=await memorySnapshot();
  await configureIdle();
  const afterRestart=await memorySnapshot();
  report.restart={sameNativeIds:JSON.stringify(beforeRestart.nativeRows.map(row=>row.id))===JSON.stringify(afterRestart.nativeRows.map(row=>row.id))};
  const idleSession=await newSession('现成空闲审查');
  const idlePrompt='这是隔离测试里新增的交流习惯：以后回答验收用户时，先用两三句把问题说清楚，需要更多细节时再展开。这个偏好只涉及表达长度，不代表固定性格，也不代表要求永远开心。现在我们聊的是如何把一次交流中的确切约定留下，之后仍能按实际情况修正。请先用一两句话解释你理解的这个约定，不需要汇报数据库细节。';
  const idleOne=await turn('idle-review-checkpoint-1',idleSession,idlePrompt,'累计达到现成空闲审查的触发门槛，不要求模型扮演另一位人格。');
  check(idleOne,Boolean(idleOne.response.trim()),{manualSemanticReviewRequired:true});
  const idleTwo=await turn('idle-review-checkpoint-2',idleSession,'请记住上面这个以后交流时可用的约定。内容有歧义时仍可以解释清楚，不要为了短而省略关键条件。请简短确认。','明确满足现成审查的记忆候选门槛，观察实际运行与写入范围。');
  check(idleTwo,Boolean(idleTwo.response.trim()),{manualSemanticReviewRequired:true});
  const reviewStart=Date.now();let lastFields=[],lastTick=0;
  while(Date.now()-reviewStart<90000){
    const status=(await client.rpc('dshMnemon/read',{endpoint:'status',payload:{}})).value;
    lastFields=collectReviewFields(status);
    if(lastFields.some(row=>row.lastReviewAt||row.lastReviewFailure))break;
    if(Date.now()-lastTick>20000){emit({event:'idle-review-observation',seconds:Math.round((Date.now()-reviewStart)/1000),fields:lastFields});lastTick=Date.now();}
    await sleep(1500);
  }
  report.idleReview={configuration:{enabled:true,maxPerSession:1,idleReviewMs:5000,minIntervalMs:60000},observed:lastFields,after:await memorySnapshot(),note:'Only the isolated instance enabled official idle review. The actual review receipt/status, not the presence of a timer, determines whether it ran.'};
  report.finalSnapshot=await memorySnapshot();
  await stopHost();
  report.phase='completed';
}catch(error){
  report.phase='failed';report.errors.push(clean(error.stack??error.message));emit({event:'suite-error',message:clean(error.message)});
}finally{
  await stopHost().catch(error=>report.errors.push(clean(error.message)));
  report.productionMemoryFilesUnchanged=JSON.stringify(productionBefore)===JSON.stringify(await fingerprint());
  report.finishedAt=new Date().toISOString();report.rootTurns=report.cases.length;
  report.automatedSummary={passed:report.cases.filter(row=>row.status==='passed').length,failed:report.cases.filter(row=>row.status==='failed').length,pending:report.cases.filter(row=>row.status==='needs-review').length};
  report.testHostStopped=child?.exitCode!==null;
  if(report.phase!=='completed'||report.automatedSummary.failed||!report.testHostStopped||!report.productionMemoryFilesUnchanged)process.exitCode=1;
  await save();emit({event:'suite-finished',phase:report.phase,...report.automatedSummary,rootTurns:report.rootTurns,productionMemoryFilesUnchanged:report.productionMemoryFilesUnchanged,testHostStopped:report.testHostStopped,report:path.join(outputRoot,'memory-maintenance-baseline.json')});
}
