import {requireMain} from './instances.mjs';
import {assertNoUpdate} from './update-lock.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {projectRoot} from './paths.mjs';
import {createMigration,verifyMigration,restoreMigration,nodeRelative} from './migration-core.mjs';
import {readJson,checkInstalledPackages} from './migration-files.mjs';
export async function runChild(file,args,{cwd,log,onLine=()=>{},timeoutMs=3600000}={}){
  let output;try{if(log){await fs.mkdir(path.dirname(log),{recursive:true});output=await fs.open(log,'a');}
    return await new Promise((resolve,reject)=>{
      const child=spawn(file,args,{cwd,env:process.env,windowsHide:true,stdio:['ignore',output?output.fd:'pipe',output?output.fd:'pipe']});let tail='',done=false;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
      const timer=setTimeout(()=>{child.kill();finish(Error('维护子命令超时；原实例保持停止，可重试'));},timeoutMs);
      child.on('error',()=>finish(Error('无法启动维护子命令')));
      if(!output)for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{tail+=chunk.toString();if(tail.length>32768)tail=tail.slice(-32768);for(const line of tail.split('\n').slice(0,-1))onLine(line);tail=tail.split('\n').at(-1);});
      child.on('close',code=>finish(code===0?null:Error('维护子命令未完成；请检查安装日志或确认 NapCat/AI QQ 和本项目其他命令已经关闭')));
    });
  }finally{if(output)await output.close();}
}
export async function checkWriters(project,scriptProject=project){
  let ports=[];try{const qq=await readJson(path.join(project,'runtime/dev/channels/qq/config.local.json')),web=await readJson(path.join(project,'runtime/dev/channels/qq/napcat/config/webui.json'));ports=[Number(new URL(qq.url??'ws://127.0.0.1:3001').port)||3001,web.port].filter(p=>Number.isInteger(p)&&p>0&&p<65536);}catch(e){if(e.code!=='ENOENT')throw Error('本地平台配置无效，未打包');}
  await runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(scriptProject,'scripts/migration-preflight.ps1'),'-ProjectRoot',project,'-OwnerPid',String(process.pid),...ports.length?['-PortsCsv',ports.join(',')]:[]],{cwd:scriptProject,timeoutMs:20000});
}
export async function compressBundle(project,bundle,zip){await runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/migration-zip.ps1'),'-BundleRoot',bundle,'-Destination',zip],{cwd:project,onLine:line=>{if(/^ZIP files: \d+\/\d+$/.test(line.trim()))console.log(line.trim());}});}
export async function installRestored(target){
  const log=path.join(target,'.work/migration-setup.log');await runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(target,'Setup.ps1'),'-RestoreExisting'],{cwd:target,log,timeoutMs:1800000});await checkInstalledPackages(target);
}
async function main(){
  if(process.argv[2]!=='verify')await assertNoUpdate(projectRoot);
  requireMain('主实例迁移');
  const [action,...args]=process.argv.slice(2),value=key=>{const at=args.indexOf(key);return at<0?undefined:args[at+1];};
  const progress=event=>console.log(JSON.stringify(event));
  if(action==='pack'){
    await runChild(process.execPath,[path.join(projectRoot,'scripts/runtime.mjs'),'stop'],{cwd:projectRoot,timeoutMs:50000});await new Promise(r=>setTimeout(r,800));
    const result=await createMigration({project:projectRoot,destination:value('--output')??path.join(projectRoot,'releases/migration'),onProgress:progress,checkWriters:()=>checkWriters(projectRoot),compress:(bundle,zip)=>compressBundle(projectRoot,bundle,zip)});console.log(JSON.stringify(result,null,2));return;
  }
  const bundle=value('--bundle');if(!bundle)throw Error('需要指定完整解压目录 --bundle');
  if(action==='verify'){const r=await verifyMigration(bundle);console.log(JSON.stringify({verified:true,identity:r.manifest.runtime.identity,files:r.files,versions:r.manifest.versions},null,2));return;}
  if(action==='restore'){console.log(JSON.stringify(await restoreMigration({bundle,target:value('--target'),install:installRestored,checkWriters:target=>checkWriters(target,projectRoot),onProgress:progress}),null,2));return;}
  throw Error('用法：migration.mjs pack | verify --bundle <目录> | restore --bundle <目录>');
}
if(pathToFileURL(path.resolve(process.argv[1]??'')).href===import.meta.url)main().catch(error=>{console.error(error.message);console.error('未强杀其他进程。打包成功后源实例保持停止；失败时请查看 Runtime-Status。恢复失败请保留原包并用同一包重试。');process.exitCode=1;});
