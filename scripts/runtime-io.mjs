import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {requestControl,controlReplyMatches} from './host-control.mjs';
import {assertNoPendingUndo} from './protection-control.mjs';
import {recordAlive,inspectProcessRecord} from './process-records.mjs';
export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function writeJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);}
export function alive(pid){if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid recorded PID');try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
export function pipeHeld(pipe,timeoutMs=800){return new Promise(resolve=>{const socket=net.createConnection(pipe);let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();resolve(value);};const timer=setTimeout(()=>finish(false),timeoutMs);socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));});}
export function samePath(a,b){return typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();}
export function readIdentity(root){
  const db=new DatabaseSync(path.join(root,'companion/companion.sqlite'),{readOnly:true,timeout:1000});
  try{const identity=db.prepare("SELECT value FROM growth_meta WHERE key='identity'").get()?.value;if(typeof identity!=='string'||!identity)throw Error('Missing identity');return identity;}finally{db.close();}
}
export async function probeHost(root,project){
  const record=await readJson(path.join(root,'host.json'));
  if(!record)return {state:'absent'};
  if(!samePath(record.instanceRoot,root)||!samePath(record.projectRoot,project))return {state:'owner_conflict',message:'Host 记录不属于本实例，未接管进程'};
  const processState=await inspectProcessRecord(record);
  if(['dead','reused'].includes(processState.state))return {state:'dead',pid:record.pid,proof:processState.proof};
  try{
    const reply=await requestControl(record,'health',8000,1048576);
    if(!controlReplyMatches(record,reply))return {state:'owner_conflict',pid:record.pid,message:'控制通道归属未通过核验，保留现场'};
    return {state:'running',pid:reply.pid,startedAt:Date.parse(reply.startedAt),stopping:reply.stopping,health:reply.health,proof:'authenticated_control',processProof:processState.proof};
  }catch{return {state:'host_unresponsive',pid:record.pid,message:'记录中的进程仍在，但控制通道无响应；未强杀或另启实例'};}
}
async function portAvailable(port,address='127.0.0.1'){
  const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',()=>reject(Error('Port occupied')));server.listen(port,address,resolve);});await new Promise(resolve=>server.close(resolve));
}
export async function preflight(root,project,identity,port,address='127.0.0.1'){
  // Never launch with an empty/new identity after a missing data folder or bad copy.
  if(readIdentity(root)!==identity)throw Error('身份记录与原实例不一致，已阻止恢复');
  const host=await probeHost(root,project);if(!['absent','dead'].includes(host.state))throw Error('原实例仍在运行或其归属无法确认');
  const lock=await readJson(path.join(root,'host.lock'));if(lock&&await recordAlive(lock))throw Error('实例或离线维护持有运行锁');
  await assertNoPendingUndo(root);await portAvailable(port,address);
}
export async function launchHost(root,project,{port=3080,entry=path.join(project,'scripts/host.mjs'),args=['start'],env=process.env}={}){
  const logRoot=path.join(root,'logs');await fs.mkdir(logRoot,{recursive:true});const stamp=new Date().toISOString().replaceAll(':','-');
  const out=await fs.open(path.join(logRoot,stamp+'.out.log'),'a'),err=await fs.open(path.join(logRoot,stamp+'.err.log'),'a');
  try{
    const hostEnv={...env};delete hostEnv.AI_FRIEND_AUTOSTART_REV;delete hostEnv.AI_FRIEND_AUTOSTART_MACHINE;
    const child=spawn(process.execPath,[entry,...args],{cwd:project,env:hostEnv,windowsHide:true,detached:true,stdio:['ignore',out.fd,err.fd]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    return {pid:child.pid,at:Date.now(),port};
  }finally{await out.close();await err.close();}
}
export async function stopHost(root,project,launch){
  const record=await readJson(path.join(root,'host.json'));if(!record){if(launch&&alive(launch.pid))throw Error('启动进程仍在，但尚无控制通道；已关闭自动恢复，请稍后再次停止');return;}
  if(!samePath(record.instanceRoot,root)||!samePath(record.projectRoot,project))throw Error('进程归属不一致，未停止');
  if(!await recordAlive(record)){if(launch&&alive(launch.pid))throw Error('新进程仍在启动，已关闭自动恢复，请稍后再次停止');return;}
  const status=await requestControl(record,'status');if(!controlReplyMatches(record,status,{requireProject:false}))throw Error('进程身份核验失败');
  const reply=await requestControl(record,'stop');if(!reply.accepted)throw Error('Host 未接受停止');
  const until=Date.now()+30000;while(Date.now()<until){if(!alive(record.pid))return;await sleep(200);}throw Error('等待优雅停止超时，保留原进程，请检查日志');
}
