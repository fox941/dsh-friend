import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {atomicJson} from './update-lock.mjs';import {readJson} from './migration-files.mjs';import {child} from './update-ops.mjs';import {probeHost,sleep} from './runtime-io.mjs';import {prepareQQ,checkBilibili} from './autostart-platforms.mjs';
const execute=promisify(execFile);
export async function capture(command,args,{cwd,env=process.env,timeout=20000}={}){const r=await execute(command,args,{cwd,env,windowsHide:true,encoding:'utf8',timeout,maxBuffer:1048576});return JSON.parse(r.stdout.replace(/^\ufeff/,''));}
export async function machineContext(project){return capture('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/Autostart-Task.ps1'),'-Action','Context'],{cwd:project});}
export async function taskAction(project,action,config){
 const file=path.join(project,'.work','autostart-plan-'+crypto.randomUUID()+'.json');await atomicJson(file,config);try{return await capture('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/Autostart-Task.ps1'),'-Action',action,'-Plan',file],{cwd:project,timeout:30000});}finally{await fs.unlink(file).catch(()=>{});}
}
const env=extra=>({...process.env,AI_FRIEND_INSTANCE:'main',...extra});
export function startupHooks(project){
 const root=path.join(project,'runtime/dev'),runtime=path.join(project,'scripts/runtime.mjs'),log=name=>path.join(root,'logs','autostart-'+name+'.log');
 const mainStatus=async()=>{const r=await capture(process.execPath,[runtime,'status'],{cwd:project,env:env({}),timeout:25000});const waiting=r.host.state==='host_unresponsive'&&r.guardRunning&&r.observed?.state==='starting';return {...r.host,state:waiting?'starting':r.host.state,guardRunning:r.guardRunning};};
 return {
  mainStatus,
  startMain:c=>child(process.execPath,[runtime,'start'],{cwd:project,env:env({AI_FRIEND_AUTOSTART_REV:String(c.revision),AI_FRIEND_AUTOSTART_MACHINE:c.machineKey}),log:log('main'),timeoutMs:60000}),
  stopMain:()=>child(process.execPath,[runtime,'stop'],{cwd:project,env:env({}),log:log('main'),timeoutMs:60000}),
  waitMain:async()=>{for(let n=0;n<120;n++){const state=await mainStatus();if(state.state==='running'&&state.health?.available)return state;if(['owner_conflict','host_unresponsive'].includes(state.state))throw Error('启动主实例时控制通道或归属异常');await sleep(1000);}throw Error('等待主实例就绪超时');},
  qq:allowed=>prepareQQ(project,{allowed,hasOtherQQ:async()=>{const v=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"if (Get-Process -Name QQ -ErrorAction SilentlyContinue) {Write-Output 'yes'} else {Write-Output 'no'}"],{windowsHide:true,encoding:'utf8',timeout:15000});return v.stdout.trim()==='yes';},launch:()=>child('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/QQ.ps1'),'-Action','Start','-NoBrowser'],{cwd:project,env:env({}),log:log('qq'),timeoutMs:60000})}),
  bilibili:()=>checkBilibili(project),
  notify:async message=>child('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/Runtime-Notify.ps1'),'-Message',message.slice(0,240)],{cwd:project,log:log('notice'),timeoutMs:15000}).catch(()=>{}),
 };
}
