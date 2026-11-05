import { Journal } from './journal.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import { text, uuid, hash, noSecret, aborted } from './validation.js';

export class CorrectionController {
  constructor({ directory, client, policy, lock = (_root,fn)=>fn(), memoryDir }) {
    Object.assign(this,{client,policy,lock,memoryDir});
    this.journal=new Journal(directory);
    this.tail=Promise.resolve(); this.closed=false;this.serialScope=new AsyncLocalStorage();
  }
  serial(fn,signal) {
    if(this.closed)return Promise.reject(new Error('纠错插件已停止'));
    const held=this.serialScope.getStore();if(held?.controller===this&&held.active){aborted(signal);return fn();}
    const lease={controller:this,active:true};
    const operation=this.tail.then(()=>this.lock(this.memoryDir,()=>this.journal.locked(()=>this.serialScope.run(lease,async()=>{try{return await fn();}finally{lease.active=false;}}),signal)));
    this.tail=operation.catch(()=>{}); return operation;
  }
  selectStore(storeId,write=false) {
    const policy=this.policy();
    if(!policy.enabled||(write&&!policy.writeEnabled))throw new Error('当前配置未允许本地记忆操作');
    const active=policy.spaces.filter(space=>space.active);
    const store=storeId??(active.length===1?active[0].id:undefined);
    this.client.assertStore(store,write); return store;
  }
  async correct(args,evidence,signal) {
    const storeId=this.selectStore(args.storeId,true),oldId=uuid(args.oldId);
    const priorKey=this.journal.keyForRecord(storeId,oldId);
    const factKey=priorKey??text(args.factKey??`memory:${oldId}`,'factKey',160),oldContent=text(args.expectedOldContent,'旧记录原文'),newContent=text(args.newContent,'新记录原文');
    const quote=text(evidence?.quote,'用户更正原话',2000);
    const profileSource=evidence?.kind==='verified-profile-change'&&evidence.applicationId&&evidence.approval?.kind==='profile_change'&&['qq','bilibili'].includes(evidence.profileSource?.channel)&&evidence.profileSource?.key&&evidence.profileSource?.eventId;
    if(evidence?.owner!==true||!(evidence.sessionId&&evidence.messageId||profileSource))throw new Error('需要当前主用户更正原话的可靠引用');
    if(newContent===oldContent)throw new Error('新旧内容相同，无需更正');
    [quote,oldContent,newContent].forEach(noSecret);
    const reason=text(args.reason??quote,'更正依据',2000);
    noSecret(reason);
    const baseId=hash(JSON.stringify([storeId,factKey,oldId,newContent]));let id=baseId,attempt=0;
    while(this.withdrawn(id)){if(++attempt>16)throw new Error('同一事实已多次撤销，请重新核对');id=hash(JSON.stringify([baseId,evidence.sessionId??evidence.profileSource?.key,evidence.messageId??evidence.profileSource?.eventId,evidence.seq,attempt]));}
    return this.serial(async()=>{
      aborted(signal); this.selectStore(storeId,true);
      let row=this.journal.get(id);
      if(row?.stage==='committed'){
        if(this.journal.head(storeId,row.fact_key)!==row.new_id)throw new Error('此更正已被后续版本替代，请重新召回当前事实');
        const current=await this.client.show(storeId,row.new_id,signal);
        if(!current||current.content!==row.new_content)throw new Error('这次更正曾完成，但当前记录已变化，请重新核对');
        return this.receipt(row,true);
      }
      if(!row){
        const old=await this.client.show(storeId,oldId,signal);
        if(!old||old.content!==oldContent)throw new Error('旧记录已变化或失效，拒绝按过期内容更正');
        noSecret(JSON.stringify(old));
        row=this.journal.prepare({id,storeId,factKey,oldId,oldContent,newContent,oldSnapshot:old,evidence,reason});
      }
      try { return this.receipt(await this.advance(row,signal),false); }
      catch(error) { this.journal.failure(id,error,Boolean(signal?.aborted)); throw error; }
    },signal);
  }
  async advance(row,signal) {
    this.selectStore(row.store_id,true); aborted(signal);
    if(row.stage==='prepared'){
      const old=await this.client.show(row.store_id,row.old_id,signal);
      if(!old||old.content!==row.old_content)throw new Error('未完成更正的旧记录已改变，保留历史等待排查');
      const added=await this.client.remember(row.store_id,row.new_content,JSON.parse(row.old_snapshot),row.id,signal);
      if(added.id===row.old_id)throw new Error('新旧记录身份相同，拒绝作废');
      const written=await this.client.show(row.store_id,added.id,signal);
      if(!written||written.content!==row.new_content)throw new Error('新记录未通过读回核验，旧记录保持有效');
      this.journal.update(row.id,'written',added.id); row=this.journal.get(row.id);
    }
    aborted(signal);
    const current=await this.client.show(row.store_id,row.new_id,signal);
    if(!current||current.content!==row.new_content)throw new Error('新记录不再有效，暂停清理旧记录');
    this.selectStore(row.store_id,true);
    const old=await this.client.show(row.store_id,row.old_id,signal);
    if(old&&old.content!==row.old_content)throw new Error('旧记录核验失败，拒绝作废');
    if(old)await this.client.forget(row.store_id,row.old_id,signal);
    if(await this.client.show(row.store_id,row.old_id,signal))throw new Error('旧记录仍在正常查询中，纠错尚未完成');
    aborted(signal);
    return this.journal.commit(row.id);
  }
  receipt(row,replayed=false){return {status:'committed',operationId:row.id,storeId:row.store_id,factKey:row.fact_key,currentId:row.new_id,currentContent:row.new_content,replayed,summary:'更正已保存，旧记录已退出正常召回；历史可单独查询。'};}
  withdrawn(id){return Boolean(this.journal.db.prepare("SELECT 1 FROM sqlite_master WHERE name='protection_corrections'").get()&&this.journal.db.prepare('SELECT 1 FROM protection_corrections WHERE correction_id=?').get(id));}
  async recover(limit=10) {
    return this.serial(async()=>{
      const results=[];
      // Protected application steps own their retry checkpoints and snapshot
      // fence. Never advance them independently during Host startup.
      for(const row of this.journal.pending().filter(row=>!row.paused&&!JSON.parse(row.evidence).applicationId).slice(0,limit)){
        try{await this.advance(row);results.push({id:row.id,completed:true});}
        catch(error){this.journal.failure(row.id,error,false);results.push({id:row.id,completed:false});}
      }
      return results;
    });
  }
  history(storeId,factKey,limit=5,recordId){const store=this.selectStore(storeId);const key=recordId?this.journal.keyForRecord(store,uuid(recordId)):factKey===undefined?undefined:text(factKey,'factKey',160);return this.journal.history(store,key,Math.max(1,Math.min(10,Math.floor(limit)))).map(row=>({factKey:row.fact_key,previous:row.old_content,current:row.new_content,stage:row.stage,paused:Boolean(row.paused),at:row.created_at,evidence:JSON.parse(row.evidence)}));}
  status(){const pending=this.journal.pending();return {pending:pending.length,paused:pending.filter(row=>row.paused).length};}
  async close(){this.closed=true;await this.tail;this.journal.close();}
}
