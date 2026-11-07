import {NightlyStore,shanghaiDay} from './nightly-store.js';
import {resumableNightly,nightlyRequestKey,nightlyIntentKey,matchesNightlyIntent} from './nightly-protocol.js';
import {noSecret,hash,aborted,uuid} from './validation.js';
import {ReviewTrace} from './review-trace.js';
import {nightlyDiagnosis} from './nightly-diagnosis.js';
const safeError=error=>{const value=String(error?.message??error).slice(0,650);try{noSecret(value);return value;}catch{return '失败诊断中疑似敏感内容已省略';}};
function bounded(value,fallback,min,max){const n=value??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('夜间整理配置超出范围');return n;}
export function nightlyConfig(config={}){
  if(!config||typeof config!=='object'||Array.isArray(config)||config.enabled!==undefined&&typeof config.enabled!=='boolean')throw new Error('夜间整理配置不正确');
  const time=config.time??'02:00';if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||config.timeZone!==undefined&&config.timeZone!=='Asia/Shanghai')throw new Error('夜间整理使用 Asia/Shanghai 时区及 HH:mm 时刻');
  return {enabled:config.enabled??false,time,timeZone:'Asia/Shanghai',tickSeconds:bounded(config.tickSeconds,30,5,60),idleSeconds:bounded(config.idleSeconds,60,1,600),dailyCallLimit:bounded(config.dailyCallLimit,8,0,12),maxBatches:bounded(config.maxBatches,2,1,4),runTimeoutMs:bounded(config.runTimeoutMs,300000,1000,300000),retryLimit:bounded(config.retryLimit,1,0,2),retryDelaySeconds:bounded(config.retryDelaySeconds,120,1,3600)};
}
export class NightlyController{
  constructor({journal,preview,applications,manualPreview,growth,policy,authority,config={},now=()=>new Date()}){
    Object.assign(this,{journal,preview,applications,manualPreview,growth,policy,authority,now});this.config=nightlyConfig(config);this.store=new NightlyStore(journal,this.config,now);this.active=null;this.host=null;this.closed=false;this.lastActivity=now().getTime();this.lastDriveError=null;
  }
  writable(){if(this.closed||!this.config.enabled||!this.policy().writeEnabled||!this.preview.config.enabled||!this.applications.config.enabled)throw new Error('当前没有启用可写的夜间整理');}
  bind(host){this.host=host;this.lastActivity=this.now().getTime();}
  status(id){
    const row=id?this.store.get(uuid(id)):null,c=this.store.control(),chosen=row?.id??this.active?.id??this.store.recent(1)[0]?.id,socialMaintenance=chosen?this.store.batches(chosen).find(b=>b.position===0)?.result?.socialMaintenance??null:null;return {socialMaintenance,diagnosis:nightlyDiagnosis(this,chosen),enabled:this.store.enabled(),hostReady:Boolean(this.host),schedule:{timeZone:'Asia/Shanghai',time:this.config.time,nextDue:new Date(c.next_due).toISOString()},paused:c.enabled_override===0,pauseReason:c.reason,running:this.active?{runId:this.active.id,jobId:this.active.jobId??null}:null,callsToday:this.store.calls(),callsRemaining:Math.max(0,this.config.dailyCallLimit-this.store.calls()),maxBatches:this.config.maxBatches,runTimeoutMs:this.config.runTimeoutMs,preview:this.preview.status(),idleSeconds:this.config.idleSeconds,lastError:this.lastDriveError,recent:this.store.recent(),...row?{run:{...row,authorization_json:undefined},batches:this.store.batches(row.id)}:{},...this.materials?{materialsOverview:this.materials.status()}:{},summary:'后台只处理有来源的增量整理，不生成虚构经历；无新交流不请求审核模型。'};
  }
  foreground(){if(this.attention?.enabled())return;this.lastActivity=this.now().getTime();this.active?.stop.abort(Object.assign(new Error('前台交流优先，整理让路'),{code:'NIGHTLY_YIELD'}));}
  control(args,caller){
    if(!caller?.owner||!caller.sessionId||!caller.messageId||!caller.quote)throw new Error('整理控制需要本轮主用户的原话');noSecret(JSON.stringify(caller));
    const authorization={...caller,kind:'nightly-control',action:args.action,at:this.store.time()};
    if(args.action==='pause'){this.store.setEnabled(false,'主用户暂停夜间整理');this.store.cancelQueued('主用户暂停');this.active?.stop.abort(Object.assign(new Error('主用户暂停'),{code:'NIGHTLY_CANCEL'}));return {status:'paused',...this.status()};}
    if(args.action==='cancel'){this.store.cancelQueued('主用户取消待执行整理');this.active?.stop.abort(Object.assign(new Error('主用户取消本次整理'),{code:'NIGHTLY_CANCEL'}));return {status:'cancel_requested',...this.status()};}
    this.writable();
    if(args.action==='resume'){this.store.setEnabled(true,'主用户恢复夜间整理');return {status:'resumed',...this.status()};}
    if(args.action==='run'){const row=this.store.queue(`manual:${hash(JSON.stringify([caller.sessionId,caller.messageId]))}`,'manual',authorization);return {status:row.status,runId:row.id,summary:'已加入整理队列，本轮交流结束并空闲后执行；自动日程开关保持原设置。'};}
    if(args.action==='retry'){const row=this.store.retryExplicit(uuid(args.runId),authorization);return {status:row.status,runId:row.id,repeated:row.repeated===true,summary:row.repeated?'这条原请求已有重试记录，未再次重置进度或额度。':'已按原检查点安排重试，先核对已发生的步骤。'};}
    throw new Error('未知的夜间整理控制动作');
  }
  idle(){if(this.attention?.enabled())return Boolean(this.host);return this.host&&!this.host.foregroundBusy()&&this.now().getTime()-this.lastActivity>=this.config.idleSeconds*1000;}
  check(active,signal){aborted(signal);this.writable();if(!this.idle())throw Object.assign(new Error('前台交流尚未空闲，整理延期'),{code:'NIGHTLY_YIELD'});if(this.store.control().revision!==active.revision)throw Object.assign(new Error('整理控制已变化，本次停止'),{code:'NIGHTLY_CANCEL'});}
  offerAttention(run){
    const token=nightlyRequestKey(run.authorization),store=this.attention.store,legacy=store.byKey('nightly:'+run.id);
    let intent=store.byKey(nightlyIntentKey(run));
    if(!intent&&legacy&&matchesNightlyIntent(legacy,run)){
      if(['dismissed','cancelled'].includes(legacy.status)){this.store.state(run.id,'cancelled','原选择已经放下或取消，未自动恢复');return legacy;}
      if(!store.terminal(legacy.id)){store.updatePayload(legacy.id,{...legacy.payload,requestKey:token});intent=store.get(legacy.id);}
    }
    if(!intent)intent=this.attention.offer({key:nightlyIntentKey(run),kind:'nightly',scope:'internal',summary:'增量整理候选：整理近期真实经历，可延后、分批或不开展',payload:{runId:run.id,requestKey:token}});
    else if(['dismissed','cancelled'].includes(intent.status))this.store.state(run.id,'cancelled','原选择已经放下或取消，未自动恢复');
    else if(['completed','failed'].includes(intent.status)&&intent.result?.runId===run.id&&resumableNightly.has(intent.result?.status)&&resumableNightly.has(run.status)){
      store.patch(intent.id,'pending',{reconcile:true,result:{...intent.result,reason:'已核对原任务仍待继续，保留检查点后重新选择'}});this.attention.signal('event');intent=store.get(intent.id);
    }
    return intent;
  }
  parkAttention(intent,run,result={}){
    const at=Math.max(run.not_before||0,this.now().valueOf()+(run.not_before>this.now().valueOf()?0:this.config.idleSeconds*1000)),reason=run.error??result.error??'整理执行条件未就绪，保留原检查点后重新考虑';
    this.attention.store.patch(intent.id,'waiting',{wake:{kind:'time',at},result:{...result,status:run.status,runId:run.id,notBefore:run.not_before,waitSource:'resource',reason},error:['retry_wait','interrupted'].includes(run.status)?run.error:null});
    return {pending:true,runId:run.id,status:run.status};
  }
  async executeAttention(intent,signal){
    let run=this.store.get(intent.payload.runId);if(!matchesNightlyIntent(intent,run))return {status:'source_changed',runId:intent.payload.runId};
    if(!resumableNightly.has(run.status))return {status:run.status,runId:run.id};
    if(signal?.aborted||run.not_before>this.now().valueOf()||run.trigger!=='manual'&&!this.store.enabled())return this.parkAttention(intent,run);
    let result;this.attentionGrant=run.id;try{result=await this.drive(signal);}finally{this.attentionGrant=null;}
    run=this.store.get(run.id);if(!matchesNightlyIntent(intent,run))return {status:'source_changed',runId:intent.payload.runId};
    if(resumableNightly.has(run.status)||run.status==='running')return this.parkAttention(intent,run,result);
    return {...result,status:run.status,runId:run.id};
  }
  async drive(signal){
    if(this.closed||!this.host||this.active||!this.config.enabled||!this.policy().writeEnabled||!this.idle()||this.manualPreview.active||this.applications.active||this.growth.inflight?.size||this.growth.emotions?.inflight)return {status:'waiting'};
    this.recheckSocialBudgetWait();this.recheckNightlyBudgetWait();this.store.due();const next=(this.attentionGrant?this.store.get(this.attentionGrant):null)??this.store.pending();if(!next)return {status:'not_due'};
    if(this.attention?.enabled()&&this.attentionGrant!==next.id){this.offerAttention(next);return {status:'attention_waiting',runId:next.id};}
    const row=this.store.claim(next.id);if(!row)return {status:'busy'};
    const stop=new AbortController(),active={id:row.id,stop,revision:this.store.control().revision,promise:null,jobId:null};this.active=active;
    const onStop=()=>stop.abort(Object.assign(new Error('调度宿主停止，保留整理检查点'),{code:'NIGHTLY_STOP'}));signal?.addEventListener('abort',onStop,{once:true});if(signal?.aborted)onStop();
    const timeout=setTimeout(()=>stop.abort(Object.assign(new Error('单次夜间整理达到时间预算'),{code:'NIGHTLY_TIMEOUT'})),this.config.runTimeoutMs);
    const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',onStop);if(this.active===active)this.active=null;};
    const work=()=>this.execute(row,active,stop.signal).finally(cleanup);
    let resolve,reject;active.promise=new Promise((a,b)=>{resolve=a;reject=b;});
    try{
      active.jobId=this.host.startJob({run:()=>({cancel:async()=>{stop.abort(Object.assign(new Error('任务控制取消整理'),{code:'NIGHTLY_CANCEL'}));await active.promise;},done:work().then(result=>{resolve(result);return {status:['cancelled','yielded'].includes(result.status)?'killed':['failed','needs_attention'].includes(result.status)?'failed':'completed',detail:result.status};},error=>{reject(error);return {status:'failed',detail:safeError(error)};})})});
    }catch(error){cleanup();this.store.retry(row.id,safeError(error));resolve({status:'failed'});throw error;}
    return active.promise;
  }
  async review(role,row,active,snapshot,signal,onProgress){
    this.check(active,signal);const id=this.store.beginCall(row.id,role),trace=new ReviewTrace();
    try{
      const result=await new Promise((resolve,reject)=>{
        const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        Promise.resolve().then(()=>{const progress=event=>{trace.progress(event);onProgress?.(event);};return role==='preview-repair'?this.host.repairPreview(snapshot,signal,progress):this.host.review(role,snapshot,signal,progress);}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
      });
      aborted(signal);this.store.endCall(id,result,null,trace.snapshot());return result;
    }
    catch(error){this.store.endCall(id,null,safeError(error),trace.snapshot());throw error;}
  }
  recheckSocialBudgetWait(){
    if(this.store.calls()>=this.config.dailyCallLimit||this.preview.store.budget()>=this.preview.config.dailyCallLimit)return;
    const rows=this.journal.db.prepare("SELECT id FROM nightly_runs WHERE status='budget_exhausted' AND error=? ORDER BY rowid LIMIT 4").all('QQ社交整理今日审核额度用完，增量游标保留');
    for(const {id}of rows){const run=this.store.get(id);let intent;
      if(this.attention?.enabled()){
        intent=this.attention.store.byKey(nightlyIntentKey(run));
        if(!matchesNightlyIntent(intent,run)||intent.status!=='waiting'||intent.result?.waitSource!=='resource')continue;
      }
      const reason='原等待仅由独立QQ社交整理额度造成；子任务延期，主流程按自身额度重新选择';
      this.store.state(id,'interrupted',reason);
      if(intent){this.attention.store.patch(intent.id,'pending',{result:{...intent.result,status:'interrupted',notBefore:0,waitSource:'resource_rechecked',reason}});this.attention.signal('event');}
    }
  }
  recheckNightlyBudgetWait(){
    if(!this.preview.config.enabled||!this.applications.config.enabled||this.store.calls()>=this.config.dailyCallLimit||this.applications.store.calls()>=this.applications.config.dailyCallLimit)return;
    // Reconsider only a proven application wait on this controller's own quota.
    // A coincidentally exhausted quota must never reopen an unrelated failure.
    const message='提案应用审核未完成：今日夜间整理模型额度已用完';
    const rows=this.journal.db.prepare("SELECT id FROM nightly_runs WHERE status='budget_exhausted' AND error=? ORDER BY rowid LIMIT 4").all(message);
    for(const {id}of rows){
      const run=this.store.get(id),batch=this.store.batches(id).find(b=>b.status!=='completed');
      const report=batch?.report_id?this.preview.store.get(batch.report_id):null;
      if(report?.status!=='completed'||!report.result?.decision?.proposals.length)continue;
      const key=hash(JSON.stringify([report.id,report.result.decision.proposals.map((_p,index)=>index)])),application=this.applications.store.bySelection(key);
      if(application?.plan)continue;
      let intent;if(this.attention?.enabled()){
        intent=this.attention.store.byKey(nightlyIntentKey(run));
        if(!matchesNightlyIntent(intent,run)||intent.status!=='waiting'||intent.result?.waitSource!=='resource'||intent.result?.runId!==run.id||intent.wake?.kind!=='time'||intent.wake.at!==run.not_before)continue;
      }
      const reason='夜间整理调用额度现已可用，保留原报告、授权和计数后重新选择应用审核';
      this.journal.transaction(()=>{
        this.store.state(id,'interrupted',reason);
        if(intent)this.attention.store.patch(intent.id,'pending',{result:{...intent.result,status:'interrupted',notBefore:0,waitSource:'resource_rechecked',reason}});
      });
      if(intent)this.attention.signal('event');
    }
  }
  async socialStep(row,active,signal){
    if(!this.host.socialMaintenance)return;
    const batch=this.store.batches(row.id).find(b=>b.position===0),prior=batch?.result?.socialMaintenance,day=shanghaiDay(this.now().getTime());
    if(prior&&(prior.status==='completed'||prior.checkedDay===day))return;
    const result=await this.host.socialMaintenance(row.id,signal);
    if(result?.status==='busy')throw Object.assign(new Error('QQ社交记忆仍在审核，整理稍后继续'),{code:'NIGHTLY_YIELD'});
    if(!result)return;
    if(!['completed','partial','disabled','budget_exhausted'].includes(result.status))throw new Error('QQ社交整理返回未知状态，保留原检查点');
    const checkpoint={status:result.status,checkedDay:day,checkedAt:this.store.time(),scanned:Number.isSafeInteger(result.scanned)?result.scanned:null,changed:Number.isSafeInteger(result.changed)?result.changed:null,deferred:result.status==='budget_exhausted'||result.status==='partial'};
    this.store.batch(row.id,0,batch?.status??'maintenance_checked',{result:{...batch?.result,socialMaintenance:checkpoint}});
    this.check(active,signal);
  }
  async execute(row,active,signal){
    try{
      this.check(active,signal);
      await this.socialStep(row,active,signal);
      this.check(active,signal);

      for(let position=0;position<this.config.maxBatches;position++){
        this.check(active,signal);let batch=this.store.batches(row.id).find(item=>item.position===position);
        if(batch?.status==='completed')continue;
        let report=batch?.report_id?this.preview.store.get(batch.report_id):null;
        if(!report||!['completed','empty'].includes(report.status)){
          this.store.batch(row.id,position,'previewing');
          const reviewer=(snapshot,reviewSignal,onProgress)=>this.review('preview',row,active,snapshot,reviewSignal,onProgress);
          if(typeof this.host.repairPreview==='function'){
            reviewer.repair=(request,reviewSignal,onProgress)=>this.review('preview-repair',row,active,request,reviewSignal,onProgress);
            reviewer.repair.available=()=>this.store.calls()<this.config.dailyCallLimit;
          }
          const result=await this.preview.runMaintenance(this.authority,this.host.persistence,reviewer,signal,reportId=>this.store.batch(row.id,position,'previewing',{reportId}));
          this.check(active,signal);
          if(result.status==='busy')throw Object.assign(new Error('预演正在使用，稍后继续'),{code:'NIGHTLY_YIELD'});
          if(result.status==='budget_exhausted')throw Object.assign(new Error('预演今日额度已用完'),{code:'NIGHTLY_BUDGET'});
          if(!['completed','empty','no_new_events'].includes(result.status))throw new Error(`后台预演尚未完成：${result.status}`);
          this.preview.store.touch(result.sourceProgress??[]);
          if(result.status==='no_new_events'){
            this.store.batch(row.id,position,'completed',{result:{status:'no_new_events',deferredSessions:result.deferredSessions??0}});
            if((result.deferredSessions??0)>0)continue;
            this.store.state(row.id,'completed');return {status:'completed',runId:row.id};
          }
          report=this.preview.store.get(result.reportId);this.store.batch(row.id,position,'report_saved',{reportId:report.id,result:{previewStatus:report.status}});
        }
        if(report.status==='completed'&&report.result.decision.proposals.length){
          const proposals=report.result.decision.proposals,key=hash(JSON.stringify([report.id,proposals.map((_row,index)=>index)]));
          if(proposals.some(item=>!['keep','duplicate','conflict','defer'].includes(item.action))&&!this.applications.store.bySelection(key)?.plan&&this.applications.store.calls()>=this.applications.config.dailyCallLimit)throw Object.assign(new Error('应用审核今日额度已用完，保留报告等待下一日'),{code:'NIGHTLY_BUDGET'});
          this.check(active,signal);this.store.batch(row.id,position,'applying',{reportId:report.id});
          const applied=await this.applications.runMaintenance(this.authority,{reportId:report.id},row.id,this.host.persistence,(snapshot,reviewSignal,onProgress)=>this.review('apply',row,active,snapshot,reviewSignal,onProgress),signal);
          this.store.batch(row.id,position,'application_saved',{applicationId:applied.applicationId,result:{status:applied.status,applied:applied.applied,pendingOperations:applied.pendingOperations??0}});
          aborted(signal);
          if(applied.status==='busy')throw Object.assign(new Error('前台正在应用记忆，后台稍后继续'),{code:'NIGHTLY_YIELD'});
          if(applied.pendingOperations>0||['failed','stale','cancelled','interrupted','backup_blocked'].includes(applied.status)){
            this.store.state(row.id,'needs_attention',applied.error??'应用有未完成步骤，需查询原回执后明确重试');return {status:'needs_attention',runId:row.id};
          }
          if(!['completed','historical','partial','deferred','no_changes'].includes(applied.status))throw new Error(`应用结果需要核对：${applied.status}`);
        }
        this.store.batch(row.id,position,'completed',{reportId:report.id});
        const sources=report.snapshot.sources,more=sources.deferredSessions>0||sources.ranges.some(range=>range.limited);
        if(!more)break;
      }
      this.store.state(row.id,'completed');return {status:'completed',runId:row.id};
    }catch(error){
      const message=safeError(error),code=signal.aborted?signal.reason?.code:error?.code;
      if(code==='NIGHTLY_YIELD'||code==='NIGHTLY_TIMEOUT')this.store.state(row.id,'yielded',message,this.now().getTime()+this.config.idleSeconds*1000);
      else if(code==='NIGHTLY_STOP')this.store.state(row.id,'interrupted',message);
      else if(code==='NIGHTLY_CANCEL'||this.closed)this.store.state(row.id,this.closed?'interrupted':'cancelled',message);
      else if(code==='NIGHTLY_BUDGET'||this.store.calls()>=this.config.dailyCallLimit)this.store.state(row.id,'budget_exhausted',message,this.store.nextBudgetDay()+this.config.idleSeconds*1000);
      else this.store.retry(row.id,message);
      const current=this.store.get(row.id);return {status:current.status,runId:row.id,error:message};
    }
  }
  async close(){this.closed=true;this.active?.stop.abort(Object.assign(new Error('宿主停止，保留整理检查点'),{code:'NIGHTLY_STOP'}));await this.active?.promise.catch(()=>{});await this.preview.close();}
}
