import {hash,noSecret,aborted} from './validation.js';
import fs from 'node:fs/promises';
const canonical=row=>({target:row.target,content:row.content,importance:row.importance,created_at:row.created_at,updated_at:row.updated_at,branches:row.branches??[],origin:row.origin??null});
export const runtimeVersion=row=>hash(JSON.stringify(canonical(row)));
/** A client of the public Runtime Source factory; never edits its JSON directly. */
export class RuntimeWriter{
  constructor({memoryDir,policy,createSource}){Object.assign(this,{memoryDir,policy,createSource});this.runtime=null;this.configuration=null;}
  binding(){
    const policy=this.policy();if(!policy.enabled||!policy.writeEnabled||!policy.previewRuntimeSupported)throw new Error('当前配置不允许应用本实例的常驻记忆');
    const config={dataDir:this.memoryDir,userDataDir:this.memoryDir,...policy.runtimeLimits??{}},key=JSON.stringify(config);
    if(this.configuration!==key){this.runtime=this.createSource(config).create({sourceInstanceKey:'ai-friend-runtime-writer',provenance:{packageName:'@ai-friend/companion-adapter',entryId:'friend-adapter'},configuration:{}});this.configuration=key;}
    return this.runtime;
  }
  async manage(mode,operation,input,signal){aborted(signal);const result=await this.binding().manage({scope:{storage:'custom'},sourceInstanceKey:'ai-friend-runtime-writer',mode,operation,input,confirmed:mode==='mutate',signal});aborted(signal);return result;}
  async snapshot(signal){return (await this.manage('read','snapshot',null,signal)).value;}
  async signature(signal){const snapshot=await this.snapshot(signal),stat=await fs.stat(snapshot.sourcePath,{bigint:true});return hash(JSON.stringify([snapshot.revision,String(stat.mtimeNs),String(stat.ctimeNs),String(stat.size)]));}
  async before(reference,signal){
    const rows=(await this.snapshot(signal)).entries.filter(row=>row.target===reference.target&&row.content===reference.text);
    if(rows.length!==1)throw new Error('常驻旧条目已变化或不唯一，请重新预演');
    if(reference.createdAt&&rows[0].created_at!==reference.createdAt||reference.updatedAt&&rows[0].updated_at!==reference.updatedAt)throw new Error('常驻旧条目版本已变化，请重新预演');
    noSecret(JSON.stringify(rows[0]));return rows[0];
  }
  async inspect(operation,signal){
    const snapshot=await this.snapshot(signal),old=operation.before;
    const oldRows=old?snapshot.entries.filter(row=>row.target===old.target&&row.content===old.content):[];
    const target=old?.target??operation.target;
    const newRows=operation.content?snapshot.entries.filter(row=>row.target===target&&row.content===operation.content):[];
    const desired=['runtime_archive','runtime_remove'].includes(operation.kind)?oldRows.length===0:newRows.length===1&&(operation.kind==='runtime_add'||oldRows.length===0);
    return {snapshot,oldRows,newRows,desired};
  }
  async write(operation,signal){
    const checked=await this.inspect(operation,signal);
    if(checked.desired)return {verified:true,reconciled:true,target:operation.before?.target??operation.target,content:operation.content??null,archived:operation.kind==='runtime_archive'};
    const old=operation.before;
    if(old&&(checked.oldRows.length!==1||runtimeVersion(checked.oldRows[0])!==runtimeVersion(old)))throw new Error('常驻记录已被更新，拒绝用旧应用计划覆盖');
    const mutation={action:operation.kind==='runtime_add'?'add':['runtime_archive','runtime_remove'].includes(operation.kind)?'remove':'replace',target:old?.target??operation.target,...old?{oldText:old.content}:{},...operation.content?{content:operation.content}:{},importance:operation.importance??old?.importance??'normal'};
    const planned=(await this.manage('read','maintenance-plan',{...mutation,preserveImportance:true},signal)).value;
    if(old&&(!planned.excluded||runtimeVersion(planned.excluded)!==runtimeVersion(old)))throw new Error('常驻写入规划时旧值已变化');
    if(planned.requiresMaintenance)throw new Error('常驻容量不足，本次不压缩或丢弃其他记忆，保留待处理操作');
    if(old?.origin||planned.entries.some(row=>row.origin))throw new Error('存在尚未适配的跨机器来源元数据，本次不改写');
    const compacted=planned.entries.map(row=>({content:row.content,importance:row.importance,...row.branches?{branches:row.branches}:{}}));
    // The ordinary public mutate operation has no CAS. This public operation checks revision under its lock.
    const result=await this.manage('mutate','compact-and-mutate',{revision:planned.revision,mutation,compacted,maxBytes:planned.limit,preserveImportance:true},signal);
    if(result.value?.success!==true)throw new Error('常驻写入没有返回成功回执');
    const after=await this.inspect(operation,signal);if(!after.desired)throw new Error('常驻写入未通过读回核对');
    const entry=after.newRows[0];return {verified:true,reconciled:false,target:mutation.target,content:operation.content??null,archived:operation.kind==='runtime_archive',sourceRevision:result.revision,...entry?{entryVersion:runtimeVersion(entry)}:{},result:result.value};
  }
  async current(operation,signal){return (await this.inspect(operation,signal)).desired;}
}
