import fs from 'node:fs/promises';
import path from 'node:path';
import {copyDatabase,databaseHash,fileHash,nativeFootprint,unexplainedNativeWrites} from './protection-sql.js';
import {hash,uuid,aborted} from './validation.js';
export class SnapshotManager{
  constructor({store,backend,memoryDir,directory,config}){Object.assign(this,{store,backend,memoryDir,directory,config});this.root=path.join(directory,'protection','snapshots');}
  async checked(relative){const root=path.resolve(this.root),target=path.resolve(root,relative);if(!target.startsWith(root+path.sep))throw new Error('快照路径超出实例范围');const stat=await fs.lstat(target);if(stat.isSymbolicLink()||path.resolve(await fs.realpath(target)).toLowerCase()!==target.toLowerCase())throw new Error('快照不允许重定向');return target;}
  growth(){const store=this.backend.growth.store;return {identity:store.meta('identity'),revision:store.revision(),heads:store.heads().map(row=>({key:row.key,id:row.id})).sort((a,b)=>a.key.localeCompare(b.key))};}
  nativeStores(steps){return [...new Set(steps.map(step=>step.operation.storeId??step.operation.reference?.storeId).filter(Boolean))].sort();}
  async nativeFile(store){this.backend.correction.selectStore(store,true);const file=path.join(this.memoryDir,'data',store,'mnemon.db');if(path.resolve(await fs.realpath(file)).toLowerCase()!==path.resolve(file).toLowerCase())throw new Error('长期数据库不允许重定向');return file;}
  async manifest(id){const row=this.store.snapshot(uuid(id));if(!row?.manifest||['failed','expired','building'].includes(row.status))throw new Error('该批次没有仍可用的一致性快照');const file=await this.checked(path.join(id,'manifest.json')),disk=JSON.parse(await fs.readFile(file,'utf8'));if(JSON.stringify(disk)!==JSON.stringify(row.manifest))throw new Error('快照清单与持久记录不一致');return row.manifest;}
  async verify(id){const manifest=await this.manifest(id);for(const row of manifest.files){const file=await this.checked(path.join(id,row.path));if((await fs.stat(file)).size!==row.bytes||await fileHash(file)!==row.sha256)throw new Error('快照文件校验失败：'+row.path);}return manifest;}
  async capture(id,steps,signal){
    aborted(signal);let existing=this.store.snapshot(id);
    if(existing&&['ready','sealed'].includes(existing.status)){
      await this.verify(id);
      if(steps.some(step=>step.status!=='prepared')){
        if(!existing.after)throw new Error('中断批次没有写后指纹，保留原快照等待人工核对');
        for(const[space,digest]of Object.entries(existing.after.native))if(await databaseHash(await this.nativeFile(space),signal)!==digest)throw new Error('中断后长期库已有其他写入，原快照不覆盖这些新记忆，本批暂缓继续');
      }
      return existing.manifest;
    }
    if(steps.some(step=>step.status!=='prepared'))throw new Error('已有写入但缺少有效前置快照，拒绝补造可撤销保证');
    existing=this.store.begin(id);const folder=path.join(this.root,uuid(id));await fs.mkdir(this.root,{recursive:true});
    if(path.resolve(await fs.realpath(this.root)).toLowerCase()!==path.resolve(this.root).toLowerCase())throw new Error('保护目录不允许重定向');
    if(existing.status==='failed'){
      const prior=await fs.lstat(folder).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(prior)await fs.rm(await this.checked(id),{recursive:true});
      this.store.db.prepare("UPDATE protection_snapshots SET status='building',manifest_json=NULL,after_json=NULL,bytes=0,error=NULL WHERE application_id=?").run(id);existing=this.store.snapshot(id);
    }
    if(existing.status!=='building')throw new Error('上次快照已过期，不能补造写前保证');
    await fs.mkdir(folder);const files=[],native={},growth=this.growth(),signature=await this.backend.runtime.signature(signal),runtime=await this.backend.runtime.snapshot(signal);
    try{
      const runtimeText=JSON.stringify({version:1,entries:runtime.entries});await fs.writeFile(path.join(folder,'runtime.json'),runtimeText,{flag:'wx'});files.push({path:'runtime.json',bytes:Buffer.byteLength(runtimeText),sha256:hash(runtimeText)});
      await fs.mkdir(path.join(folder,'native'));
      for(const store of this.nativeStores(steps)){
        const file=await this.nativeFile(store),relative=path.join('native',store+'.sqlite'),metadata=await copyDatabase(file,path.join(folder,relative),{signal,maxBytes:this.config.maxBytes,timeoutMs:this.config.timeoutMs});
        files.push({path:relative,...metadata});native[store]={path:relative,digest:await databaseHash(path.join(folder,relative),signal)};
      }
      // Append-only hot-memory writes cannot alter existing self versions or Native.
      // Keep their durable intent/receipt in the live journal and snapshot only Runtime.
      const run=this.store.db.prepare('SELECT approval_json FROM apply_runs WHERE id=?').get(id);
      const tier=run&&JSON.parse(run.approval_json).kind==='conversation'&&steps.every(step=>step.operation.kind==='runtime_add')?'runtime_append':'full';
      if(tier==='full'){const companion=await copyDatabase(this.store.db,path.join(folder,'companion.sqlite'),{signal,maxBytes:this.config.maxBytes,timeoutMs:this.config.timeoutMs});files.push({path:'companion.sqlite',...companion});}
      if(signature!==await this.backend.runtime.signature(signal)||JSON.stringify(growth)!==JSON.stringify(this.growth()))throw new Error('备份期间常驻记忆或自我状态变化，未允许写入');
      for(const[store,row]of Object.entries(native))if(row.digest!==await databaseHash(await this.nativeFile(store),signal))throw new Error('备份期间长期库变化，未允许写入');
      const bytes=files.reduce((sum,row)=>sum+row.bytes,0);if(bytes>this.config.maxBytes)throw new Error('本批快照超过总空间上限');
      const manifest={schema:'ai-friend-protection/1',applicationId:id,tier,createdAt:this.store.time(),files,native,growth,runtime:{revision:runtime.revision,entries:runtime.entries},containsPrivateData:true,scope:tier==='runtime_append'?'仅常驻新增的 Runtime 前像及自我版本引用；意图和回执保存在 companion.sqlite，完整原件仍由 DSH 保留。':'本批相关 Native 全库与图、常驻记忆、自我及应用日志；原始完整会话仍由 DSH 保留。'};
      await fs.writeFile(path.join(folder,'manifest.json'),JSON.stringify(manifest));this.store.ready(id,manifest,bytes);await this.prune(id);await this.verify(id);return manifest;
    }catch(error){this.store.fail(id,String(error.message).slice(0,500));try{await fs.rm(await this.checked(id),{recursive:true});}catch{}throw error;}
  }
  async seal(id,steps,signal){
    const before=await this.verify(id),native={},nativeUndoReasons=[];
    for(const space of Object.keys(before.native)){
      const current=await this.nativeFile(space),old=await this.checked(path.join(id,before.native[space].path)),allowed=steps.filter(step=>(step.operation.storeId??step.operation.reference?.storeId)===space).flatMap(step=>[step.operation.reference?.recordId,step.receipt?.currentId,step.receipt?.nativeId]).filter(Boolean);
      const pre=nativeFootprint(old,allowed),post=nativeFootprint(current,allowed);
      if(pre.outside!==post.outside||unexplainedNativeWrites(current,pre.lastOp,allowed))nativeUndoReasons.push('批次窗口包含无法归因的长期库写入，禁止整库撤销');
      native[space]=await databaseHash(current,signal);
    }
    const runtime=await this.backend.runtime.snapshot(signal),after={native,nativeUndoReasons,growth:this.growth(),runtime:runtime.entries,stepStates:steps.map(step=>({id:step.id,status:step.status})),at:this.store.time()};
    this.store.seal(id,after);return after;
  }
  async prune(current){
    let rows=this.store.liveSnapshots(),bytes=rows.reduce((sum,row)=>sum+row.bytes,0);
    for(const row of rows){if(rows.length<=this.config.maxSnapshots&&bytes<=this.config.maxBytes)break;if(row.application_id===current||this.store.undo(row.application_id)&&this.store.undo(row.application_id).status!=='completed')continue;
      const run=this.store.db.prepare('SELECT status FROM apply_runs WHERE id=?').get(row.application_id);if(!['completed','deferred','historical'].includes(run?.status))continue;
      const folder=await this.checked(uuid(row.application_id));await fs.rm(folder,{recursive:true});this.store.expire(row.application_id);bytes-=row.bytes;rows=rows.filter(item=>item!==row);
    }
    if(rows.length>this.config.maxSnapshots||bytes>this.config.maxBytes)throw new Error('保护空间被尚未完成的批次占用，本次暂缓写入');
  }
}
