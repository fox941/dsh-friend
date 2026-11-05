import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {assertOffline,createSnapshot,verifySnapshot,hashFile,listDataFiles} from './archive.mjs';
import {acquireOfflineLease} from './protection-control.mjs';
import {acquireMigrationLock} from './migration-lock.mjs';
import {readJson,json,sha,slash,inside,noLinks,walk,inventory,verifyRecords,copyRecord,runtimeSummary,checkVersions} from './migration-files.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const rootFiles=new Set(['.gitignore','.npmrc','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','Setup.ps1','baseline.json','verification.json','plugin-candidates.json']);
const directories=new Set(['scripts','plugins','docs','tests','.tools']);
const bootstrapNames=new Set(['Restore-Migration.cmd','Verify-Migration.cmd','迁移说明.txt']);
export const nodeRelative='.tools/node-v24.22.1-win-x64/node.exe';
export async function programFiles(project){
  const out=[];for(const e of await fs.readdir(project,{withFileTypes:true})){
    if(e.isDirectory()&&directories.has(e.name))out.push(...(await walk(path.join(project,e.name))).map(n=>e.name+'/'+n));
    else if(e.isFile()&&(rootFiles.has(e.name)||/\.(cmd|md)$/i.test(e.name)))out.push(e.name);
    else if(e.isSymbolicLink()&&(directories.has(e.name)||rootFiles.has(e.name)))throw Error('程序目录不能是符号链接或联接');
  }return out.sort((a,b)=>a.localeCompare(b,'en'));
}
async function write(file,value){await noLinks(file);const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,json(value),{mode:0o600,flag:'wx'});await fs.rename(temp,file);}
function environment(){if(process.platform!=='win32'||process.arch!=='x64')throw Error('首版仅支持 Windows x64');if(process.version!=='v24.22.1')throw Error('请使用项目固定版 Node v24.22.1');}
async function transfer(source,target,records,onProgress=()=>{}){let n=0;for(const r of records){await copyRecord(source,target,r);if(++n%500===0)onProgress({stage:'copy',files:n,total:records.length});}}
export async function createMigration({project,destination,onProgress=()=>{},checkWriters=async()=>{},compress}){
  environment();project=path.resolve(project);destination=path.resolve(destination);const instance=path.join(project,'runtime/dev');await noLinks(project);await noLinks(destination);
  // Output may live in releases/, never inside code, tools or the live runtime.
  const relative=path.relative(project,destination),within=relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);if(destination.toLowerCase()===project.toLowerCase()||within&&relative.split(path.sep)[0].toLowerCase()!=='releases')throw Error('项目内部只允许输出到 releases，不能写入程序或运行数据目录');
  const restoreStateFile=path.join(project,'.migration-restore.json');await noLinks(restoreStateFile);const restoreState=await readJson(restoreStateFile).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(restoreState&&restoreState.phase!=='ready')throw Error('本实例恢复尚未完成，请用原包继续恢复，不能重新打包');
  await assertOffline(instance);await checkWriters();
  const lock=await acquireMigrationLock(project,'pack');let lease;
  try{
    lease=await acquireOfflineLease(instance);await lease.assertOffline();
    const versions=await checkVersions(project,instance),summary=await runtimeSummary(instance),id=crypto.randomUUID();
    onProgress({stage:'inventory'});const originals=await inventory(project,await programFiles(project));
    await fs.mkdir(destination,{recursive:true});const name='ai-friend-migration-'+new Date().toISOString().replaceAll(':','-').replaceAll('.','-')+'-'+id.slice(0,8),bundle=path.join(destination,name+'.incomplete');await fs.mkdir(bundle);
    await fs.mkdir(path.join(bundle,'project'));await transfer(project,path.join(bundle,'project'),originals,onProgress);
    onProgress({stage:'snapshot'});await createSnapshot(instance,path.join(bundle,'snapshot'),{assertSourceOffline:lease.assertOffline,metadataProjectRoot:project});
    const snapshotManifest=await readJson(path.join(bundle,'snapshot/manifest.json'));
    const verifySource=async()=>{await verifyRecords(project,originals);if(!same((await programFiles(project)).sort(),originals.map(r=>r.path).sort()))throw Error('打包期间程序文件清单变化');await verifyRecords(instance,snapshotManifest.files);if(!same((await listDataFiles(instance)).map(slash).sort(),snapshotManifest.files.map(r=>r.path).sort()))throw Error('打包期间运行文件清单变化');await lease.assertOffline();await lock.check();await checkWriters();};
    for(const action of ['Restore','Verify'])await fs.writeFile(path.join(bundle,action+'-Migration.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0project\\scripts\\Migration.ps1" -Action '+action+' -BundleRoot "%~dp0."\r\npause\r\n');
    await fs.writeFile(path.join(bundle,'迁移说明.txt'),'这是完整角色迁移包，包含私人聊天、密钥及平台凭据，请私下传输。\r\n解压整个 ZIP 后，运行 Verify-Migration.cmd 校验，运行 Restore-Migration.cmd 恢复。\r\n恢复入口只支持原 Windows x64 路径 '+project+'，拒绝覆盖已有角色；恢复和依赖安装完成后保持停止，不自动登录或发送。\r\n请在家用电脑安装 QQ，再使用原 AI 账号扫码，运行 Start-Dev.cmd。公司旧实例应保持停止。\r\n失败后保留原包，使用相同包重试；不要删除人格和检查点。\r\n');
    const records=await inventory(bundle),manifest={schema:'ai-friend/migration/1',id,createdAt:new Date().toISOString(),platform:'win32',arch:'x64',projectRoot:project,instanceRelative:'runtime/dev',versions,runtime:summary,containsPrivateData:true,files:records};
    await write(path.join(bundle,'migration.json'),manifest);await verifyMigration(bundle);
    // A whole-source check catches changes after a particular file has been copied.
    await verifySource();
    if(!same(await runtimeSummary(path.join(bundle,'snapshot/runtime')),summary))throw Error('快照原身份或数据库清单不一致');
    let zip=null,zipSha256=null;
    if(compress){onProgress({stage:'compress'});zip=path.join(destination,name+'.zip.partial');await compress(bundle,zip);zipSha256=await hashFile(zip);await verifySource();await verifyMigration(bundle);}
    const complete=path.join(destination,name);await fs.rename(bundle,complete);
    if(zip){const finalZip=path.join(destination,name+'.zip');await fs.rename(zip,finalZip);zip=finalZip;await fs.writeFile(zip+'.sha256',zipSha256+'  '+path.basename(zip)+'\r\n',{flag:'wx'});}
    return {schema:'ai-friend/migration-created/1',bundle:complete,zip,zipSha256,identity:summary.identity,files:records.length,bytes:records.reduce((n,r)=>n+r.bytes,0),sourceRemainsStopped:true};
  }finally{if(lease)await lease.close();await lock.close();}
}
export async function verifyMigration(bundle){
  bundle=path.resolve(bundle);await noLinks(bundle);const manifestFile=path.join(bundle,'migration.json');await noLinks(manifestFile);const s=await fs.stat(manifestFile);if(s.size>64*1024*1024)throw Error('迁移清单过大');const raw=await fs.readFile(manifestFile),m=JSON.parse(raw);
  if(m.schema!=='ai-friend/migration/1'||!/^[-a-f0-9]{36}$/i.test(m.id)||m.platform!=='win32'||m.arch!=='x64'||m.instanceRelative!=='runtime/dev'||typeof m.projectRoot!=='string'||!path.isAbsolute(m.projectRoot)||path.dirname(m.projectRoot)===m.projectRoot||!m.runtime?.identity)throw Error('迁移清单版本或目标配置无效');
  await verifyRecords(bundle,m.files);
  for(const r of m.files)if(!r.path.startsWith('project/')&&!r.path.startsWith('snapshot/')&&!bootstrapNames.has(r.path))throw Error('迁移清单包含未知内容');
  for(const r of m.files.filter(r=>r.path.startsWith('project/'))){const name=r.path.slice(8);if(!directories.has(name.split('/')[0])&&!rootFiles.has(name)&&!(/^[^/]+\.(cmd|md)$/i.test(name)))throw Error('迁移包程序区包含不允许的内容');}
  const actual=(await walk(bundle)).filter(n=>n!=='migration.json').sort(),expected=m.files.map(r=>r.path).sort();if(!same(actual,expected))throw Error('迁移包包含未列入清单的文件或缺失内容');
  await verifySnapshot(path.join(bundle,'snapshot'));const snapshot=await readJson(path.join(bundle,'snapshot/manifest.json'));
  const expectedSnapshot=snapshot.files.map(r=>'snapshot/runtime/'+r.path).sort(),actualSnapshot=m.files.filter(r=>r.path.startsWith('snapshot/runtime/')).map(r=>r.path).sort();if(!same(expectedSnapshot,actualSnapshot))throw Error('快照和迁移清单不一致');
  if(!same(await runtimeSummary(path.join(bundle,'snapshot/runtime')),m.runtime))throw Error('原身份或数据库完整性不匹配');
  const versions=await checkVersionsForBundle(bundle,m);if(!same(versions,m.versions))throw Error('迁移包的版本信息不匹配');
  return {manifest:m,digest:sha(raw),verified:true,files:m.files.length};
}
async function checkVersionsForBundle(bundle,m){
  // Bootstrap absolute paths belong to the future original root, not the unpack directory.
  const project=path.join(bundle,'project'),instance=path.join(bundle,'snapshot/runtime'),bootstrap=await readJson(path.join(instance,'bootstrap.json'));
  if(path.resolve(bootstrap.configuredRoot).toLowerCase()!==path.resolve(m.projectRoot,'runtime/dev').toLowerCase())throw Error('快照原路径不符');
  // Reuse strict package/artifact checks through a temporary metadata-independent reader.
  const pkg=await readJson(path.join(project,'package.json')),plugins={};
  const {treeDigest}=await import('./migration-files.mjs');
  const adapterPeer=await readJson(path.join(project,'plugins/companion-adapter/package.json'));
  for(const name of ['companion-adapter','attention-scheduler',...(adapterPeer.peerDependencies?.['@ai-friend/qq-bridge']?['qq-bridge']:[]),...(adapterPeer.peerDependencies?.['@ai-friend/bilibili-tool']?['bilibili-tool']:[])]){const p=await readJson(path.join(project,'plugins',name,'package.json')),dir=path.join(instance,'dsh-home/profiles/web/.friend-packages'),r=await readJson(path.join(dir,(name==='companion-adapter'?'adapter':name==='qq-bridge'?'qq-bridge':name==='bilibili-tool'?'bilibili-tool':'scheduler')+'-install.json'));if(p.version!==r.version||r.sourceDigest!==await treeDigest(path.join(project,'plugins',name))||!/^[-a-zA-Z0-9_.]+\.tgz$/.test(r.artifact)||await hashFile(path.join(dir,r.artifact))!==r.sha256)throw Error('插件源码与安装包不匹配');const profile=await readJson(path.join(instance,'dsh-home/profiles/web/package.json'));if(profile.dependencies?.[p.name]!=='file:.friend-packages/'+r.artifact)throw Error('插件相对安装路径不符');plugins[name]=p.version;}
  for(const file of ['pnpm-lock.yaml','pnpm-workspace.yaml','Setup.ps1',nodeRelative,'.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs','.tools/mnemon-0.2.13/mnemon.exe'])await fs.access(path.join(project,file));
  return {node:'v24.22.1',packageManager:pkg.packageManager,dependencies:pkg.dependencies,plugins};
}
function targetRecords(m){return m.files.filter(r=>r.path.startsWith('project/')||r.path.startsWith('snapshot/runtime/')).map(r=>({...r,path:r.path.startsWith('project/')?r.path.slice(8):'runtime/dev/'+r.path.slice(17),source:r.path}));}
function protectedRecords(records){return records.filter(r=>!r.path.startsWith('runtime/dev/')||!/^runtime\/dev\/(?:logs\/|dsh-home\/profiles\/web\/(?:node_modules\/|package.json$|pnpm-lock.yaml$))/.test(r.path));}
export async function restoreMigration({bundle,target,install,checkWriters=async()=>{},onProgress=()=>{}}){
  environment();const verified=await verifyMigration(bundle),m=verified.manifest;target=path.resolve(target??m.projectRoot);bundle=path.resolve(bundle);await noLinks(target);
  if(target.toLowerCase()!==path.resolve(m.projectRoot).toLowerCase())throw Error('首版只恢复到原安装路径 '+m.projectRoot);
  if(bundle.toLowerCase()===target.toLowerCase()||bundle.toLowerCase().startsWith(target.toLowerCase()+path.sep))throw Error('请将迁移包解压在目标目录之外');
  const exists=await fs.stat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});let state=null;
  if(exists){if(!exists.isDirectory())throw Error('目标不是目录');const entries=await fs.readdir(target);if(entries.length){await noLinks(path.join(target,'.migration-restore.json'));state=await readJson(path.join(target,'.migration-restore.json')).catch(()=>null);if(state?.schema!=='ai-friend/migration-restore/1'||state.digest!==verified.digest||state.id!==m.id||state.identity!==m.runtime.identity)throw Error('目标已有文件或其他角色；只允许空目录或同一个包的未完成恢复');}}
  else{await fs.mkdir(path.dirname(target),{recursive:true});await noLinks(path.dirname(target));await fs.mkdir(target);}
  const lock=await acquireMigrationLock(target,'restore'),stateFile=path.join(target,'.migration-restore.json'),records=targetRecords(m);
  const save=async phase=>{state={schema:'ai-friend/migration-restore/1',id:m.id,digest:verified.digest,identity:m.runtime.identity,target,phase,updatedAt:new Date().toISOString()};await write(stateFile,state);};
  try{
    const instance=path.join(target,'runtime/dev');await assertOffline(instance);await checkWriters(target);
    if(state?.phase==='ready'){
      if(!same(await runtimeSummary(instance),m.runtime))throw Error('已恢复实例已发生变化，不自动覆盖；请使用新快照');
      await verifyRecords(target,protectedRecords(records));return {restored:true,alreadyReady:true,target,identity:m.runtime.identity,started:false};
    }
    await save('copying');let n=0;
    for(const r of records){
      // The durable bundle ID permits cleanup of only this copy's abandoned temp file.
      await copyRecord(bundle,target,r,{sourcePath:r.source,temporaryId:m.id});
      if(++n%500===0)onProgress({stage:'restore',files:n,total:records.length});
    }
    await verifyRecords(target,records);if(!same(await runtimeSummary(instance),m.runtime))throw Error('恢复后的原身份或数据表不一致');await save('copied');
    if(!install)return {restored:true,installed:false,target,identity:m.runtime.identity,started:false,needsInstall:true};
    onProgress({stage:'install'});await save('installing');await install(target);await lock.check();
    await verifyRecords(target,protectedRecords(records));if(!same(await runtimeSummary(instance),m.runtime))throw Error('安装改变了角色数据，保持停止，请检查');
    if(!same(await checkVersions(target,instance),m.versions))throw Error('安装版本不匹配');await save('ready');
    return {restored:true,installed:true,target,identity:m.runtime.identity,started:false,manualLoginMayBeRequired:true};
  }catch(error){if(state)await save(state.phase==='copying'?'copy_failed':'install_failed').catch(()=>{});throw error;}
  finally{await lock.close();}
}
