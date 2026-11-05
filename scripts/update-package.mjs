import {qqHelperSource} from './qq-helper-source.mjs';
import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
import {readJson,json,sha,portable,inside,noLinks,walk,inventory,verifyRecords,treeDigest} from './migration-files.mjs';
import {hashFile} from './archive.mjs';
export const UPDATE_VERSION='1.0.0';
export const CODE_DIRS=new Set(['scripts','plugins','docs','tests']);
const roots=new Set(['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','Setup.ps1','.gitignore']);
export function codePath(name){portable(name);const pieces=name.split('/');if(pieces.some(p=>p==='node_modules'||p==='.git'||p==='.env'||p.startsWith('.env.')&&p!=='.env.example'||/^(?:credentials|web-session|config)\.local\./i.test(p)||/\.(?:log|sqlite|db|tmp|tgz|zip)$/i.test(p)))throw Error('更新包不能携带数据、凭据、缓存或依赖目录');if(!CODE_DIRS.has(pieces[0])&&!(pieces.length===1&&(roots.has(name)||/\.(?:cmd|md)$/i.test(name))))throw Error('更新文件不在程序白名单');return name;}
export async function codeFiles(project){
  await noLinks(project);const out=[];for(const e of await fs.readdir(project,{withFileTypes:true})){if(CODE_DIRS.has(e.name)){if(e.isSymbolicLink())throw Error('程序源码不能经过联接');if(!e.isDirectory())throw Error('程序目录异常');for(const name of await walk(path.join(project,e.name),{exclude:(n)=>n.split('/').some(p=>p==='node_modules'||p==='.git')||/\.update-[a-f0-9-]{36}\.tmp$/.test(n)}))out.push(codePath(e.name+'/'+name));}else if(e.isFile()&&(roots.has(e.name)||/\.(?:cmd|md)$/i.test(e.name)))out.push(codePath(e.name));}return out.sort();
}
export async function schemaSources(directory){
  const out=[];for(const name of await walk(directory)){if(!name.endsWith('.js'))continue;const bytes=await fs.readFile(inside(directory,name));if(/CREATE\s+TABLE|ALTER\s+TABLE|user_version/i.test(bytes.toString()))out.push({path:name,sha256:sha(bytes)});}return out;
}
// Plugin splits preserve SQL-bearing modules at their new canonical paths.
// Every known location is checked so splitting code never bypasses the storage gate.
async function combinedStorage(...directories){const merged=[];for(const directory of directories){const sources=await fs.stat(directory).then(()=>schemaSources(directory),e=>{if(e.code==='ENOENT')return[];throw e;});merged.push(...sources);}if(new Set(merged.map(r=>r.path)).size!==merged.length)throw Error('存储模块路径冲突');return merged.sort((x,y)=>x.path.localeCompare(y.path,'en'));}
export async function packagePolicy(project){
 const pkg=await readJson(path.join(project,'package.json'));if(pkg.updateToolVersion!==UPDATE_VERSION)throw Error('需要已安装的升级工具 1.0.0');
 for(const file of ['scripts/host.mjs','scripts/runtime.mjs'])if(!(await fs.readFile(path.join(project,file),'utf8')).includes('assertNoUpdate'))throw Error('更新包缺少启动保护');
 return {node:'v24.22.1',platform:'win32',arch:'x64',dependencies:pkg.dependencies,devDependencies:pkg.devDependencies,packageManager:pkg.packageManager,rootLock:await hashFile(path.join(project,'pnpm-lock.yaml')),workspace:await hashFile(path.join(project,'pnpm-workspace.yaml')),qqHelper:await qqHelperSource(project).then(async source=>source?{digest:await treeDigest(source)}:null),storageSources:await combinedStorage(path.join(project,'plugins/companion-adapter/src'),path.join(project,'plugins/qq-bridge/src'),path.join(project,'plugins/bilibili-tool/src'))};
}
export async function validateCompatibility(project,manifest){
 const local=await packagePolicy(project),incoming=manifest.policy;
 for(const key of ['node','platform','arch','dependencies','devDependencies','packageManager','rootLock','workspace','qqHelper'])if(JSON.stringify(local[key])!==JSON.stringify(incoming[key]))throw Error('基础依赖或工具链变化，首版普通升级不负责该项迁移：'+key);
 const installed=path.join(project,'runtime/dev/dsh-home/profiles/web/node_modules/@ai-friend/companion-adapter/src');
 const storage=await combinedStorage(installed,path.join(installed,'../../qq-bridge/src'),path.join(installed,'../../bilibili-tool/src'));if(JSON.stringify(storage)!==JSON.stringify(incoming.storageSources))throw Error('存储实现有变化，需要专门的数据兼容评估与迁移，未升级');
}
export const profileCode=name=>['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'].includes(name)||/^\.friend-packages\/(?:[-a-zA-Z0-9_.]+\.tgz|(?:adapter|scheduler|qq-bridge|bilibili-tool|activity-console)-install\.json)$/.test(name);
export async function verifyUpdate(bundle){
 bundle=path.resolve(bundle);await noLinks(bundle);const manifestFile=path.join(bundle,'update.json');await noLinks(manifestFile);if((await fs.stat(manifestFile)).size>16*1024*1024)throw Error('更新清单过大');const raw=await fs.readFile(manifestFile),m=JSON.parse(raw);
 if(m.schema!=='ai-friend/code-update/1'||m.toolVersion!==UPDATE_VERSION||!/^[-a-f0-9]{36}$/.test(m.id)||m.containsRuntime!==false||!Array.isArray(m.files)||!m.policy)throw Error('未知更新包格式');
 for(const r of m.files){if(r.path.startsWith('project/'))codePath(r.path.slice(8));else if(!r.path.startsWith('profile/')||!profileCode(r.path.slice(8)))throw Error('更新包含不允许的文件');}
 await verifyRecords(bundle,m.files);const actual=(await walk(bundle)).filter(n=>n!=='update.json').sort();if(JSON.stringify(actual)!==JSON.stringify(m.files.map(r=>r.path).sort()))throw Error('更新包含未列入清单或缺失的文件');
 const actualPolicy=await packagePolicy(bundle+'/project');const declaredPolicy={...m.policy,...m.policy.qqHelper===undefined?{qqHelper:null}:{}};if(JSON.stringify({...actualPolicy,qqHelper:undefined})!==JSON.stringify({...declaredPolicy,qqHelper:undefined})||JSON.stringify(actualPolicy.qqHelper)!==JSON.stringify(declaredPolicy.qqHelper))throw Error('更新包版本策略与源码不一致');
 const sourceAdapter=await readJson(bundle+'/project/plugins/companion-adapter/package.json'),hasBridge=Boolean(sourceAdapter.peerDependencies?.['@ai-friend/qq-bridge']),hasTool=Boolean(sourceAdapter.peerDependencies?.['@ai-friend/bilibili-tool']);const profile=await readJson(bundle+'/profile/package.json'),expected=['@ai-friend/attention-scheduler','@ai-friend/companion-adapter','dsh-mnemon',...(hasBridge?['@ai-friend/qq-bridge']:[]),...(hasTool?['@ai-friend/bilibili-tool']:[]),...(sourceAdapter.peerDependencies?.['@ai-friend/activity-console']?['@ai-friend/activity-console']:[])];if(Object.keys(profile.dependencies??{}).length!==expected.length||expected.some(n=>!profile.dependencies[n])||profile.dependencies['dsh-mnemon']!=='0.5.36')throw Error('更新profile依赖范围异常');
 for(const n of ['companion-adapter','attention-scheduler',...(hasBridge?['qq-bridge']:[]),...(hasTool?['bilibili-tool']:[]),...(sourceAdapter.peerDependencies?.['@ai-friend/activity-console']?['activity-console']:[])]){const source=bundle+'/project/plugins/'+n,p=await readJson(source+'/package.json'),r=await readJson(bundle+'/profile/.friend-packages/'+(n==='companion-adapter'?'adapter':n==='qq-bridge'?'qq-bridge':n==='bilibili-tool'?'bilibili-tool':n==='activity-console'?'activity-console':'scheduler')+'-install.json');if(typeof r.artifact!=='string'||!/^[-a-zA-Z0-9_.]+\.tgz$/.test(r.artifact)||r.version!==p.version||r.sourceDigest!==await treeDigest(source)||profile.dependencies[p.name]!=='file:.friend-packages/'+r.artifact||await hashFile(bundle+'/profile/.friend-packages/'+r.artifact)!==r.sha256)throw Error('更新插件源码与安装包不一致');}
 return {manifest:m,digest:sha(raw),bundle};
}
export async function createUpdate({project,destination,buildProfile,compress}){
 const policy=await packagePolicy(project);destination=path.resolve(destination);await noLinks(destination);if(destination.toLowerCase()===path.resolve(project).toLowerCase()||destination.toLowerCase().startsWith(path.resolve(project).toLowerCase()+path.sep)&&!destination.toLowerCase().startsWith(path.resolve(project,'releases').toLowerCase()+path.sep))throw Error('项目内更新包只能写入 releases');
 const names=await codeFiles(project),originals=await inventory(project,names),id=crypto.randomUUID(),base='ai-friend-update-'+id,bundle=path.join(destination,base+'.incomplete');await fs.mkdir(bundle,{recursive:true});
 for(const r of originals){const bytes=await fs.readFile(inside(project,r.path));if(/sk-[a-zA-Z0-9]{24,}/.test(bytes.toString()))throw Error('源码中发现疑似模型密钥，未发布更新包：'+r.path);const target=inside(bundle,'project/'+r.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
 await buildProfile(path.join(bundle,'profile'));const files=await inventory(bundle),manifest={schema:'ai-friend/code-update/1',toolVersion:UPDATE_VERSION,id,createdAt:new Date().toISOString(),containsRuntime:false,policy,files};await fs.writeFile(bundle+'/update.json',json(manifest));await verifyUpdate(bundle);await verifyRecords(project,originals);if(JSON.stringify(await codeFiles(project))!==JSON.stringify(names))throw Error('打包期间源码文件清单变化');
 let zip=null;if(compress){zip=path.join(destination,base+'.zip.partial');await compress(bundle,zip);await verifyUpdate(bundle);await verifyRecords(project,originals);if(JSON.stringify(await codeFiles(project))!==JSON.stringify(names))throw Error('压缩期间源码文件清单变化');}
 const complete=path.join(destination,base);await fs.rename(bundle,complete);if(zip){const final=path.join(destination,base+'.zip');await fs.rename(zip,final);zip=final;await fs.writeFile(zip+'.sha256',(await hashFile(zip))+'  '+path.basename(zip)+'\r\n',{flag:'wx'});}
 return {bundle:complete,zip,id,containsRuntime:false,files:files.length};
}
