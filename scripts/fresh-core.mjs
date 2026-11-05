import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {codeFiles,codePath} from './update-package.mjs';
import {readJson,json,sha,portable,inside,noLinks,walk,inventory,verifyRecords,copyRecord} from './migration-files.mjs';
import {hashFile} from './archive.mjs';
const tools=new Set(['node-v24.22.1-win-x64','package-manager','mnemon-0.2.13','napcat-v4.18.41','video','voice']);
const engineRoots=new Set(['native','node_modules','static','worker']);
const engineFiles=new Set(['napcat.mjs','loadNapCat.js','qqnt.json','package.json','NapCatWinBootMain.exe','NapCatWinBootHook.dll','conout-wiJ7YKRd.js','KillQQ.bat','launcher-elevate.ps1','launcher-user.bat','launcher-win10-user.bat','launcher-win10.bat','launcher.bat','quickLoginExample.bat']);
const launchers=new Set(['Install-Fresh.cmd','Verify-Fresh.cmd','空白部署说明.txt']);
const cleanNpmrc='registry=https://registry.npmjs.org\n';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exists=async file=>fs.lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
// A dependency may have a source directory named lib/cache. Only top-level tool
// runtime caches are data; do not remove executable dependency source folders.
const blockedToolParts=parts=>parts.some(p=>['.git','.cache','__pycache__'].includes(p))||['logs','cache'].includes(parts[2]);
function environment(){if(process.platform!=='win32'||process.arch!=='x64'||process.version!=='v24.22.1')throw Error('空白部署使用 Windows x64 与项目 Node v24.22.1');}
export function cleanToolPath(name){
 portable(name);const parts=name.split('/');if(parts[0]!=='.tools'||!tools.has(parts[1]))return false;
 if(blockedToolParts(parts)||parts.some(p=>/^\.env(?:\.|$)/i.test(p)||/^(?:credentials|web-session|config|launcher)\.local\./i.test(p)))return false;
 if(/\.(?:db|sqlite|sqlite3|log|wal|shm|tmp)(?:-(?:wal|shm))?$/i.test(name)||/\.(?:db|sqlite|sqlite3)-(?:wal|shm)$/i.test(name))return false;
 if(parts[1]==='napcat-v4.18.41'&&!engineRoots.has(parts[2])&&!(parts.length===3&&engineFiles.has(parts[2])))return false;
 return true;
}
export async function freshFiles(project){
 const names=await codeFiles(project);
 for(const tool of tools){const root=path.join(project,'.tools',tool);if(!await exists(root))continue;await noLinks(root);
  const files=await walk(root,{exclude:(n,e)=>{const rel='.tools/'+tool+'/'+n;return e.isDirectory()?blockedToolParts(rel.split('/'))||tool==='napcat-v4.18.41'&&!engineRoots.has(n.split('/')[0]):!cleanToolPath(rel);}});
  names.push(...files.map(n=>'.tools/'+tool+'/'+n));
 }
 return names.sort();
}
async function write(file,value){await noLinks(file);await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,json(value),{flag:'wx',mode:0o600});await fs.rename(temp,file);}
export async function verifyFresh(bundle){
 bundle=path.resolve(bundle);await noLinks(bundle);const manifestFile=path.join(bundle,'fresh.json'),stat=await fs.stat(manifestFile);if(stat.size>64*1024*1024)throw Error('空白部署清单过大');
 const bytes=await fs.readFile(manifestFile),m=JSON.parse(bytes);
 if(m.schema!=='ai-friend/fresh/1'||!/^[-a-f0-9]{36}$/i.test(m.id)||m.platform!=='win32'||m.arch!=='x64'||m.node!=='v24.22.1'||m.containsRuntime!==false||m.containsCredentials!==false||m.newIdentityOnTarget!==true||'runtime' in m||'identity' in m)throw Error('这不是空白部署包；不能用完整角色迁移包代替');
 await verifyRecords(bundle,m.files);
 for(const r of m.files){if(launchers.has(r.path))continue;if(!r.path.startsWith('project/'))throw Error('空白包包含非程序内容');const rel=r.path.slice(8);if(rel==='.npmrc'){if(await fs.readFile(inside(bundle,r.path),'utf8')!==cleanNpmrc)throw Error('空白包只允许无认证信息的公共依赖源设置');}else if(rel.startsWith('.tools/')){if(!cleanToolPath(rel))throw Error('空白包包含工具运行数据');}else codePath(rel);}
 const listed=m.files.map(r=>r.path).sort(),actual=(await walk(bundle)).filter(n=>n!=='fresh.json').sort();if(!same(listed,actual))throw Error('空白包存在额外文件或缺失文件');
 for(const rel of ['.tools/node-v24.22.1-win-x64/node.exe','.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs','.tools/mnemon-0.2.13/mnemon.exe','Setup.ps1','scripts/fresh.mjs','scripts/fresh-initialize.mjs'])if(!listed.includes('project/'+rel))throw Error('空白部署包缺少必要工具或入口：'+rel);
 return {manifest:m,digest:sha(bytes),files:listed.length};
}
export async function createFresh({project,destination,compress,onProgress=()=>{}}){
 environment();project=path.resolve(project);destination=path.resolve(destination);await noLinks(project);await noLinks(destination);
 const rel=path.relative(project,destination);if(!rel||!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)&&rel.split(path.sep)[0].toLowerCase()!=='releases')throw Error('项目内只允许将部署包输出到 releases');
 const originals=await inventory(project,await freshFiles(project));
 for(const r of originals.filter(r=>!r.path.startsWith('.tools/')))if(/sk-[a-zA-Z0-9]{24,}/.test((await fs.readFile(inside(project,r.path))).toString()))throw Error('程序文件含疑似模型密钥，未发布：'+r.path);
 const id=crypto.randomUUID(),name='ai-friend-fresh-'+new Date().toISOString().replaceAll(':','-').replaceAll('.','-')+'-'+id.slice(0,8),bundle=path.join(destination,name+'.incomplete');await fs.mkdir(bundle,{recursive:true});
 let copied=0;for(const r of originals){await copyRecord(project,path.join(bundle,'project'),r);if(++copied%500===0)onProgress({stage:'copy',files:copied,total:originals.length});}
 await fs.writeFile(path.join(bundle,'project/.npmrc'),cleanNpmrc,{flag:'wx'});
 for(const action of ['Install','Verify'])await fs.writeFile(path.join(bundle,action+'-Fresh.cmd'),'@echo off\r\nset "AI_FRIEND_INSTANCE=main"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0project\\scripts\\Fresh.ps1" -Action '+action+' -BundleRoot "%~dp0."\r\npause\r\n');
 await fs.writeFile(path.join(bundle,'空白部署说明.txt'),'这是程序与工具包，不包含原角色的记忆、画像、性格、情绪、聊天、任务或登录凭据。\r\n完整解压到目标目录之外，先运行 Verify-Fresh.cmd，再运行 Install-Fresh.cmd，默认安装到 D:\\ai friend。目标必须为空。\r\n完成后使用目标项目的 Configure-Model.cmd 设置密钥，按需重新配置QQ/B站；首次启动为全新角色。\r\n旧角色迁移请用原 Pack-Migration，切勿混用。\r\n');
 const plugins={};for(const n of ['companion-adapter','attention-scheduler','qq-bridge','bilibili-tool','activity-console']){const p=await readJson(path.join(project,'plugins',n,'package.json'));plugins[n]=p.version;}
 const files=await inventory(bundle),manifest={schema:'ai-friend/fresh/1',id,createdAt:new Date().toISOString(),platform:'win32',arch:'x64',node:'v24.22.1',containsRuntime:false,containsCredentials:false,newIdentityOnTarget:true,plugins,files};await write(path.join(bundle,'fresh.json'),manifest);await verifyFresh(bundle);
 const unchanged=async()=>{await verifyRecords(project,originals);if(!same(await freshFiles(project),originals.map(r=>r.path)))throw Error('打包期间程序或工具清单发生变化，未发布');};await unchanged();
 let zip=null;if(compress){onProgress({stage:'compress'});zip=path.join(destination,name+'.zip.partial');await compress(bundle,zip);await unchanged();await verifyFresh(bundle);}
 const complete=path.join(destination,name);await fs.rename(bundle,complete);let zipSha256=null;if(zip){const final=path.join(destination,name+'.zip');await fs.rename(zip,final);zip=final;zipSha256=await hashFile(zip);await fs.writeFile(zip+'.sha256',zipSha256+'  '+path.basename(zip)+'\r\n',{flag:'wx'});}
 return {bundle:complete,zip,zipSha256,containsRuntime:false,containsCredentials:false,newIdentityOnTarget:true,files:files.length,sourceNotStopped:true};
}
export async function installFresh({bundle,target,install,onProgress=()=>{}}){
 environment();bundle=path.resolve(bundle);target=path.resolve(target);await noLinks(target);if(path.dirname(target)===target)throw Error('目标不能是磁盘根目录');
 if(target.toLowerCase()===bundle.toLowerCase()||target.toLowerCase().startsWith(bundle.toLowerCase()+path.sep)||bundle.toLowerCase().startsWith(target.toLowerCase()+path.sep))throw Error('请把部署包解压到目标目录之外');
 const v=await verifyFresh(bundle),m=v.manifest,file=path.join(target,'.fresh-install.json');let state=null;
 if(await exists(target)){if(!(await fs.stat(target)).isDirectory())throw Error('安装目标不是目录');if((await fs.readdir(target)).length){state=await readJson(file).catch(()=>null);if(state?.schema!=='ai-friend/fresh-install/1'||state.id!==m.id||state.digest!==v.digest||state.target!==target)throw Error('目标已有项目或角色，拒绝清空和覆盖；请选择空目录');}}
 else{await fs.mkdir(target,{recursive:true});await noLinks(target);}
 if(state?.phase==='ready')return {installed:true,alreadyReady:true,target,identity:state.identity,started:false};
 const lockFile=path.join(target,'.fresh.lock');await noLinks(lockFile);
 if(await exists(lockFile)){
  const prior=await readJson(lockFile);if(prior.id!==m.id||!Number.isSafeInteger(prior.pid)||prior.pid<1)throw Error('空白安装锁归属不明，保留现场');
  try{process.kill(prior.pid,0);throw Error('另一次空白安装仍在执行，请等待原安装窗口');}catch(e){if(e.code!=='ESRCH')throw e;}
  await fs.unlink(lockFile);
 }
 const lock=await fs.open(lockFile,'wx');await lock.writeFile(json({id:m.id,pid:process.pid}));
 const save=async phase=>{state={...state,schema:'ai-friend/fresh-install/1',id:m.id,digest:v.digest,target,phase,updatedAt:new Date().toISOString()};await write(file,state);};
 try{
  await save('copying');for(const r of m.files.filter(r=>r.path.startsWith('project/'))){await copyRecord(bundle,target,{...r,path:r.path.slice(8)},{sourcePath:r.path,temporaryId:m.id});}
  onProgress({stage:'install'});await save('installing');if(!install)throw Error('缺少初始化执行器，未标记安装完成');
  const result=await install(target,{id:m.id,retry:state.identity??null});if(!/^[a-f0-9-]{36}$/i.test(result?.identity??''))throw Error('目标没有生成可核验的新角色身份');
  state.identity=result.identity;await save('ready');return {installed:true,target,identity:state.identity,blankAtInitialization:true,started:false,requiresModelAndPlatformConfiguration:true};
 }catch(error){if(state)await save('install_failed').catch(()=>{});throw error;}
 finally{await lock.close();await fs.unlink(lockFile);}
}
