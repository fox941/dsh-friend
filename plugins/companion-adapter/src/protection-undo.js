import fs from 'node:fs/promises';
import path from 'node:path';
import {copyDatabase,databaseHash,fileHash,writableFile} from './protection-sql.js';
import {runtimeVersion} from './apply-runtime.js';
import {uuid,aborted,noSecret} from './validation.js';
const safe=error=>String(error?.message??error).slice(0,650);
/** Stop the managed Host first. A Native restore is never attempted in live chat. */
export async function undoBatch(protection,id,approval,{assertOffline,signal}={}){
  uuid(id);if(typeof assertOffline!=='function')throw new Error('撤销必须由可验证的停机入口调用');noSecret(JSON.stringify(approval));await assertOffline();
  const {store,snapshots,backend,applications}=protection,old=store.undo(id);if(old?.status==='completed')return {status:'completed',replayed:true,applicationId:id,receipt:old.receipt};
  return backend.correction.serial(async()=>{
    await assertOffline();let undo=store.undo(id);
    if(!undo){
      const eligibility=await protection.eligibility(id,signal);if(eligibility.status!=='ready_offline')return {status:'blocked',applicationId:id,...eligibility};
      const before=await snapshots.verify(id),snapshot=store.snapshot(id),steps=applications.store.steps(id),operations=[{kind:'safety'}];
      for(const[space,row]of Object.entries(before.native))operations.push({kind:'native_restore',storeId:space,source:row.path,expected:snapshot.after.native[space],desired:row.digest});
      for(const step of [...steps].reverse()){
        const op=step.operation;if(!op.kind.startsWith('runtime_'))continue;
        const after=snapshot.after.runtime.find(row=>row.target===(op.before?.target??op.target)&&row.content===op.content);
        if(['runtime_archive','runtime_remove'].includes(op.kind))operations.push({kind:'runtime_restore',inverse:{kind:'runtime_add',target:op.before.target,content:op.before.content,importance:op.before.importance},expected:null});
        else operations.push({kind:'runtime_restore',inverse:{kind:op.kind==='runtime_add'?'runtime_archive':'runtime_replace',before:after,...op.kind==='runtime_replace'?{content:op.before.content}:{}},expected:runtimeVersion(after)});
      }
      for(const step of steps)if(step.operation.kind==='profile_transition')operations.push({kind:'profile_metadata_restore',original:step.receipt});
      operations.push({kind:'self_restore',before:before.growth,expected:snapshot.after.growth});
      operations.push({kind:'heads_restore',corrections:steps.filter(step=>step.operation.kind==='native_correct').map(step=>({storeId:step.receipt.storeId,correctionId:step.receipt.correctionId,oldId:step.operation.reference.recordId,newId:step.receipt.currentId}))});
      undo=store.beginUndo(id,approval,operations);
    }
    store.undoState(id,'running');
    try{
      for(const step of store.undoSteps(undo.id)){
        aborted(signal);await assertOffline();const op=step.operation;
        if(step.status==='applied'){
          if(op.kind==='profile_metadata_restore'&&!backend.profileStore().undoCheck(op.original))throw new Error('已恢复的画像又有后续变化');
          if(op.kind==='native_restore'&&await databaseHash(await snapshots.nativeFile(op.storeId),signal)!==op.desired)throw new Error('已恢复的长期库又发生变化，停止后续撤销');
          if(op.kind==='runtime_restore'){
            const checked=await backend.runtime.inspect(op.inverse,signal);if(!checked.desired)throw new Error('已撤销的常驻目标又发生变化');
            if(step.receipt?.restoredEntry){const rows=checked.newRows;if(rows.length!==1||runtimeVersion(rows[0])!==runtimeVersion(step.receipt.restoredEntry))throw new Error('已恢复的常驻版本又被修改');}
          }
          if(op.kind==='self_restore'&&step.receipt?.changes.some(row=>backend.growth.store.head(row.key)?.id!==row.current))throw new Error('已恢复的自我状态又发生变化');
          if(op.kind==='safety')for(const row of step.receipt.files){const file=await snapshots.checked(path.join(id,'undo-safety',row.path));if(await fileHash(file)!==row.sha256)throw new Error('撤销保护副本校验失败');}
          continue;
        }
        if(op.kind==='safety'){
          const directory=path.join(snapshots.root,id,'undo-safety');await fs.mkdir(directory,{recursive:true});if(path.resolve(await fs.realpath(directory)).toLowerCase()!==path.resolve(directory).toLowerCase())throw new Error('撤销保护目录不允许重定向');
          const snapshot=store.snapshot(id),files=[];
          // Preserve the state being replaced as well; this is not used as a blind redo.
          for(const[space,digest]of Object.entries(snapshot.after.native)){
            const source=await snapshots.nativeFile(space);if(await databaseHash(source,signal)!==digest)throw new Error('建立撤销保护副本前长期库发生变化');
            const metadata=await copyDatabase(source,path.join(directory,space+'.sqlite'),{signal,maxBytes:protection.config.maxBytes,timeoutMs:protection.config.timeoutMs});files.push({path:space+'.sqlite',...metadata});
          }
          const current=await backend.runtime.snapshot(signal);await writableFile(path.join(directory,'runtime.json'));await fs.writeFile(path.join(directory,'runtime.json'),JSON.stringify(current.entries));files.push({path:'runtime.json',bytes:(await fs.stat(path.join(directory,'runtime.json'))).size,sha256:await fileHash(path.join(directory,'runtime.json'))});
          files.push({path:'companion.sqlite',...await copyDatabase(store.db,path.join(directory,'companion.sqlite'),{signal,maxBytes:protection.config.maxBytes,timeoutMs:protection.config.timeoutMs})});
          const bytes=files.reduce((n,row)=>n+row.bytes,0);
          const baseBytes=snapshot.manifest.files.reduce((sum,row)=>sum+row.bytes,0);if(baseBytes+bytes>protection.config.maxBytes)throw new Error('撤销前后副本超过保护空间上限');
          store.db.prepare('UPDATE protection_snapshots SET bytes=? WHERE application_id=?').run(baseBytes+bytes,id);await snapshots.prune(id);
          await writableFile(path.join(directory,'manifest.json'));await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({files,createdAt:store.time()}));store.undoStep(undo.id,step.position,'applied',{verified:true,files,bytes});continue;
        }
        if(op.kind==='native_restore'){
          const target=await snapshots.nativeFile(op.storeId),current=await databaseHash(target,signal);
          if(step.status==='writing'&&current===op.desired){store.undoStep(undo.id,step.position,'applied',{verified:true,reconciled:true,digest:current});continue;}
          if(current!==op.expected)throw new Error('长期库已变化，本步骤没有覆盖任何后续记录');
          const source=await snapshots.checked(path.join(id,op.source));await snapshots.verify(id);store.undoStep(undo.id,step.position,'writing');
          await copyDatabase(source,target,{signal,maxBytes:protection.config.maxBytes,timeoutMs:protection.config.timeoutMs});if(await databaseHash(target,signal)!==op.desired)throw new Error('长期库恢复后核验失败，保留撤销检查点');store.undoStep(undo.id,step.position,'applied',{verified:true,digest:op.desired});continue;
        }
        if(op.kind==='runtime_restore'){
          const state=await backend.runtime.inspect(op.inverse,signal);
          if(step.status==='writing'&&state.desired){store.undoStep(undo.id,step.position,'applied',{verified:true,reconciled:true});continue;}
          if(op.expected&&(state.oldRows.length!==1||runtimeVersion(state.oldRows[0])!==op.expected))throw new Error('常驻目标已变化，保留后续修改');
          if(!op.expected&&state.newRows.length)throw new Error('转存事项后来又被写回，未重复新增');
          store.undoStep(undo.id,step.position,'writing');const receipt=await backend.runtime.write(op.inverse,signal),after=await backend.runtime.inspect(op.inverse,signal);store.undoStep(undo.id,step.position,'applied',{...receipt,restoredEntry:after.newRows[0]??null});continue;
        }
        if(op.kind==='self_restore'){
          store.journal.transaction(()=>{
            if(JSON.stringify(snapshots.growth())!==JSON.stringify(op.expected))throw new Error('自我认识已有后续变化，未覆盖新的状态');
            const before=new Map(op.before.heads.map(row=>[row.key,row.id])),pending=op.expected.heads.filter(row=>before.get(row.key)!==row.id).map(row=>({old:backend.growth.store.version(before.get(row.key)),after:row.id})),mapping=new Map(),changes=[];
            if(pending.some(row=>!row.old))throw new Error('缺少原自我版本，不能推测恢复内容');
            while(pending.length){const index=pending.findIndex(row=>row.old.dependsOn.every(ref=>!pending.some(other=>other.old.id===ref)));if(index<0)throw new Error('原状态依赖无法安全还原');const[row]=pending.splice(index,1);const next=backend.growth.store.put({...row.old,dependsOn:row.old.dependsOn.map(ref=>mapping.get(ref)??ref),reason:`明确撤销应用批次 ${id}，恢复原认识；不增加证据`,batchId:`undo:${undo.id}`});mapping.set(row.old.id,next.id);changes.push({key:row.old.key,previous:row.after,current:next.id,supports:next.supports.length});}
            if(changes.length)backend.growth.store.advanceRevision();store.undoStep(undo.id,step.position,'applied',{verified:true,changes,revision:backend.growth.store.revision()});
          });continue;
        }
        if(op.kind==='profile_metadata_restore'){store.undoStep(undo.id,step.position,'writing');const receipt=await backend.profileStore().undo(op.original,backend.runtime,signal);store.undoStep(undo.id,step.position,'applied',receipt);continue;}
        if(op.kind==='heads_restore'){
          store.journal.transaction(()=>{for(const item of op.corrections){const row=backend.correction.journal.get(item.correctionId);if(!row)throw new Error('原更正记录缺失');const current=backend.correction.journal.head(item.storeId,row.fact_key);if(![item.oldId,item.newId].includes(current))throw new Error('更正链已有后续版本');store.db.prepare('UPDATE adapter_heads SET current_id=? WHERE store_id=? AND fact_key=?').run(item.oldId,item.storeId,row.fact_key);store.db.prepare('INSERT OR IGNORE INTO protection_corrections VALUES(?,?)').run(item.correctionId,undo.id);}store.undoStep(undo.id,step.position,'applied',{verified:true});});continue;
        }
        throw new Error('不支持的撤销步骤');
      }
      const receipt={verified:true,applicationId:id,undoId:undo.id,at:store.time(),summary:'本批已按检查点撤销，原始聊天和变更历史保留；自我恢复产生新版本，没有新增经历。'};store.undoState(id,'completed',null,receipt);return {status:'completed',...receipt};
    }catch(error){const message=safe(error);store.undoState(id,'partial',message);return {status:'partial',applicationId:id,undoId:undo.id,error:message,summary:'撤销未全部完成，保留逐步回执；继续停机并重试同一批次，不要覆盖整个 runtime。'};}
  },signal);
}
