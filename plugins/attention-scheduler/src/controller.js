import {reviewDecision} from './decision-review.js';
import {readDecisionState,intentState} from './status.js';
import {AttentionStore} from './store.js';
import {DecisionRunner,SerialExecutor} from './runtime.js';

import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');

export class SchedulerController {
  constructor({journal,now=()=>new Date(),config={},diagnostics=null,validateDecision,validateData=()=>{}}){
    if(typeof validateDecision!=='function')throw new Error('Scheduler requires a decision validator');Object.assign(this,{journal,now,validateDecision,validateData});this.store=new AttentionStore(journal,now,diagnostics);this.config={enabled:config.enabled??true,tickMs:2000,idleSeconds:config.idleSeconds??900,timeoutMs:config.timeoutMs??90000};
    if(typeof this.config.enabled!=='boolean'||!Number.isSafeInteger(this.config.idleSeconds)||this.config.idleSeconds<60||this.config.idleSeconds>86400)throw new Error('行为协调配置无效');
    this.host=null;this.choosing=null;this.work=new Map();this.closed=false;this.stop=new AbortController();this.lastError=null;this.lastEffectError=null;this.lastState=null;this.currentCall=null;this.planner=new DecisionRunner();this.admissions=new SerialExecutor();
  }
  enabled(){return this.config.enabled&&!this.closed;}
  bind(host){this.host=host;}
  safe(error){const value=String(error?.message??error).slice(0,500);try{this.validateData(value);return value;}catch{return '行为协调错误含敏感内容，未展示正文';}}
  offer(spec){return this.store.offer(spec);}
  status(){return {engine:{plugin:'@ai-friend/attention-scheduler',version:'0.3.0',library:'xstate',libraryVersion:'5.33.3',planning:this.planner.status(),admission:this.admissions.status()},enabled:this.enabled(),hostReady:Boolean(this.host),deciding:Boolean(this.choosing),running:this.store.running().map(this.brief),recent:this.store.recent().map(this.brief),lastError:this.lastError,lastEffectError:this.lastEffectError,decisions:this.store.db.prepare("SELECT status,count(*) n FROM attention_decisions GROUP BY status").all(),affect:this.host?.affectStatus?.()??null,decisionState:readDecisionState(this.store.db,this.now().valueOf()),scope:'全平台共享行为选择；未执行或未发送的意图不作为实际经历'};}
  brief(row){return {state:intentState(row),id:row.id,kind:row.kind,scope:row.scope,summary:row.summary,status:row.status,wake:row.wake,error:row.error,updatedAt:row.updated_at};}
  signal(kind){if(this.enabled())this.store.signal(kind);}
  async choose(signal){
    if(!this.enabled()||!this.host)return null;
    if(this.choosing)return this.choosing;
    const combined=AbortSignal.any([this.stop.signal,AbortSignal.timeout(this.config.timeoutMs),...(signal?[signal]:[])]);
    this.choosing=this.planner.run(actorSignal=>this.decide(AbortSignal.any([combined,actorSignal]))).finally(()=>{this.choosing=null;});return this.choosing;
  }
  async decide(signal){
    this.store.due();const meta=this.store.meta(),candidates=this.store.pending();
    if(meta.retry_at>this.now().valueOf()||!candidates.length||meta.considered===meta.epoch)return null;
    let eligible=candidates;
    // Only pure capability/resource checks belong here. No models or platform I/O.
    if(this.host.availability){
      eligible=[];
      for(const candidate of candidates){
        if(this.closed)return null;signal.throwIfAborted();let readiness,availabilityError=null;
        try{readiness=await this.host.availability(candidate,signal);}
        catch(error){if(signal.aborted)throw error;availabilityError=this.safe(error);}
        // An arrival or policy change invalidates even a failed availability check.
        if(this.closed||this.store.meta().epoch!==meta.epoch)return null;signal.throwIfAborted();
        const current=this.store.get(candidate.id);if(!current||!['pending','paused'].includes(current.status))continue;
        if(availabilityError){
          this.lastEffectError=availabilityError;
          this.store.patch(current.id,'waiting',{wake:{kind:'time',at:this.now().valueOf()+60000},error:availabilityError,result:{...current.result,waitSource:'resource',reason:'执行条件检查未完成，稍后重新核验；没有开始执行',notStarted:true}});
        }else if(readiness?.waiting){
          this.store.patch(current.id,'waiting',{wake:readiness.wake??{kind:'change'},result:{...current.result,waitSource:'resource',reason:readiness.reason??'当前执行能力不可用',...readiness.resource?{resource:readiness.resource}:{},notStarted:true}});
        }else eligible.push(current);
      }
      if(this.store.meta().epoch!==meta.epoch||!eligible.length)return null;
    }
    const state=await this.host.snapshot(signal);if(this.closed)return null;signal.throwIfAborted();const frame={...state,candidates:eligible.map(row=>{const preview=this.host.preview?.(row)??null;return {id:row.id,kind:row.kind,scope:row.scope,summary:row.summary,status:row.status,preview,...this.host.routing?{executionRouting:this.host.routing(row)}:{},...this.host.perception?{perception:this.host.perception(row,preview)}:{}};}),running:this.store.running().map(this.brief),execution:'选择不会直接发送文字；执行器按对象和隐私范围重建上下文。'};
    const call=this.store.begin(meta.epoch,frame);this.currentCall=call;
    try{
      const reviewed=await reviewDecision(this,{call,frame,state,meta,signal});if(this.closed||reviewed.stale)return null;const {answer,decision}=reviewed;signal.throwIfAborted();
      const stateFresh=!this.host.fresh||await this.host.fresh(state);if(this.closed)return null;signal.throwIfAborted();
      if(this.store.meta().epoch!==meta.epoch||!stateFresh){this.store.finish(call,'stale',answer);return null;}
      this.journal.transaction(()=>{
        for(const change of decision.updates)this.store.patch(change.id,change.action==='dismiss'?'dismissed':'waiting',{wake:change.wake,result:{reason:change.reason,waitSource:change.action==='defer'?'model':'dismissed'}});
        if(decision.action==='start')this.store.patch(decision.targetId,'selected',{result:{reason:decision.reason,decisionEpoch:meta.epoch,...decision.executionTarget?{executionTarget:decision.executionTarget}:{}}});
        this.store.db.prepare('UPDATE attention_meta SET considered=?,retry_at=0 WHERE id=1').run(meta.epoch);this.store.finish(call,'committed',{...answer,decision});
      });
      // Optional emotion proposals cannot invalidate an already committed behaviour choice.
      try{this.host.afterDecision?.({frame,decision,call});this.lastEffectError=null;}catch(error){this.lastEffectError=this.safe(error);}
      // Invoke synchronous decision effects before stamping the resulting epoch.
      // Later asynchronous effects and real arrivals must still invalidate it.
      const dismissals=[];
      for(const change of decision.updates)if(change.action==='dismiss')try{dismissals.push(Promise.resolve(this.host.dismiss?.(this.store.get(change.id))).catch(error=>{this.lastEffectError=this.safe(error);}));}catch(error){this.lastEffectError=this.safe(error);}
      // A suggestion becomes a future candidate, not an immediate unreviewed action.
      if(this.host.captureSuggestions){try{this.host.captureSuggestions({frame,decision,call});}catch(error){this.lastEffectError=this.safe(error);}}
      else for(const suggestion of decision.suggestions){const key='idea:'+hash(JSON.stringify([suggestion.kind,suggestion.topic]));this.offer({key,kind:suggestion.kind,scope:'internal',summary:suggestion.topic,payload:{topic:suggestion.topic,reason:suggestion.reason}});}
      const committedEpoch=this.store.meta().epoch;
      this.journal.transaction(()=>{
        const selected=decision.action==='start'?this.store.get(decision.targetId):null;
        if(selected?.status==='selected')this.store.patch(selected.id,'selected',{result:{...selected.result,decisionEpoch:committedEpoch}});
        this.store.db.prepare('UPDATE attention_meta SET considered=? WHERE id=1').run(committedEpoch);
      });
      await Promise.all(dismissals);if(this.closed)return null;signal.throwIfAborted();
      this.lastError=null;return decision.action==='start'?this.store.get(decision.targetId):null;
    }catch(error){this.lastError=this.safe(error);if(this.closed)return null;this.store.finish(call,signal.aborted?'interrupted':'failed',{decision:null,usage:error.reviewUsage??null},this.lastError);this.store.db.prepare('UPDATE attention_meta SET retry_at=? WHERE id=1').run(this.now().valueOf()+60000);return null;}finally{if(this.currentCall===call)this.currentCall=null;}
  }
  async admit(spec,signal){
    if(!this.enabled())return true;
    let row=this.offer(spec);
    if(['selected','waking'].includes(row.status))return this.enterMessage(row,signal);
    if(['running','completed','dismissed','cancelled','failed'].includes(row.status))return false;
    const selected=await this.choose(signal);
    if(selected?.id===row.id)return this.enterMessage(selected,signal);
    if(selected)void this.dispatch(selected);
    return false;
  }
  startSerial(fn){return this.admissions.run(fn);}
  get startTail(){return this.admissions.idle();}
  async prepare(row,signal){
    if(this.closed)return false;
    if(!['selected','admitting'].includes(this.store.get(row.id)?.status))return false;
    const readiness=await this.host.beforeStart?.(row,signal);if(this.closed)return false;signal?.throwIfAborted();
    if(readiness?.waiting){this.store.patch(row.id,'waiting',{wake:readiness.wake??{kind:'task_end'},result:{...row.result,waitSource:'resource',reason:readiness.reason??'执行资源尚未到可切换点，结束后重新判断',...readiness.resource?{resource:readiness.resource}:{}}});if(readiness.resource)this.signal('resource_blocked');return false;}
    const current=this.store.get(row.id);
    if(!current||!['selected','admitting'].includes(current.status))return false;
    if(current?.result?.decisionEpoch!==undefined&&current.result.decisionEpoch!==this.store.meta().epoch){this.store.patch(row.id,'pending',{result:{reason:'准备执行期间有新事件，重新判断'}});return false;}
    return true;
  }
  enterMessage(row,signal){
    this.store.patch(row.id,'admitting');
    return this.startSerial(async()=>{try{if(!await this.prepare(row,signal)||this.store.get(row.id)?.status!=='admitting')return false;this.store.patch(row.id,'running');return true;}catch(error){if(this.closed)return false;this.store.patch(row.id,'waiting',{wake:{kind:'time',at:this.now().valueOf()+60000},error:this.safe(error)});return false;}});
  }
  dispatch(row){
    if(this.closed)return Promise.resolve();
    if(this.work.has(row.id)){
      if(row.kind==='browse'&&this.store.get(row.id)?.status==='selected')void this.startSerial(async()=>{if(!await this.prepare(row,this.stop.signal))return;this.store.patch(row.id,'running');this.host.resume?.(row);}).catch(error=>{this.lastError=this.safe(error);});
      return this.work.get(row.id);
    }
    if(this.store.get(row.id)?.status!=='selected')return Promise.resolve();
    const work=(async()=>{try{
      const prepared=await this.startSerial(async()=>{if(!await this.prepare(row,this.stop.signal))return false;this.store.patch(row.id,row.kind==='message'?'waking':'running');return true;});
      if(!prepared)return;
      const result=await this.host.execute(row,this.stop.signal);
      if(result?.pending)return;
      this.complete(row.id,result);
    }catch(error){this.lastError=this.safe(error);this.store.patch(row.id,this.closed?'pending':'failed',{error:this.lastError});this.signal('task_end');}
    })().finally(()=>this.work.delete(row.id));this.work.set(row.id,work);return work;
  }
  complete(id,result={}){const row=this.store.get(id);if(!row||this.store.terminal(id))return;this.store.patch(id,'completed',{result});this.signal('task_end');try{this.host?.afterComplete?.(this.store.get(id));}catch(error){this.lastEffectError=this.safe(error);}}
  cancelSession(sessionId){for(const row of this.store.recent(1000))if(row.kind==='message'&&row.payload.sessionId===sessionId&&!this.store.terminal(row.id))this.store.patch(row.id,'cancelled',{result:{reason:'主用户停止当前会话的待处理回应'}});}
  finishMessage(sessionId,turn,result){for(const row of this.store.running())if(row.kind==='message'&&row.payload.sessionId===sessionId&&row.payload.turn===turn)this.complete(row.id,result);}
  tick(){
    if(this.ticking)return this.ticking;
    this.ticking=this.tickOnce().finally(()=>{this.ticking=null;});return this.ticking;
  }
  async tickOnce(){
    if(!this.enabled()||!this.host)return;
    const stateKey=this.host.stateKey?.();if(this.lastState!==null&&stateKey!==this.lastState)this.signal('state_change');this.lastState=stateKey;
    this.store.due();await this.host.collect?.();if(this.closed)return;
    const selected=this.store.running().find(row=>row.status==='selected');if(selected&&!this.work.has(selected.id)){void this.dispatch(selected);return;}
    const next=await this.choose();if(next)void this.dispatch(next);
  }
  async close(){if(this.closing)return this.closing;this.closed=true;this.stop.abort(new Error('行为协调服务停止'));if(this.currentCall)this.store.db.prepare("UPDATE attention_decisions SET status='interrupted',error=? WHERE id=? AND status='thinking'").run('调度插件停止；未执行的决策不会重放',this.currentCall);this.store.db.prepare("UPDATE attention_attempts SET status='interrupted',error='调度插件停止',finished_at=? WHERE decision_id=? AND status='running'").run(this.store.time(),this.currentCall??'');this.admissions.close();this.planner.close();this.closing=(async()=>{await Promise.allSettled([this.ticking,this.choosing,...this.work.values()].filter(Boolean));await this.host?.closeEffects?.();})();return this.closing;}
}
