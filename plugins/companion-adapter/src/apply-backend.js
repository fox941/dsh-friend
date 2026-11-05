import {noSecret,aborted} from './validation.js';
import {ProfileChangeStore} from './profile-change-store.js';
export class ApplyBackend{
  constructor({runtime,correction,growth}){Object.assign(this,{runtime,correction,growth});}
  profileStore(){return this.profileChangeStore??=new ProfileChangeStore(this.correction.journal);}
  async reference(ref,signal){
    if(ref.kind==='runtime'){
      const before=await this.runtime.before(ref,signal);return {...ref,importance:before.importance};
    }
    if(ref.kind==='native'){
      this.correction.selectStore(ref.storeId,true);const record=await this.correction.client.showReadOnly(ref.storeId,ref.recordId,signal);
      if(!record||record.content!==ref.text||ref.createdAt&&record.created_at!==ref.createdAt)throw new Error('长期引用已失效或被更正，请重新预演');
      noSecret(JSON.stringify(record));return {...ref,category:record.category,importance:record.importance};
    }
    if(ref.kind==='self'){
      const id=ref.id.slice(5),state=this.growth.store.version(id);
      if(!state||this.growth.store.head(state.key)?.id!==id)throw new Error('报告中的自我状态已变化，请重新预演');
      return {...ref,status:this.growth.store.usable(state)?state.status:'needs_review'};
    }
    throw new Error('应用暂不支持该记忆来源');
  }
  async prepare(operation,signal){
    const result={...operation};
    if(operation.kind.startsWith('runtime_')&&operation.reference)result.before=await this.runtime.before(operation.reference,signal);
    if(operation.kind==='review_self'){
      const state=this.growth.store.version(operation.reference.id.slice(5));
      if(!state||this.growth.store.head(state.key)?.id!==state.id)throw new Error('待复核状态在准备时已变化');
      result.stateBefore={id:state.id,key:state.key};
    }
    return result;
  }
  async nativeCurrent(store,id,content,signal){
    this.correction.selectStore(store);const row=await this.correction.client.showReadOnly(store,id,signal);return Boolean(row&&row.content===content);
  }
  async addNative(step,operation,store,signal){
    const content=operation.kind==='runtime_archive'?operation.before.content:operation.content;
    return this.correction.serial(async()=>{
      const existing=step.status==='writing'?this.correction.client.findExact(operation.storeId,content):null;
      if(existing)return {nativeId:existing,storeId:operation.storeId,content,verified:true,reconciled:true};
      const beforeRevision=this.correction.client.readRevision(operation.storeId);
      if(step.status==='writing'&&step.receipt?.beforeNativeRevision!==beforeRevision)throw new Error('上次新增结果不明且长期空间已有变化，拒绝盲目重写');
      store.step(step.id,'writing',{beforeNativeRevision:beforeRevision});
      const result=await this.correction.client.remember(operation.storeId,content,{category:'context',importance:operation.before?.importance==='low'?2:3,tags:[],entities:[]},step.id,signal,operation.kind==='runtime_archive'?'friend-archive':'friend-apply');
      if(!await this.nativeCurrent(operation.storeId,result.id,content,signal))throw new Error('新增目标未通过读回核对，保留原始来源');
      const receipt={nativeId:result.id,storeId:operation.storeId,content,verified:true,reconciled:result.action==='skipped'};
      store.step(step.id,'written',receipt);return receipt;
    },signal);
  }
  async execute(step,run,store,signal){
    const operation=step.operation;aborted(signal);
    if(['runtime_add','runtime_replace','runtime_remove'].includes(operation.kind)){
      const signature=await this.runtime.signature(signal);
      if(step.status==='writing'&&!await this.runtime.current(operation,signal)&&signature!==step.receipt?.beforeRuntimeSignature)throw new Error('上次常驻结果不明且资料已有变化，拒绝盲目重写');
      if(step.status==='prepared')store.step(step.id,'writing',{beforeRuntimeSignature:signature});
      return this.runtime.write(operation,signal);
    }
    if(operation.kind==='native_correct'){
      if(step.status==='prepared')store.step(step.id,'writing',{intent:'verified-native-correction'});
      const evidence=operation.evidence.map(item=>({item,source:run.frame.sources.find(row=>row.id===item.sourceId)})).find(row=>row.source?.kind==='user_message'||run.approval?.kind==='profile_change'&&row.source?.kind==='profile_change_source');
      if(!evidence)throw Error('更正缺少已核验的主用户原话');
      const authority=evidence.source.kind==='profile_change_source'?{kind:'verified-profile-change',profileSource:{key:evidence.source.origin.key,channel:evidence.source.origin.channel,eventId:evidence.source.origin.eventId}}:{sessionId:evidence.source.sessionId,messageId:evidence.source.messageId,seq:evidence.source.seq,kind:'verified-historical-application'};
      const receipt=await this.correction.correct({storeId:operation.reference.storeId,oldId:operation.reference.recordId,expectedOldContent:operation.reference.text,newContent:operation.content,reason:operation.reason},{owner:true,...authority,quote:evidence.item.quote,applicationId:run.id,approval:run.approval},signal);
      return {verified:true,storeId:receipt.storeId,currentId:receipt.currentId,content:receipt.currentContent,correctionId:receipt.operationId,reconciled:receipt.replayed};
    }
    if(operation.kind==='native_forget'){
      const {storeId,recordId,text}=operation.reference;this.correction.selectStore(storeId,true);
      const current=await this.correction.client.showReadOnly(storeId,recordId,signal);
      if(!current){if(!['writing','written'].includes(step.status))throw new Error('撤回目标已失效，拒绝按旧计划继续');return {verified:true,storeId,forgottenId:recordId,reconciled:true};}
      if(current.content!==text||operation.reference.createdAt&&operation.reference.createdAt!==current.created_at)throw new Error('撤回目标已改变，保留后来内容');
      store.step(step.id,'writing',{storeId,forgottenId:recordId});
      await this.correction.client.forget(storeId,recordId,signal);
      if(await this.correction.client.showReadOnly(storeId,recordId,signal))throw new Error('长期撤回尚未通过读回核验');
      return {verified:true,storeId,forgottenId:recordId,reconciled:false};
    }
    if(operation.kind==='native_add'){
      const receipt=step.status==='written'&&step.receipt?.nativeId?step.receipt:await this.addNative(step,operation,store,signal);
      if(!await this.nativeCurrent(operation.storeId,receipt.nativeId,operation.content,signal))throw new Error('已写入的经历后来发生变化，未重新新增旧内容');
      return {...receipt,currentId:receipt.nativeId};
    }
    if(operation.kind==='profile_transition')return this.profileStore().apply(operation,run,store,this.runtime,signal);
    if(operation.kind==='runtime_archive'){
      let receipt=step.receipt;
      if(!receipt?.nativeId){
        receipt={...await this.addNative(step,operation,store,signal),archiveVerified:true};store.step(step.id,'written',receipt);
      }
      return this.correction.serial(async()=>{
        if(!await this.nativeCurrent(receipt.storeId,receipt.nativeId,operation.before.content,signal))throw new Error('转存目标已变化，拒绝移出常驻');
        const removed=await this.runtime.write(operation,signal);return {...receipt,verified:true,runtime:removed};
      },signal);
    }
    if(operation.kind==='review_self'){
      return store.journal.transaction(()=>{
        const currentStep=store.steps(run.id).find(row=>row.id===step.id);if(currentStep.status==='applied')return currentStep.receipt;
        const state=this.growth.store.head(operation.stateBefore.key);
        if(state?.id!==operation.stateBefore.id)throw new Error('自我状态版本已变化，保留待处理复核，不覆盖新认识');
        const changes=[];
        if(this.growth.store.usable(state)){
          const next=this.growth.store.put({...state,status:'needs_review',reason:`源事实应用后需要复核：${operation.reason}`,batchId:`apply:${run.id}`});
          changes.push({key:state.key,previousId:state.id,currentId:next.id});
          changes.push(...this.growth.store.invalidate(state.key,`apply:${run.id}`));this.growth.store.advanceRevision();
          for(const ref of operation.becauseRefs)store.link(run.id,step.id,ref,state.id,next.id,operation.reason);
        }
        const result={verified:true,changes,revision:this.growth.store.revision()};store.step(step.id,'applied',result);return result;
      });
    }
    throw new Error('不支持的应用操作');
  }
  async current(step,signal){
    const operation=step.operation,receipt=step.receipt;if(!receipt?.verified)return false;
    if(operation.kind==='profile_transition')return this.profileStore().current(receipt);
    if(operation.kind==='review_self')return receipt.changes.every(row=>this.growth.store.head(row.key)?.id===(row.currentId??row.versionId));
    if(['runtime_add','runtime_replace','runtime_remove'].includes(operation.kind))return this.runtime.current(operation,signal);
    if(operation.kind==='native_forget')return !await this.correction.client.showReadOnly(receipt.storeId,receipt.forgottenId,signal);
    if(operation.kind==='runtime_archive')return await this.nativeCurrent(receipt.storeId,receipt.nativeId,operation.before.content,signal)&&await this.runtime.current(operation,signal);
    return this.nativeCurrent(receipt.storeId,receipt.currentId,operation.content,signal);
  }
}
