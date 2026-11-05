import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createFresh,verifyFresh,installFresh} from './fresh-core.mjs';
import {runChild} from './migration.mjs';
import {projectRoot,requireInside} from './paths.mjs';
import {requireMain} from './instances.mjs';
import {readJson} from './migration-files.mjs';
import {assertOffline} from './archive.mjs';
async function main(){
 requireMain('空白部署');const [action,...args]=process.argv.slice(2),arg=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];},progress=v=>console.log(JSON.stringify(v));
 if(action==='pack'){console.log(JSON.stringify(await createFresh({project:projectRoot,destination:arg('--output')??path.join(projectRoot,'releases/fresh'),compress:(b,z)=>runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(projectRoot,'scripts/migration-zip.ps1'),'-BundleRoot',b,'-Destination',z,'-ManifestName','fresh.json'],{cwd:projectRoot,onLine:line=>{if(/^ZIP files: \d+\/\d+$/.test(line.trim()))console.log(line.trim());}}),onProgress:progress}),null,2));return;}
 if(action==='check-offline'){
  const state=await readJson(path.join(projectRoot,'.fresh-install.json'));if(state.phase!=='ready')throw Error('空白安装尚未完成');await assertOffline(path.join(projectRoot,'runtime/dev'));console.log('Fresh role is offline.');return;
 }
 const bundle=arg('--bundle');if(!bundle)throw Error('请指定完整解压的空白部署包 --bundle');
 if(action==='verify'){const v=await verifyFresh(bundle);console.log(JSON.stringify({verified:true,files:v.files,containsRuntime:false,containsCredentials:false,newIdentityOnTarget:true,plugins:v.manifest.plugins},null,2));return;}
 if(action==='install'){
  const target=arg('--target')??'D:\\ai friend';
  const r=await installFresh({bundle,target,onProgress:progress,install:async(project,{id})=>{
   const log=path.join(project,'.work/fresh-setup.log');requireInside(project,log);await fs.mkdir(path.dirname(log),{recursive:true});
   await runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(project,'Setup.ps1')],{cwd:project,log,timeoutMs:1800000});
   const resultFile=path.join(project,'.work/fresh-identity.json');
   // Run from the target project so all initialization uses the target code.
   await runChild(path.join(project,'.tools/node-v24.22.1-win-x64/node.exe'),[path.join(project,'scripts/fresh-finish.mjs'),id,resultFile],{cwd:project,log,timeoutMs:30000});
   return readJson(resultFile);
  }});console.log(JSON.stringify(r,null,2));return;
 }
 throw Error('用法：fresh.mjs pack | verify --bundle <目录> | install --bundle <目录> --target <空目录>');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(String(error.message??error).replace(/sk-[a-zA-Z0-9]+/g,'[redacted]').slice(0,600));console.error('空白部署未完成。请检查上方阶段及目标 .work/fresh-setup.log；未清空或覆盖已有角色。');process.exitCode=1;});
