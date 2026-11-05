import {relateGoal} from './goal-relations.js';
import {randomUUID} from 'node:crypto';
import {GoalStore,closedGoals,closedSteps} from './goal-store.js';
import {hash,text,noSecret} from './validation.js';

export const goalNoSave=value=>/(?:不要|不必|无需|不需要|别).{0,12}(?:保存|学习|记住|记忆|记录)|不保存|不学习|接入测试|收发测试|测试消息|只(?:用于|用在)(?:本轮|这次|当前)|do not (?:save|remember)|don't (?:save|remember)/i.test(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const terminalIntent=row=>['completed','failed','cancelled','dismissed'].includes(row?.status);
const actions=new Set(['reuse','supplement','propose','adopt','plan','revise','wait','pause','resume','abandon','complete']);
const fields=new Set(['action','id','expectedRevision','key','title','success','completionEvidence','reason','sourceId','quote','nextStep','wake','evidenceIds','expectedGoalsRevision']);
function completionEvidence(value='observation'){if(!['observation','retrieval','internal_reflection'].includes(value))throw new Error('目标结果依据类型无效');return value;}
function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(label+'超出范围');return value;}
export function goalWake(value,now){
  if(!value||!['time','event','task_end','state_change','change'].includes(value.kind)||Object.keys(value).some(k=>!['kind','afterSeconds'].includes(k)))throw new Error('目标等待需要明确的重新考虑条件');
  return value.kind==='time'?{kind:'time',at:now+integer(value.afterSeconds,60,604800,'目标重新考虑时间')*1000}:{kind:value.kind};
}
function nextStep(value){
  if(!value||Object.keys(value).some(k=>!['kind','topic','success'].includes(k))||!['browse','recall','reflect'].includes(value.kind))throw new Error('目标步骤只支持现有阅读、回忆或反思能力');
  return {kind:value.kind,topic:text(value.topic,'步骤主题',value.kind==='browse'?80:160),success:text(value.success,'步骤完成标准',400)};
}

