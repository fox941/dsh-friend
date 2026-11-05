import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {projectRoot,instanceRoot,selectedInstance} from './paths.mjs';
import {assertTestSafety} from './instances.mjs';
import {requestControl,controlReplyMatches} from './host-control.mjs';
import {RuntimeController} from './runtime-controller.mjs';
import {assertNoMigration} from './migration-lock.mjs';
import {assertNoUpdate} from './update-lock.mjs';
import {markManualAction,assertAutoStartIntent} from './autostart-core.mjs';
import {processStamp,recordAlive} from './process-records.mjs';
import {readJson,writeJson,alive,samePath,readIdentity,probeHost,preflight,launchHost,stopHost,sleep,pipeHeld} from './runtime-io.mjs';
const ops=path.join(instanceRoot,'operations'),recordFile=path.join(ops,'guard.json'),stateFile=path.join(ops,'state.json'),statusFile=path.join(ops,'status.json');
async function guardRecord(){
  const r=await readJson(recordFile);if(!r)return null;
  if(!samePath(r.instanceRoot,instanceRoot)||!samePath(r.projectRoot,projectRoot))throw Error('保护进程记录属于其他实例，未接管');
  return r;
}
async function guardStatus(record){
 const reply=await requestControl(record,'status',10000,1048576);
 if(!controlReplyMatches(record,reply,{guard:true}))throw Error('保护进程控制通道归属未通过核验');
 return reply;
}
function notify(event){
  if(process.platform!=='win32')return Promise.resolve();
  // Messages are fixed local health descriptions, never exception bodies or chat content.
  return new Promise(resolve=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(projectRoot,'scripts/Runtime-Notify.ps1'),'-Message',event.message],{windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>resolve(),2000);child.once('error',()=>{clearTimeout(timer);resolve();});child.once('exit',()=>{clearTimeout(timer);resolve();});child.unref();
  });
}
export async function watch(){
  if(process.env.AI_FRIEND_AUTOSTART_REV)assertAutoStartIntent(projectRoot);
  await assertNoUpdate(projectRoot);
  await assertNoMigration(projectRoot);
  assertTestSafety(selectedInstance);
  await fs.mkdir(ops,{recursive:true});
  const previous=await guardRecord();if(previous){if(await recordAlive(previous))throw Error('保护进程仍在运行');if(await pipeHeld(previous.pipe))throw Error('保护管道仍被一个已失去记录的守护进程占用；请结束该进程或重启电脑后重试，本次未接管');await fs.unlink(recordFile);}
  const state=await readJson(stateFile)??{schema:'ai-friend/runtime-state/1',identity:readIdentity(instanceRoot),desiredRunning:true,attempts:[],nextAttemptAt:0};
  if(state.schema!=='ai-friend/runtime-state/1'||typeof state.identity!=='string'||typeof state.desiredRunning!=='boolean'||!Array.isArray(state.attempts)||state.attempts.some(a=>!Number.isFinite(a)))throw Error('运行恢复状态无效，未创建新身份');
  const token=crypto.randomBytes(32).toString('hex'),hash=crypto.createHash('sha256').update(instanceRoot.toLowerCase()).digest('hex').slice(0,20);
  const record={pid:process.pid,...await processStamp(),startedAt:new Date().toISOString(),instanceRoot,projectRoot,token,pipe:process.platform==='win32'?`\\\\.\\pipe\\ai-friend-guard-${hash}`:path.join(instanceRoot,'guard.sock')};
  await fs.writeFile(recordFile,JSON.stringify(record),{flag:'wx',mode:0o600});
  let closing=false,queue=Promise.resolve(),timer;
  const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
  const controller=new RuntimeController({state,io:{probe:()=>probeHost(instanceRoot,projectRoot),alive,preflight:async identity=>{if(process.env.AI_FRIEND_AUTOSTART_REV)assertAutoStartIntent(projectRoot);await assertNoUpdate(projectRoot);assertTestSafety(selectedInstance);await preflight(instanceRoot,projectRoot,identity,selectedInstance.port,selectedInstance.host);},launch:()=>launchHost(instanceRoot,projectRoot,{port:selectedInstance.port}),stop:launch=>stopHost(instanceRoot,projectRoot,launch),save:value=>writeJson(stateFile,value),status:value=>writeJson(statusFile,value),notify}});
  const previousStatus=await readJson(statusFile);controller.events=previousStatus?.events?.slice(-100)??[];controller.alerts.active=new Set(previousStatus?.findings?.map(r=>r.code)??[]);
  const cleanup=async()=>{const current=await readJson(recordFile);if(current?.token===token)await fs.unlink(recordFile);};
  const server=net.createServer({allowHalfOpen:true},socket=>{
    let input='',handled=false;socket.setTimeout(60000,()=>socket.destroy());socket.on('error',()=>{});
    socket.on('data',chunk=>{
      input+=chunk;if(input.length>4096){socket.destroy();return;}if(handled||!input.includes('\n'))return;handled=true;
      let m;try{m=JSON.parse(input);}catch{socket.end(JSON.stringify({error:'Invalid request'}));return;}
      if(m.token!==token){socket.end(JSON.stringify({error:'Unauthorized'}));return;}
      if(!['status','start','stop','restart','recover'].includes(m.command)){socket.end(JSON.stringify({error:'Unknown command'}));return;}
      if(closing){socket.end(JSON.stringify({error:'保护进程正在停止，请等待退出后再启动'}));return;}
      if(m.command==='stop')closing=true;
      serial(async()=>{
        try{const result=m.command==='status'?{...await readJson(statusFile),guard:{pid:record.pid,startedAt:record.startedAt,instanceRoot,projectRoot}}:await controller.command(m.command);socket.end(JSON.stringify(result));}
        catch{socket.end(JSON.stringify({error:'操作未完成，未强杀进程；请查看运行状态和日志'}));}
        finally{if(m.command==='stop'){clearInterval(timer);server.close();await cleanup();}}
      }).catch(()=>{});
    });
  });
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(record.pipe,resolve);});
    await serial(()=>controller.tick());
    delete process.env.AI_FRIEND_AUTOSTART_REV;delete process.env.AI_FRIEND_AUTOSTART_MACHINE;
  }catch(error){
    server.close();await cleanup();
    if(error&&error.code==='EADDRINUSE')throw Error('守护管道已被占用：可能存在失去记录的守护进程；请重启电脑或结束该 node 进程后重试，本次未接管');
    throw error;
  }
  if(!closing)timer=setInterval(()=>{if(!closing)serial(()=>controller.tick()).catch(()=>{});},15000);
  // Stopping the guard alone leaves the managed Host intact. A regular Stop command stops both.
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{closing=true;clearInterval(timer);server.close();queue.finally(cleanup);});
}
async function ensureGuard(){
  let r=await guardRecord();
  if(r&&await recordAlive(r)){await guardStatus(r);return r;}
  const dir=path.join(instanceRoot,'logs');await fs.mkdir(dir,{recursive:true});const out=await fs.open(path.join(dir,'runtime-guard.out.log'),'a'),err=await fs.open(path.join(dir,'runtime-guard.err.log'),'a');
  try{const child=spawn(process.execPath,[path.join(projectRoot,'scripts/runtime.mjs'),'watch'],{cwd:projectRoot,detached:true,windowsHide:true,stdio:['ignore',out.fd,err.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();}finally{await out.close();await err.close();}
  const until=Date.now()+15000;while(Date.now()<until){r=await guardRecord();if(r&&await recordAlive(r)){try{await guardStatus(r);return r;}catch{}}await sleep(250);}throw Error('运行保护未启动，请查看 所选实例 logs/runtime-guard.err.log');
}
async function main(){
  if(['start','restart','recover'].includes((process.argv[2]??'status').toLowerCase()))await assertNoUpdate(projectRoot);
  const action=(process.argv[2]??'status').toLowerCase();if(action==='watch'){await watch();return;}
  if(!['start','stop','status','restart','recover'].includes(action))throw Error('Use start|stop|status|restart|recover');
  const automatic=!!process.env.AI_FRIEND_AUTOSTART_REV;
  if(automatic&&action==='start')assertAutoStartIntent(projectRoot);
  else if(selectedInstance.id==='main'&&['start','stop','restart','recover'].includes(action)){try{await markManualAction(projectRoot,action);}catch{console.error('自启意图未更新，请检查 Autostart-Status；继续处理当前实例操作。');}}
  let record=await guardRecord(),result;
  if(action==='status'){
    const host=await probeHost(instanceRoot,projectRoot);
    let guardRunning=false,guardIssue=false;
    if(record&&await recordAlive(record)){try{await guardStatus(record);guardRunning=true;}catch{guardIssue=true;}}
    result={instance:selectedInstance.id,label:selectedInstance.label,dataRoot:instanceRoot,url:'http://'+selectedInstance.host+':'+selectedInstance.port,guardRunning,guardIssue,host,observed:await readJson(statusFile)};
  }else if(action==='stop'){
    if(record&&await recordAlive(record)){await guardStatus(record);result=await requestControl(record,'stop',45000);if(result.error)throw Error(result.error);const until=Date.now()+5000;while(await guardRecord()){if(Date.now()>until)throw Error('保护进程尚未退出');await sleep(100);}}
    else{const state=await readJson(stateFile);if(state)await writeJson(stateFile,{...state,desiredRunning:false});await stopHost(instanceRoot,projectRoot);result={stopped:true};}
  }else{record=await ensureGuard();if(automatic)assertAutoStartIntent(projectRoot);result=await requestControl(record,action,45000);if(result.error)throw Error(result.error);}
  console.log(JSON.stringify(result,null,2));
}
if(pathToFileURL(path.resolve(process.argv[1]??'')).href===import.meta.url)main().catch(()=>{console.error('运行管理未完成。请查看 对应的 Main-Status.cmd 或 Test-Status.cmd 与所选实例 logs；未终止未知进程或重建记忆。');process.exitCode=1;});
