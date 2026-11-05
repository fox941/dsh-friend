import fs from 'node:fs/promises';
import path from 'node:path';
import {ProtectionStore} from './protection-store.js';
import {SnapshotManager} from './protection-snapshot.js';
import {databaseHash} from './protection-sql.js';
import {runtimeVersion} from './apply-runtime.js';
import {uuid,noSecret} from './validation.js';
const safe=error=>{const value=String(error?.message??error).slice(0,600);try{noSecret(value);return value;}catch{return '诊断中疑似敏感内容已省略';}};
const integer=(value,fallback,min,max)=>{const n=value??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('记忆保护配置超出范围');return n;};
export class ProtectionController{
  constructor({journal,applications,backend,memoryDir,directory,config={},now=()=>new Date()}){
    Object.assign(this,{journal,applications,backend,memoryDir,directory});this.config={maxSnapshots:integer(config.maxSnapshots,16,1,128),maxBytes:integer(config.maxBytes,536870912,1048576,4294967296),timeoutMs:integer(config.timeoutMs,30000,1000,60000)};
    this.store=new ProtectionStore(journal,now);this.snapshots=new SnapshotManager({store:this.store,backend,memoryDir,directory,config:this.config});
  }
  summary(id){const row=this.store.snapshot(id),undo=this.store.undo(id);return {snapshot:row?{id:row.id,status:row.status,bytes:row.bytes,tier:row.manifest?.tier??'full',error:row.error,createdAt:row.created_at}:null,undo:undo?{id:undo.id,status:undo.status,error:undo.error}:null,scope:'保护整理应用及统一入口的日常聊天写入；管理页、外部 CLI 和其他插件的直接写入不自动纳入。'};}
  hasPendingUndo(){return Boolean(this.store.db.prepare("SELECT 1 FROM protection_undos WHERE status!='completed' LIMIT 1").get());}
  withdrawnReport(id){return Boolean(this.store.db.prepare("SELECT 1 FROM protection_undos u JOIN apply_runs a ON a.id=u.application_id WHERE a.report_id=? AND u.status='completed' LIMIT 1").get(id));}
  async submit(row,signal,execute){
    const steps=this.applications.store.steps(row.id);if(!steps.length)return execute();
    return this.backend.correction.serial(async()=>{
      try{await this.snapshots.capture(row.id,steps,signal);}
      catch(error){const message=safe(error),snapshot=this.store.snapshot(row.id);if(snapshot&&['ready','sealed'].includes(snapshot.status))this.store.db.prepare('UPDATE protection_snapshots SET error=?,updated_at=? WHERE application_id=?').run(message,this.store.time(),row.id);else if(snapshot)this.store.fail(row.id,message);this.applications.store.state(row.id,'backup_blocked',message);return {...await this.applications.read(row.id),summary:'前置快照未验证成功，本批未继续写入。'+message,protection:this.summary(row.id)};}
      const result=await execute();
      try{await this.snapshots.seal(row.id,this.applications.store.steps(row.id));}
      catch(error){this.store.db.prepare("UPDATE protection_snapshots SET status='ready',after_json=NULL,error=?,updated_at=? WHERE application_id=?").run('写后核验未完成：'+safe(error),this.store.time(),row.id);}
      return {...result,protection:this.summary(row.id)};
    },signal);
  }
  async eligibility(id,signal){
    uuid(id);const run=this.applications.store.get(id),snapshot=this.store.snapshot(id),undo=this.store.undo(id),reasons=[];
    if(undo?.status==='completed')return {status:'undone',reasons:[],undoId:undo.id};
    if(!run)return {status:'not_found',reasons:['没有此应用批次']};
    if(undo&&['prepared','running','interrupted','partial'].includes(undo.status))return {status:'resume_offline',reasons:['已有撤销检查点，停机后按原步骤重新核验'],undoId:undo.id};
    const steps=this.applications.store.steps(id);
    if(!steps.length)return {status:'no_changes',reasons:['该批没有实际写入步骤']};
    if(!snapshot)return {status:'unprotected',reasons:['旧批次没有前置快照，不能补造撤销保证']};
    if(snapshot.status!=='sealed'||!snapshot.after)return {status:'blocked',reasons:['快照未完成写后核验或已过期']};
    reasons.push(...snapshot.after.nativeUndoReasons??[]);
    if(steps.some(step=>step.status!=='applied'))reasons.push('应用仍有未完成或结果不明的步骤');
    try{await this.snapshots.verify(id);}catch(error){reasons.push(safe(error));}
    if(JSON.stringify(this.snapshots.growth())!==JSON.stringify(snapshot.after.growth))reasons.push('此后已有自我状态变化，保留后来的认识');
    const runtime=(await this.backend.runtime.snapshot(signal)).entries;
    for(const step of steps){const op=step.operation;if(op.kind==='profile_transition'&&!this.backend.profileStore().current(step.receipt))reasons.push('画像关系或常驻关联已有后续修改');if(run.approval?.kind==='profile_change'&&op.kind.startsWith('runtime_')&&step.receipt?.reconciled)reasons.push('常驻步骤为中断核对结果，缺少可归属的原始写入版本');if(!op.kind.startsWith('runtime_'))continue;
      if(['runtime_archive','runtime_remove'].includes(op.kind)){if(runtime.some(row=>row.target===op.before.target&&row.content===op.before.content))reasons.push('移出常驻的旧事项后来又被写回');continue;}
      const target=op.before?.target??op.target,expected=snapshot.after.runtime.filter(row=>row.target===target&&row.content===op.content),current=runtime.filter(row=>row.target===target&&row.content===op.content);
      if(expected.length!==1||current.length!==1||runtimeVersion(current[0])!==runtimeVersion(expected[0]))reasons.push('目标常驻条目此后发生变化');
      if(op.kind==='runtime_replace'&&runtime.some(row=>row.target===op.before.target&&row.content===op.before.content))reasons.push('旧值已另行恢复，不能再次替换');
    }
    for(const[store,digest]of Object.entries(snapshot.after.native))try{if(await databaseHash(await this.snapshots.nativeFile(store),signal)!==digest)reasons.push('长期库此后发生变化，不能覆盖后来的记录或关系');}catch(error){reasons.push(safe(error));}
    return {status:reasons.length?'blocked':'ready_offline',reasons:[...new Set(reasons)],scope:'整批撤销需停机；长期库采用整库指纹保护，因此不相关的后续长期写入也会保守拒绝。'};
  }
  async changes(id,{includeSources=false,checkUndo=false,html=false}={},signal){
    const chosen=id??this.applications.store.recent(1)[0]?.id;if(!chosen)return {status:'no_changes',batches:[]};uuid(chosen);
    const row=this.applications.store.get(chosen);if(!row)throw new Error('没有找到该应用批次');
    const read=await this.applications.read(chosen,signal),snapshot=this.store.snapshot(chosen),steps=this.applications.store.steps(chosen);
    const version=id=>id?(this.backend.growth.store.version(id)??null):null;
    const changes=steps.map((step,index)=>({index,kind:step.operation.kind,status:step.status,oldValue:step.operation.reference?.text??null,newValue:step.operation.content??(step.operation.kind==='runtime_archive'?step.operation.before.content:null),reason:step.operation.reason,quotes:step.operation.evidence,affectedSelf:(step.receipt?.changes??[]).map(item=>({...item,before:version(item.previousId??snapshot?.manifest?.growth.heads.find(row=>row.key===item.key)?.id),after:version(item.currentId??item.versionId)})),result:read.steps[index]}));
    const result={status:'read',applicationId:chosen,reportId:row.reportId,batchStatus:read.status,generatedAt:this.store.time(),protection:this.summary(chosen),changes,...includeSources?{sources:row.frame?.sources??[]}: {},...checkUndo?{undo:await this.eligibility(chosen,signal)}:{},meaning:'旧值是过去版本，新值是本批写入结果；当前有效性以回执核验为准。查看报告不增加独立经历。'};
    if(html)result.reportPath=await this.html(result,row.frame?.sources??[]);return result;
  }
  async html(result,sources){
    const escape=value=>String(value??'无').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
    const folder=path.join(this.directory,'reports');await fs.mkdir(folder,{recursive:true});if(path.resolve(await fs.realpath(folder)).toLowerCase()!==path.resolve(folder).toLowerCase())throw new Error('报告目录不允许重定向');
    const file=path.join(folder,`changes-${uuid(result.applicationId)}.html`),stat=await fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(stat?.isSymbolicLink())throw new Error('报告文件不允许重定向');
    const content=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>记忆变更</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:1000px;margin:36px auto;padding:0 24px;color:#17212b;background:#f6f7f9}article{background:white;padding:22px;margin:18px 0;border:1px solid #dde1e8;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f4f7;padding:14px;border-radius:8px}small{color:#526171}h1,h2{line-height:1.3}summary{cursor:pointer}b{color:#183e57}</style><h1>记忆变更记录</h1><p>批次状态：<b>${escape(result.batchStatus)}</b> · 快照：${escape(result.protection.snapshot?.status)}</p><small>生成于 ${escape(result.generatedAt)}。此页是静态记录；当前状态需重新查询。</small><p>${escape(result.meaning)}</p>${result.changes.map(item=>`<article><h2>${item.index+1}. ${escape(item.kind)} · ${escape(item.status)}</h2><b>旧值（历史）</b><pre>${escape(item.oldValue)}</pre><b>本批新值</b><pre>${escape(item.newValue)}</pre><p>依据：${escape(item.reason)}</p><details><summary>原话与执行结果</summary><pre>${escape(JSON.stringify({quotes:item.quotes,affectedSelf:item.affectedSelf,result:item.result},null,2))}</pre></details></article>`).join('')}<details><summary>原始来源记录</summary><pre>${escape(JSON.stringify(sources,null,2))}</pre></details><details><summary>快照与撤销检查</summary><pre>${escape(JSON.stringify({protection:result.protection,undo:result.undo},null,2))}</pre></details></html>`;
    await fs.writeFile(file,content);return file;
  }
}
