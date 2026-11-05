import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {hashFile,listDataFiles} from './archive.mjs';
export const readJson=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\ufeff/,''));
export const json=value=>JSON.stringify(value,null,2)+'\n';
export const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
export const slash=value=>value.split(path.sep).join('/');
export function portable(name){
  if(typeof name!=='string'||!name||name.length>2048||name.includes('\\')||/[\x00-\x1f\x7f:<>"|?*]/.test(name))throw Error('迁移文件路径无效');
  const parts=name.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))throw Error('迁移文件路径无效');
  return name;
}
export function inside(root,name){portable(name);const target=path.resolve(root,...name.split('/')),rel=path.relative(path.resolve(root),target);if(!rel||rel.startsWith('..'+path.sep)||rel==='..'||path.isAbsolute(rel))throw Error('迁移路径越界');return target;}
export async function noLinks(file){
  let current=path.resolve(file);while(true){try{const s=await fs.lstat(current);if(s.isSymbolicLink())throw Error('迁移路径不能经过符号链接或目录联接');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(current);if(parent===current)break;current=parent;}
}
export async function walk(root,{exclude=()=>false}={},rel=''){
  await noLinks(root);const out=[];
  for(const entry of(await fs.readdir(path.join(root,rel),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
    const name=slash(path.join(rel,entry.name));portable(name);if(exclude(name,entry))continue;
    if(entry.isSymbolicLink())throw Error('迁移不跟随符号链接或目录联接');
    if(entry.isDirectory())out.push(...await walk(root,{exclude},name));else if(entry.isFile())out.push(name);else throw Error('迁移仅支持普通文件和目录');
  }
  return out;
}
export async function inventory(root,names=undefined){
  const result=[];for(const name of names??await walk(root)){const file=inside(root,name);await noLinks(file);const s=await fs.stat(file);result.push({path:name,bytes:s.size,sha256:await hashFile(file)});}return result;
}
export async function verifyRecords(root,records){
  if(!Array.isArray(records)||records.length>200000)throw Error('迁移清单无效或过大');const names=new Set();
  for(const r of records){portable(r.path);const key=r.path.toLowerCase();if(names.has(key)||!Number.isSafeInteger(r.bytes)||r.bytes<0||!/^[a-f0-9]{64}$/.test(r.sha256))throw Error('迁移文件清单重复或无效');names.add(key);const file=inside(root,r.path);await noLinks(file);const s=await fs.lstat(file);if(!s.isFile()||s.size!==r.bytes||await hashFile(file)!==r.sha256)throw Error('迁移文件缺失或校验失败：'+r.path);}
  return records;
}
export async function copyRecord(sourceRoot,targetRoot,record,{sourcePath=record.path,temporaryId}={}){
  const source=inside(sourceRoot,sourcePath),target=inside(targetRoot,record.path);await noLinks(source);await noLinks(target);
  const existing=await fs.lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(existing){await verifyRecords(targetRoot,[record]);return;}
  await fs.mkdir(path.dirname(target),{recursive:true});await noLinks(path.dirname(target));
  if(temporaryId!==undefined&&!/^[a-f0-9-]{36}$/i.test(temporaryId))throw Error('复制恢复标记无效');
  const temp=target+'.migration-'+(temporaryId??crypto.randomUUID())+'.tmp';await noLinks(temp);
  if(temporaryId)await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});
  try{
    await fs.copyFile(source,temp,fs.constants.COPYFILE_EXCL);
    if((await fs.stat(temp)).size!==record.bytes||await hashFile(temp)!==record.sha256||await hashFile(source)!==record.sha256)throw Error('复制期间文件变化，未发布目标文件');
    if(await fs.lstat(target).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('恢复目标文件被其他进程创建，未覆盖');
    await fs.rename(temp,target);
  }catch(error){await fs.unlink(temp).catch(()=>{});throw error;}
}
export async function treeDigest(root){const h=crypto.createHash('sha256');for(const name of await walk(root)){h.update(name);h.update(await fs.readFile(inside(root,name)));}return h.digest('hex');}
export async function runtimeSummary(root){
  const companion=path.join(root,'companion/companion.sqlite'),db=new DatabaseSync(companion,{readOnly:true,timeout:1000});let identity;
  try{identity=db.prepare("SELECT value FROM growth_meta WHERE key='identity'").get()?.value;if(typeof identity!=='string'||!identity)throw Error('原角色身份缺失');}finally{db.close();}
  const control=await readJson(path.join(root,'operations/state.json'));
  if(control.identity!==identity||control.desiredRunning!==false)throw Error('请通过 Stop-Dev 完整停机并保留原运行保护身份');
  const databases=[];
  for(const name of(await listDataFiles(root)).map(slash).filter(n=>/\.(db|sqlite)$/i.test(n))){
    const file=inside(root,name),handle=await fs.open(file,'r'),header=Buffer.alloc(16);try{await handle.read(header,0,16,0);}finally{await handle.close();}if(header.toString()!=='SQLite format 3\0')continue;
    const db=new DatabaseSync(file,{readOnly:true,timeout:1000});try{
      if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('SQLite 完整性检查失败');
      const tables={};for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){const q='"'+row.name.replaceAll('"','""')+'"';tables[row.name]=db.prepare('SELECT count(*) n FROM '+q).get().n;}
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='protection_undos'").get()&&db.prepare("SELECT 1 FROM protection_undos WHERE status!='completed' LIMIT 1").get())throw Error('存在未完成的撤销，先完成维护再迁移');
      databases.push({path:name,tables});
    }finally{db.close();}
  }
  return {identity,databases};
}
export async function checkVersions(project,instance){
  const pkg=await readJson(path.join(project,'package.json')),bootstrap=await readJson(path.join(instance,'bootstrap.json'));
  if(path.resolve(bootstrap.configuredRoot).toLowerCase()!==path.resolve(instance).toLowerCase())throw Error('当前实例已偏离原配置路径，首版不自动重绑');
  const plugins={};for(const name of ['companion-adapter','attention-scheduler',...((await readJson(path.join(project,'plugins/companion-adapter/package.json'))).peerDependencies?.['@ai-friend/qq-bridge']?['qq-bridge']:[]),...((await readJson(path.join(project,'plugins/companion-adapter/package.json'))).peerDependencies?.['@ai-friend/activity-console']?['activity-console']:[])]){
    const source=path.join(project,'plugins',name),manifest=await readJson(path.join(source,'package.json')),recordName=name==='companion-adapter'?'adapter-install.json':name==='qq-bridge'?'qq-bridge-install.json':name==='activity-console'?'activity-console-install.json':'scheduler-install.json',artifacts=path.join(instance,'dsh-home/profiles/web/.friend-packages'),record=await readJson(path.join(artifacts,recordName));
    if(record.version!==manifest.version||record.sourceDigest!==await treeDigest(source)||!/^[-a-zA-Z0-9_.]+\.tgz$/.test(record.artifact)||await hashFile(path.join(artifacts,record.artifact))!==record.sha256)throw Error('源码、已安装插件和迁移快照版本不匹配');
    const profile=await readJson(path.join(instance,'dsh-home/profiles/web/package.json'));if(profile.dependencies?.[manifest.name]!=='file:.friend-packages/'+record.artifact)throw Error('插件包不是预期的相对路径安装');plugins[name]=manifest.version;
  }
  for(const file of ['pnpm-lock.yaml','pnpm-workspace.yaml','Setup.ps1','.tools/node-v24.22.1-win-x64/node.exe','.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs','.tools/mnemon-0.2.13/mnemon.exe'])await fs.access(path.join(project,file));
  return {node:'v24.22.1',packageManager:pkg.packageManager,dependencies:pkg.dependencies,plugins};
}
export async function checkInstalledPackages(project){
  const profile=path.resolve(project,'runtime/dev/dsh-home/profiles/web'),modules=path.join(profile,'node_modules');
  for(const name of ['companion-adapter','attention-scheduler',...((await readJson(path.join(project,'plugins/companion-adapter/package.json'))).peerDependencies?.['@ai-friend/qq-bridge']?['qq-bridge']:[]),...((await readJson(path.join(project,'plugins/companion-adapter/package.json'))).peerDependencies?.['@ai-friend/activity-console']?['activity-console']:[])]){
    const record=await readJson(path.join(profile,'.friend-packages',name==='companion-adapter'?'adapter-install.json':name==='qq-bridge'?'qq-bridge-install.json':name==='activity-console'?'activity-console-install.json':'scheduler-install.json'));
    const actual=await fs.realpath(path.join(modules,'@ai-friend',name));
    if(!actual.toLowerCase().startsWith(modules.toLowerCase()+path.sep)||await treeDigest(actual)!==record.sourceDigest)throw Error('恢复后的实际插件文件与原包不一致');
  }
  const pkg=await readJson(path.join(project,'package.json'));
  for(const name of ['@deepseek-ai/dsh','@mnemon-dev/mnemon']){const installed=await readJson(path.join(project,'node_modules',name,'package.json'));if(installed.version!==pkg.dependencies[name])throw Error('恢复后的基础依赖版本不一致');}
  return {installedPackagesVerified:true};
}