export class GoalController {
  constructor({journal,attention,activities,writeEnabled=()=>true,now=()=>new Date(),config={}}) {
    Object.assign(this,{journal,attention,activities,writeEnabled,now});this.store=new GoalStore(journal,now);
    this.config={enabled:config.enabled??true,maxOpen:config.maxOpen??12,maxAdopted:config.maxAdopted??3,timeoutMs:90000};
    if(typeof this.config.enabled!=='boolean')throw new Error('goals.enabled必须是布尔值');
    integer(this.config.maxOpen,1,100,'并存目标数');integer(this.config.maxAdopted,1,this.config.maxOpen,'采纳目标数');
    this.lastError=null;this.host=null;this.closed=false;this.reviewing=new Set();
  }
  enabled(){return !this.closed&&this.config.enabled&&this.writeEnabled();}
  bind(host){this.host=host;}
  writable(){if(!this.enabled())throw new Error('长期目标写入当前未启用');}
  safe(error){const value=String(error?.message??error).slice(0,400);try{noSecret(value);return value;}catch{return '目标操作包含敏感内容，未展示原文';}}
  brief(goal){return {id:goal.id,revision:goal.revision,title:goal.title,success:goal.success,completionEvidence:goal.completionEvidence,status:goal.status,adoptedAt:goal.adoptedAt,wake:goal.wake,lastReason:goal.lastReason,updatedAt:goal.updatedAt,planningNotes:(goal.planningNotes??[]).slice(-2).map(n=>({topic:n.topic,detail:n.detail?.slice(0,180)??null}))};}
  context(){return {revision:this.store.revision(),limits:{maxOpen:this.config.maxOpen,maxAdopted:this.config.maxAdopted},goals:this.store.list().map(goal=>({...this.brief(goal),nextStep:this.store.steps(goal.id).filter(step=>!closedSteps.has(step.status)).map(({id,kind,topic,status})=>({id,kind,topic,status}))})),boundary:'愿望、计划与真实结果分开；目标不代表已答应他人，不构成新的外部事实或人格依据。'};}
  read(id){if(id){const goal=this.store.get(id);if(!goal)throw new Error('目标不存在');return {status:'read',goal,steps:this.store.steps(id),history:this.store.history(id)};}return {status:'read',enabled:this.enabled(),...this.context(),recentClosed:this.store.list({all:true}).filter(g=>closedGoals.has(g.status)).slice(0,5).map(g=>this.brief(g)),limits:{maxOpen:this.config.maxOpen,maxAdopted:this.config.maxAdopted},lastError:this.lastError};}
  /** References are built by the host from the exact data presented in this decision. */
  capture(proposals,sources,decisionId,snapshot=null){
    if(proposals===undefined||!this.enabled())return [];
    if(!Array.isArray(proposals)||proposals.length>1)throw new Error('每次行为选择最多提出一个长期目标');
    return proposals.map(proposal=>{
      if(!proposal||!actions.has(proposal.action))throw new Error('行为选择中的目标操作无效');
      const source=sources.find(row=>row.id===proposal.sourceId);if(!source||!source.eligible)throw new Error('目标来源不在本轮可用原件中');
      if(proposal.action!=='propose'&&!(source.owner===true&&['owner','private'].includes(source.privacy))&&!['current_self_state','internal_reflection'].includes(source.kind))throw new Error('外部消息只能提供候选愿望，不能直接控制已有私密目标');
      const quote=text(proposal.quote,'目标来源摘录',700);if(!source.text.includes(quote))throw new Error('目标依据必须引用已呈现原文');
      return this.change(proposal.action==='propose'&&snapshot?{...proposal,expectedGoalsRevision:snapshot.revision}:proposal,{kind:source.kind,id:source.id,quote,channel:source.channel??'internal',privacy:source.privacy??'owner',independentEvidence:false},'attention:'+decisionId);
    });
  }
  change(args,source,operationScope='model'){
    this.writable();
    if(!args||Array.isArray(args)||Object.keys(args).some(k=>!fields.has(k))||!actions.has(args.action))throw new Error('目标操作格式无效');
    if(!source?.id||typeof source.kind!=='string'||source.noSave===true)throw new Error('目标缺少真实来源或本轮禁止持久化');
    noSecret(JSON.stringify({args,source}));
    if(['reuse','supplement'].includes(args.action))return relateGoal(this,args,source);
    const operation=hash(JSON.stringify([operationScope,args,source])),old=this.store.receipt(operation);
    if(old){const current=this.store.get(old.goal.id);return {...old,goal:current,replayed:true,originalRevision:old.goal.revision,historical:current.revision!==old.goal.revision};}
    let cancelled=[];
    const receipt=this.journal.transaction(()=>{
      const reason=text(args.reason,'目标变化理由',600);let goal,before=null;
      if(args.action==='propose'){
        const key=text(args.key,'稳定目标键',80).normalize('NFKC').toLowerCase();
        if(!/^[\p{L}\p{N}_ -]+$/u.test(key))throw new Error('目标键只能包含文字数字空格下划线和连字符');
        const title=text(args.title,'目标内容',240),normalized=value=>value.normalize('NFKC').replace(/[\s\p{P}]/gu,'').toLowerCase();
        const existing=this.store.byKey(key)??this.store.list({all:true,limit:1000}).find(goal=>normalized(goal.title)===normalized(title));if(existing)return {status:'existing',goal:existing};
        if(this.store.list({limit:1}).length&&args.expectedGoalsRevision!==this.store.revision())throw Error('新增目标前请读取当前目标索引并传expectedGoalsRevision，先判断复用或补充');
        if(this.store.list({limit:101}).length>=this.config.maxOpen)throw new Error('并存目标已达到资源上限，请先重新考虑已有目标');
        goal={id:randomUUID(),key,title,success:text(args.success,'目标完成标准',600),completionEvidence:completionEvidence(args.completionEvidence),status:'proposed',revision:0,origin:clone(source),adoptedAt:null,wake:null,lastReason:reason,createdAt:this.store.time(),updatedAt:this.store.time()};
      }else{
        before=this.store.get(args.id);if(!before)throw new Error('目标不存在');
        if(integer(args.expectedRevision,1,Number.MAX_SAFE_INTEGER,'目标版本')!==before.revision)throw new Error('目标版本已变化，请重新读取后再决定');
        if(closedGoals.has(before.status))throw new Error('已完成或放弃的目标不能自动复活');
        goal=clone(before);const steps=this.store.steps(goal.id),unfinished=steps.filter(s=>!closedSteps.has(s.status));
        if(['adopt','plan','resume'].includes(args.action)){
          if(args.action==='adopt'&&goal.status!=='proposed')throw new Error('只能采纳候选愿望');
          if(args.action==='plan'&&!goal.adoptedAt)throw new Error('尚未采纳的愿望不能直接执行');
          if(args.action==='resume'&&!['paused','waiting'].includes(goal.status))throw new Error('目标没有暂停或等待');
          const adopted=this.store.list({limit:101}).filter(g=>g.id!==goal.id&&g.adoptedAt&&['active','waiting'].includes(g.status));
          if(adopted.length>=this.config.maxAdopted)throw new Error('同时投入的目标已达资源上限，可以先暂停其他目标');
          goal.adoptedAt??=args.action==='adopt'?this.store.time():null;
          goal.status=goal.adoptedAt?'active':'proposed';goal.wake=null;
          if(args.nextStep){
            if(!goal.adoptedAt)throw new Error('未采纳愿望不能安排步骤');
            if(unfinished.length)throw new Error('尚有未完步骤，请先等待结果或明确暂停/放弃');
            if(steps.length>=40)throw new Error('单个目标的步骤已达资源上限，请结束或拆分目标');
            this.store.saveStep({id:randomUUID(),goalId:goal.id,...nextStep(args.nextStep),status:'pending',intentId:null,receipt:null,createdAt:this.store.time(),updatedAt:this.store.time()});
          }
        }else if(args.action==='revise'){
          if(unfinished.length)throw new Error('修改目标内容前须先结束或暂停未完步骤');
          if(!args.title&&!args.success&&!args.completionEvidence)throw new Error('重订目标需要新的内容或完成标准');
          if(args.title)goal.title=text(args.title,'目标内容',240);
          if(args.success)goal.success=text(args.success,'目标完成标准',600);
          if(args.completionEvidence)goal.completionEvidence=completionEvidence(args.completionEvidence);
        }else if(['wait','pause','abandon'].includes(args.action)){
          // In-flight work reaches its real checkpoint/end. It is never replayed or erased.
          for(const step of unfinished){const intent=step.intentId?this.attention.store.get(step.intentId):null;if(['running','waking','admitting','paused'].includes(intent?.status)){if(args.action==='wait')throw new Error('已有步骤执行中，完成后再重评');continue;}step.status='cancelled';step.updatedAt=this.store.time();this.store.saveStep(step);if(intent&&!terminalIntent(intent))cancelled.push(intent.id);}
          goal.status=args.action==='wait'?'waiting':args.action==='pause'?'paused':'abandoned';goal.wake=args.action==='wait'?goalWake(args.wake,this.now().valueOf()):null;
        }else if(args.action==='complete'){
          if(!goal.adoptedAt||unfinished.length)throw new Error('目标尚未采纳或仍有未完成步骤');
          if(!Array.isArray(args.evidenceIds)||!args.evidenceIds.length||args.evidenceIds.length>8||new Set(args.evidenceIds).size!==args.evidenceIds.length)throw new Error('完成目标必须引用实际步骤回执');
          for(const id of args.evidenceIds){const step=steps.find(s=>s.id===id);if(step?.status!=='completed'||step.receipt?.verified!==true||!this.verifyReceipt(step))throw new Error('目标完成依据不是当前可核验的真实步骤结果');}
          if(!args.evidenceIds.some(id=>steps.find(s=>s.id===id).receipt.kind===goal.completionEvidence))throw new Error('结果依据类型不满足目标要求；内部反思不能代替实际观察');
          goal.status='completed';goal.wake=null;goal.completion={stepIds:args.evidenceIds,reason,at:this.store.time(),semanticAssessment:'模型依据结果判断达标；程序核验执行真实性，不独立证明语义质量'};
        }
      }
      goal.lastReason=reason;this.store.save(goal,args.action,reason,source,before);
      const value={status:'changed',goal};this.store.saveReceipt(operation,value);return value;
    });
    for(const id of cancelled)this.attention.store.patch(id,'cancelled',{result:{reason:'所属目标已暂停、等待或放弃；未执行的步骤不补做'}});
    if(['pause','abandon'].includes(args.action)){
      const active=this.activities?.active,intent=active?.attentionId?this.attention.store.get(active.attentionId):null;
      if(intent?.payload.goalId===receipt.goal.id)active.stop.abort(Object.assign(new Error('所属长期目标已暂停或放弃，保留实际检查点与已有结果'),{code:args.action==='pause'?'GOAL_PAUSE':'GOAL_ABANDON'}));
    }
    if(receipt.status==='changed')this.attention.signal('goal_change');return receipt;
  }
  verifyReceipt(step){
    const intent=step.intentId?this.attention.store.get(step.intentId):null;
    if(!intent||intent.status!=='completed'||intent.payload.goalStepId!==step.id)return null;
    const result=intent.result??{};
    if(step.kind==='browse'){
      const run=result.activityId?this.activities?.store.get(result.activityId):null;
      if(!run||!['completed','completed_without_memory','read_only','already_observed'].includes(run.status))return null;
      const observationId=run.observation_id??run.result?.observationId,observation=observationId?this.activities.store.observation(observationId):null;
      if(!observation)return null;
      return {verified:true,kind:'observation',activityId:run.id,observationId:observation.id,scope:observation.payload.scope,summary:run.result?.summary??'工具已读取这份原件；理解效果需结合原文核对',sourceUrl:observation.payload.url,independentEvidence:false};
    }
    if(step.kind==='recall'&&result.status==='recalled'&&Array.isArray(result.items))return {verified:true,kind:'retrieval',items:clone(result.items.slice(0,8)),coverage:result.coverage??null,independentEvidence:false};
    if(step.kind==='reflect'&&result.status==='reflected'&&typeof result.note==='string')return {verified:true,kind:'internal_reflection',note:result.note,independentEvidence:false};
    return null;
  }
  reconcile(){
    for(const {value_json} of this.store.db.prepare("SELECT value_json FROM goal_steps WHERE status NOT IN ('completed','failed','cancelled')").all()){
      const step=JSON.parse(value_json),goal=this.store.get(step.goalId);if(!goal)continue;
      let intent=step.intentId?this.attention.store.get(step.intentId):this.attention.store.byKey('goal-step:'+step.id);
      if(intent&&!step.intentId){step.intentId=intent.id;this.store.saveStep(step);}
      if(!intent)continue;
      if(terminalIntent(intent)){
        const proof=this.verifyReceipt(step),before=this.store.get(goal.id),after=clone(before);
        this.journal.transaction(()=>{step.status=proof?'completed':intent.status==='completed'?'failed':intent.status==='failed'?'failed':'cancelled';step.receipt=proof??{verified:false,intentStatus:intent.status,resultStatus:intent.result?.status??null,error:intent.error??null};step.updatedAt=this.store.time();this.store.saveStep(step);if(!closedGoals.has(after.status)&&after.status!=='paused'){after.status=proof?'active':'waiting';after.wake=proof?null:{kind:'event'};}this.store.save(after,'step_result',proof?'核验到真实步骤结果；是否完成目标仍需重新判断':'未取得可核验结果，不能作为达标依据',{kind:'execution_receipt',id:intent.id,independentEvidence:false},before);});
        this.attention.signal('goal_change');
      }
    }
  }
  collect(){
    if(!this.enabled())return;
    this.reconcile();
    for(const goal of this.store.list({limit:101})){
      if(goal.status==='paused')continue;
      const steps=this.store.steps(goal.id),step=steps.find(s=>!closedSteps.has(s.status));
      if(step){
        if(!step.intentId){const intent=this.attention.offer({key:'goal-step:'+step.id,kind:step.kind,scope:'internal',summary:'目标下一步：'+step.topic,payload:{topic:step.topic,reason:goal.title,goalId:goal.id,goalStepId:step.id}});step.intentId=intent.id;step.status='offered';this.store.saveStep(step);}
        continue;
      }
      const key=`goal:${goal.id}:${goal.revision}`;
      if(this.attention.store.byKey(key))continue;
      const intent=this.attention.offer({key,kind:'goal',scope:'internal',summary:(goal.status==='proposed'?'候选愿望：':'重新考虑目标：')+goal.title,payload:{goalId:goal.id,goalRevision:goal.revision}});
      if(goal.status==='waiting')this.attention.store.patch(intent.id,'waiting',{wake:goal.wake,result:{reason:goal.lastReason}});
    }
    // A paused/abandoned/changed goal cannot leave a stale review executable.
    for(const row of this.attention.store.recent(1000))if(row.kind==='goal'&&!terminalIntent(row)&&!['running','waking','admitting'].includes(row.status)){
      const goal=this.store.get(row.payload.goalId);if(!goal||closedGoals.has(goal.status)||goal.status==='paused'||goal.revision!==row.payload.goalRevision)this.attention.store.patch(row.id,'cancelled',{result:{reason:'目标版本或状态已变化，旧选择不执行'}});
    }
  }
  canStart(row){
    if(!row.payload.goalId)return true;
    const goal=this.store.get(row.payload.goalId);if(!this.enabled()||!goal||closedGoals.has(goal.status)||goal.status==='paused')return false;
    if(row.kind==='goal')return goal.revision===row.payload.goalRevision;
    const step=this.store.step(row.payload.goalStepId);return Boolean(step&&step.goalId===goal.id&&step.intentId===row.id&&!closedSteps.has(step.status));
  }
  dismiss(row){
    if(!row.payload.goalId)return;
    const goal=this.store.get(row.payload.goalId);if(!goal||closedGoals.has(goal.status)||goal.status==='paused')return;
    return this.change({action:'wait',id:goal.id,expectedRevision:goal.revision,reason:row.result?.reason??'本次选择暂不投入，遇到新事件再考虑',wake:{kind:'event'}},{kind:'attention_choice',id:row.id,independentEvidence:false},'dismiss');
  }
  async execute(row,signal){
    if(!this.canStart(row))return {status:'goal_changed'};
    if(!this.host)throw new Error('目标规划模型尚未就绪');
    const goal=this.store.get(row.payload.goalId),frame={goal,steps:this.store.steps(goal.id),self:this.host.self(),resources:{limits:this.context().limits,otherGoals:this.context().goals.filter(g=>g.id!==goal.id).map(({id,status,title})=>({id,status,title}))},capabilities:['browse','recall','reflect'],executionBoundary:'每轮最多安排一个可执行步骤，仍需全局注意力选择。本目标步骤不直接发送QQ或修改平台权限；主动分享需统一注意力另行选择，没有完整视频感知。'};
    try{
      const answer=await this.host.review(frame,AbortSignal.any([signal,AbortSignal.timeout(this.config.timeoutMs)]));signal.throwIfAborted();
      if(!answer.decision||answer.decision.action==='propose')throw new Error('目标重评不能递归产生新目标');
      const receipt=this.change({...answer.decision,id:goal.id,expectedRevision:goal.revision},{kind:'internal_deliberation',id:row.id,independentEvidence:false},'goal-review:'+row.id);
      this.lastError=null;return {status:'goal_reviewed',goalId:goal.id,revision:receipt.goal.revision,action:answer.decision.action,independentEvidence:false};
    }catch(error){
      if(signal.aborted)throw error;
      this.lastError=this.safe(error);
      if(this.store.get(goal.id)?.revision!==goal.revision)return {status:'goal_changed',error:this.lastError};
      // A technical failure is visible and reconsidered later; it is not a voluntary refusal.
      this.attention.store.patch(row.id,'waiting',{wake:{kind:'time',at:this.now().valueOf()+60000},error:this.lastError,result:{reason:'目标处理失败；60秒后仅提供重新选择机会，未假装完成或放弃'}});
      return {pending:true};
    }
  }
}
