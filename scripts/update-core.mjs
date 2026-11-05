import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
import {constants} from 'node:fs';
import {createSnapshot,verifySnapshot,listDataFiles,hashFile,assertOffline} from './archive.mjs';
import {readJson,sha,inside,noLinks,inventory,verifyRecords,walk} from './migration-files.mjs';
import {verifyUpdate,validateCompatibility,codeFiles,profileCode,codePath} from './update-package.mjs';
import {atomicJson,updateOperation,updatePending} from './update-lock.mjs';
import {acquireOfflineLease} from './protection-control.mjs';
import {assertNoMigration,acquireMigrationLock} from './migration-lock.mjs';
import {resolveInstance,identityAt} from './instances.mjs';
const exists=file=>fs.stat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const maybeJson=async file=>await exists(file)?readJson(file):null;
export const profileRoot=project=>path.join(project,'runtime/dev/dsh-home/profiles/web');
export async function profileFiles(profile){const names=[];for(const n of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])if(await exists(path.join(profile,n)))names.push(n);if(await exists(profile+'/.friend-packages'))for(const n of await walk(profile+'/.friend-packages')){const full='.friend-packages/'+n;if(profileCode(full))names.push(full);}return names.sort();}
const protectedName=name=>!name.startsWith('logs/')&&!name.startsWith('operations/')&&!/^dsh-home\/profiles\/web\/(?:cordis.yml$|package.json$|pnpm-lock.yaml$|pnpm-workspace.yaml$|\.friend-packages\/)/.test(name);
export async function dataFingerprint(root){return inventory(root,(await listDataFiles(root)).map(n=>n.split(path.sep).join('/')).filter(protectedName));}
export async function assertData(root,records){const now=await dataFingerprint(root);if(JSON.stringify(now)!==JSON.stringify(records))throw Error('角色数据已发生变化，不能用旧快照覆盖或自动回退；原数据保留');}
async function copyRecords(source,target,records){await verifyRecords(source,records);for(const r of records){const file=inside(target,r.path);await noLinks(file);await fs.mkdir(path.dirname(file),{recursive:true});await fs.copyFile(inside(source,r.path),file);}}
export async function switchFiles({target,source,before,after,fault=()=>{}}){
 const old=new Map(before.map(r=>[r.path,r])),next=new Map(after.map(r=>[r.path,r]));
 // Validate every planned target before the first mutation. A retry accepts only old/new hashes.
 for(const name of new Set([...old.keys(),...next.keys()])){const file=inside(target,name);await noLinks(file);const actual=await exists(file)?await hashFile(file):null;if(actual!==(old.get(name)?.sha256??null)&&actual!==(next.get(name)?.sha256??null))throw Error('目标程序或安装元数据已被另行修改，未覆盖：'+name);}
 await verifyRecords(source,after);
 for(const name of [...new Set([...old.keys(),...next.keys()])].sort()){
  const r=next.get(name),file=inside(target,name),actual=await exists(file)?await hashFile(file):null;
  const temp=r?file+'.update-'+r.sha256.slice(0,36)+'.tmp':null;if(temp){await noLinks(temp);if(await exists(temp))await fs.unlink(temp);}
  if(actual===(r?.sha256??null))continue;
  if(!r)await fs.unlink(file);else{await fs.mkdir(path.dirname(file),{recursive:true});await fs.copyFile(inside(source,name),temp,constants.COPYFILE_EXCL);if(await hashFile(temp)!==r.sha256)throw Error('更新文件复制失败');await fs.rename(temp,file);}await fault(name);
 }
}
const sameRecords=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function codeFingerprint(project){return inventory(project,await codeFiles(project));}
export async function savePreview({project,bundle,runPreview}){
 const lock=await updateOperation(project,'preview');try{await assertNoMigration(project);if(await exists(updatePending(project)))throw Error('先完成正在进行的升级或回退');const verified=await verifyUpdate(bundle);await validateCompatibility(project,verified.manifest);const before=await codeFingerprint(project);const result=await runPreview(verified);if(!result.passed||!result.regressionPassed||!result.realModel||!result.isolationActive||result.externalMessagesSent)throw Error('独立测试环境尚未通过验证');if(!sameRecords(before,await codeFingerprint(project)))throw Error('预览期间本地源码变化，请重新预览');
  const receipt={schema:'ai-friend/update-preview/1',project:path.resolve(project),digest:verified.digest,releaseId:verified.manifest.id,completedAt:new Date().toISOString(),baseCode:before,result};await atomicJson(path.join(project,'.work/update-previews',verified.manifest.id+'.json'),receipt);return {verified:true,previewPassed:true,id:verified.manifest.id,mainDataChanged:false,candidate:result.candidate};
 }finally{await lock.close();}
}
async function getReceipt(project,v){const file=path.join(project,'.work/update-previews',v.manifest.id+'.json');await noLinks(file);const r=await readJson(file);if(r.schema!=='ai-friend/update-preview/1'||r.digest!==v.digest||path.resolve(r.project)!==path.resolve(project)||!r.result?.passed||!r.result?.realModel||!r.result?.regressionPassed||!sameRecords(r.baseCode,await codeFingerprint(project)))throw Error('更新包或本地代码与预览时不同，请重新运行 Preview-Update');return r;}
function transactionPath(project,dir){const root=path.resolve(project,'backups/updates'),target=path.resolve(dir);if(path.dirname(target).toLowerCase()!==root.toLowerCase()||!/^update-[a-f0-9-]{36}$/.test(path.basename(target)))throw Error('升级事务路径越界');return target;}
async function readTransaction(project,dir){dir=transactionPath(project,dir);await noLinks(dir);const state=await readJson(dir+'/transaction.json');if(state.schema!=='ai-friend/update-transaction/1'||state.project!==path.resolve(project)||state.dir!==dir||!Array.isArray(state.roles)||state.roles[0]?.id!=='main'||state.roles.length>2||new Set(state.roles.map(r=>r.id)).size!==state.roles.length)throw Error('升级事务归属不符');for(const role of state.roles){if(!['main','test'].includes(role.id)||path.resolve(role.root)!==resolveInstance(project,role.id).root||typeof role.identity!=='string')throw Error('升级事务的实例路径不符');}for(const records of [state.beforeCode,state.afterCode])for(const r of records??[])codePath(r.path);for(const records of [state.beforeProfile,state.afterProfile])for(const r of records??[])if(!profileCode(r.path))throw Error('升级安装元数据路径越界');return state;}
async function rolesAt(project){const roles=[{...resolveInstance(project,'main')}],test=resolveInstance(project,'test');if(await exists(test.root)){if(await exists(test.root+'/isolation.json'))roles.push({...test});else if((await fs.readdir(test.root)).length)throw Error('测试目录含未识别的数据，未进行升级');}for(const r of roles)r.identity=identityAt(r.root);return roles;}
async function keepIdentities(roles){for(const r of roles)if(identityAt(r.root)!==r.identity)throw Error('实例身份变化，停止升级');}
async function remember(project,state,lock){await lock.check();await atomicJson(state.dir+'/transaction.json',state);await atomicJson(updatePending(project),{schema:'ai-friend/update-pending/1',transaction:state.dir,id:state.id,digest:state.digest,phase:state.phase,ownerToken:lock.token,launchToken:state.launchToken});}
export async function applyUpdate({project,bundle,hooks,checkCompatibility=validateCompatibility}){
 project=path.resolve(project);const v=await verifyUpdate(bundle),lock=await updateOperation(project,'apply');let state,migration,leases=[],supervised=false;
 try{
  const pending=await maybeJson(updatePending(project));
  if(pending){if(pending.digest!==v.digest)throw Error('上次升级未完成，请使用同一更新包继续');state=await readTransaction(project,pending.transaction);if(state.digest!==v.digest||state.kind==='rollback')throw Error('请继续原回退命令');if(state.phase==='completed'){await verifyRecords(project,state.afterCode);await verifyRecords(profileRoot(project),state.afterProfile);await keepIdentities(state.roles);await hooks.installed(v.manifest);await fs.unlink(updatePending(project));await atomicJson(project+'/.work/update-last.json',{transaction:state.dir,id:state.id,status:'completed'});return {updated:true,alreadyCompleted:true,started:false,id:state.id};}}
  else{
   await assertNoMigration(project);await checkCompatibility(project,v.manifest);await getReceipt(project,v);const roles=await rolesAt(project);
   // Stop through authenticated instance control; never kill an unknown process.
   await hooks.stop('test');await hooks.stop('main');for(const role of roles)await assertOffline(role.root);await keepIdentities(roles);
   const dir=path.resolve(project,'backups/updates/update-'+crypto.randomUUID());await fs.mkdir(dir,{recursive:true});state={schema:'ai-friend/update-transaction/1',id:v.manifest.id,digest:v.digest,dir,project,phase:'preparing',kind:'apply',roles,createdAt:new Date().toISOString(),launchToken:crypto.randomUUID()};
   await remember(project,state,lock);
  }
  state.launchToken=crypto.randomUUID();await remember(project,state,lock);await hooks.stop('test');await hooks.stop('main');await keepIdentities(state.roles);
  if(state.phase==='preparing'){
   for(const role of state.roles){const lease=await acquireOfflineLease(role.root);leases.push(lease);const snapshot=state.dir+'/'+role.id+'-snapshot';if(await exists(snapshot)){try{await verifySnapshot(snapshot);}catch(e){if(path.dirname(path.resolve(snapshot))!==state.dir)throw Error('快照重试路径越界');await noLinks(snapshot);await fs.rename(snapshot,snapshot+'.incomplete-'+crypto.randomUUID());}}if(!await exists(snapshot))await createSnapshot(role.root,snapshot,{metadataProjectRoot:project,assertSourceOffline:lease.assertOffline});await verifySnapshot(snapshot);role.data=(await readJson(snapshot+'/manifest.json')).files.filter(r=>protectedName(r.path));await assertData(role.root,role.data);}
   state.beforeCode=await codeFingerprint(project);state.afterCode=v.manifest.files.filter(r=>r.path.startsWith('project/')).map(r=>({...r,path:r.path.slice(8)}));state.beforeProfile=await inventory(profileRoot(project),await profileFiles(profileRoot(project)));state.afterProfile=v.manifest.files.filter(r=>r.path.startsWith('profile/')).map(r=>({...r,path:r.path.slice(8)}));
   await copyRecords(project,state.dir+'/previous-code',state.beforeCode);await copyRecords(profileRoot(project),state.dir+'/previous-profile',state.beforeProfile);state.phase='prepared';await remember(project,state,lock);
  }
  if(['prepared','writing','installing'].includes(state.phase)){
   migration=await acquireMigrationLock(project,'code-update');if(!leases.length)for(const role of state.roles)leases.push(await acquireOfflineLease(role.root));
   for(const role of state.roles)await assertData(role.root,role.data);state.phase='writing';await remember(project,state,lock);
   await switchFiles({target:project,source:v.bundle+'/project',before:state.beforeCode,after:state.afterCode,fault:hooks.afterFile});
   await switchFiles({target:profileRoot(project),source:v.bundle+'/profile',before:state.beforeProfile,after:state.afterProfile});state.phase='installing';await remember(project,state,lock);
   await hooks.installProfile(profileRoot(project));await hooks.installed(v.manifest);await keepIdentities(state.roles);for(const role of state.roles)await assertData(role.root,role.data);state.phase='installed';await remember(project,state,lock);
  }
  for(const lease of leases)await lease.close();leases=[];if(migration){await migration.close();migration=null;}
  if(state.phase!=='installed')throw Error('升级事务阶段无效');await verifyRecords(project,state.afterCode);await verifyRecords(profileRoot(project),state.afterProfile);await hooks.installed(v.manifest);await keepIdentities(state.roles);
  supervised=true;await hooks.start(state.launchToken);const health=await hooks.health();if(!health.available||health.identity!==state.roles[0].identity||!health.memory?.activeSpaces||health.memory.stores?.some(s=>!s.readable))throw Error('升级后主实例未通过身份和记忆健康检查');
  state.phase='completed';state.completedAt=new Date().toISOString();state.testNeedsSetup=state.roles.some(r=>r.id==='test');state.health={available:true,identity:health.identity,memory:health.memory,qqConnected:health.qq?.connected??false};await atomicJson(state.dir+'/transaction.json',state);await fs.unlink(updatePending(project));await atomicJson(project+'/.work/update-last.json',{transaction:state.dir,id:state.id,status:state.phase});return {updated:true,id:state.id,backup:state.dir,mainIdentityPreserved:true,mainRunning:true,testStopped:true,testNeedsSetup:state.testNeedsSetup};
 }catch(e){if(state){state.lastError=String(e.message).slice(0,1000);await atomicJson(state.dir+'/transaction.json',state).catch(()=>{});if(supervised)await hooks.stop('main').catch(()=>{});}throw e;
 }finally{for(const lease of leases)await lease.close().catch(()=>{});if(migration)await migration.close();await lock.close();}
}
export async function rollbackUpdate({project,transaction,hooks}){
 project=path.resolve(project);const lock=await updateOperation(project,'rollback');let migration,leases=[];
 try{
  const pending=await maybeJson(updatePending(project)),pointer=pending??await maybeJson(project+'/.work/update-last.json');if(pending&&transaction&&path.resolve(transaction)!==path.resolve(pending.transaction))throw Error('另一个升级事务尚未完成');const state=await readTransaction(project,transaction??pointer?.transaction??'');if(state.phase==='rolled-back'){await verifyRecords(project,state.beforeCode);await verifyRecords(profileRoot(project),state.beforeProfile);await keepIdentities(state.roles);if(pending)await fs.unlink(updatePending(project));return {rolledBack:true,alreadyDone:true,started:false};}if(!state.beforeCode||!state.beforeProfile)throw Error('备份准备未完成，请继续原 Apply-Update');
  await hooks.stop('test');await hooks.stop('main');await keepIdentities(state.roles);for(const role of state.roles){leases.push(await acquireOfflineLease(role.root));await assertData(role.root,role.data);}
  await verifyRecords(state.dir+'/previous-code',state.beforeCode);await verifyRecords(state.dir+'/previous-profile',state.beforeProfile);state.kind='rollback';state.launchToken=crypto.randomUUID();await remember(project,state,lock);migration=await acquireMigrationLock(project,'code-rollback');
  await switchFiles({target:project,source:state.dir+'/previous-code',before:state.afterCode,after:state.beforeCode});await switchFiles({target:profileRoot(project),source:state.dir+'/previous-profile',before:state.afterProfile,after:state.beforeProfile});await hooks.installProfile(profileRoot(project));await hooks.installed();await keepIdentities(state.roles);for(const role of state.roles)await assertData(role.root,role.data);
  state.phase='rolled-back';state.rolledBackAt=new Date().toISOString();await atomicJson(state.dir+'/transaction.json',state);await fs.unlink(updatePending(project));await atomicJson(project+'/.work/update-last.json',{transaction:state.dir,id:state.id,status:state.phase});return {rolledBack:true,started:false,roleDataRestored:false,identityPreserved:true};
 }finally{for(const lease of leases)await lease.close().catch(()=>{});if(migration)await migration.close();await lock.close();}
}
