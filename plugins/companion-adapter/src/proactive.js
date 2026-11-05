import {platformCompletionSource} from './platform-completion.js';
import {ProactiveStore} from './proactive-store.js';
import {proactiveSource} from './proactive-source.js';
import {proactiveDecision} from './proactive-reviewer.js';
import {hash,noSecret} from './validation.js';
const finished=new Set(['sent','silent','expired','cancelled','unknown','rejected','duplicate']);
export class ProactiveController{
  constructor(adapter,{config={},now=()=>new Date(),writeEnabled=()=>true}={}){
    Object.assign(this,{adapter,now,writeEnabled});this.attention=adapter.attention;this.qq=adapter.qq;this.store=new ProactiveStore(adapter.journal,now);
    this.config={enabled:config.enabled??true,minIntervalSeconds:config.minIntervalSeconds??300,sourceTtlSeconds:config.sourceTtlSeconds??86400,maxPending:config.maxPending??20};
    if(typeof this.config.enabled!=='boolean')throw new Error('proactive.enabled必须为布尔值');
    for(const [k,min,max] of [['minIntervalSeconds',30,86400],['sourceTtlSeconds',300,604800],['maxPending',1,100]])if(!Number.isSafeInteger(this.config[k])||this.config[k]<min||this.config[k]>max)throw new Error('主动联系配置超出范围：'+k);
    this.host=null;this.collecting=null;this.active=null;this.lastError=null;
  }
  bind(host){this.host=host;}
  enabled(){return this.config.enabled&&this.writeEnabled()&&!this.store.control().paused&&this.attention.enabled();}
  deliveryEnabled(item){return this.config.enabled&&this.writeEnabled()&&this.attention.enabled()&&(item?.source.requestedReply===true||!this.store.control().paused);}
  safe(error){return this.qq.safe(error);}
  status(args){return {enabled:this.enabled(),hostReady:Boolean(this.host),accountReady:this.qq.ready,minIntervalSeconds:this.config.minIntervalSeconds,sourceTtlSeconds:this.config.sourceTtlSeconds,...this.store.status(args),lastError:this.lastError,scope:'只联系已绑定的主QQ；无固定发送日程。平台确认返回消息ID才进入已发送上下文，不表示已读。未知结果不自动重发。'};}
  async collect(){
    if(this.collecting)return this.collecting;
    this.collecting=this.gather().finally(()=>{this.collecting=null;});return this.collecting;
  }
  notice(row){if(['browse','recall','reflect','goal'].includes(row.kind))this.attention.store.checkpoint('proactive-source:'+row.id,{intentId:row.id,status:'pending'});}
  async gather(){
    if(!this.config.enabled||!this.writeEnabled()||!this.attention.enabled()||!this.qq.binding)return;
    for(const checkpoint of this.store.db.prepare("SELECT task_id,value_json FROM attention_checkpoints WHERE task_id LIKE 'proactive-source:%' AND json_extract(value_json,'$.status')='pending' ORDER BY rowid LIMIT 24").all()){
      const value=JSON.parse(checkpoint.value_json),intent=this.attention.store.get(value.intentId),source=await proactiveSource(this.adapter,intent,this.attention.stop.signal);
      if(source&&this.deliveryEnabled({source})){if(this.store.live().length>=this.config.maxPending)break;this.store.offer(source,this.qq.binding.id,this.config.sourceTtlSeconds*1000);}
      this.attention.store.checkpoint(checkpoint.task_id,{...value,status:'processed'});
    }
    const cursor=this.store.control(),rows=this.store.db.prepare("SELECT rowid AS ordinal,* FROM attention_intents WHERE status='completed' AND (updated_at>? OR updated_at=? AND rowid>?) ORDER BY updated_at,rowid LIMIT 24").all(cursor.cursor_at,cursor.cursor_at,cursor.cursor_row);
    for(const raw of rows){
      const intent=this.attention.store.decode(raw),source=await proactiveSource(this.adapter,intent,this.attention.stop.signal);
      if(source&&this.deliveryEnabled({source})){if(this.store.live().length>=this.config.maxPending)break;this.store.offer(source,this.qq.binding.id,this.config.sourceTtlSeconds*1000);}
      this.store.advance(raw.updated_at,raw.ordinal);
    }
    for(const item of this.store.live()){
      if(item.expires_at<=this.now().valueOf()){this.store.discard(item.id,'来源机会过期，未补发旧草稿');this.store.state(item.id,'expired');if(item.intent_id&&!this.attention.store.terminal(item.intent_id))this.attention.complete(item.intent_id,{status:'expired',itemId:item.id});continue;}
      if(!item.intent_id){const row=this.attention.offer({key:'proactive:'+item.id,kind:'proactive',scope:'owner',summary:(item.source.requestedReply?'先前请求的结果，可以回应或重新考虑：':'可以主动与你分享：')+(item.source.title??item.source.text.slice(0,100)),payload:{itemId:item.id}});this.store.link(item.id,row.id);}
    }
    // Reconcile a send receipt committed immediately before a crash.
    for(const row of this.store.db.prepare("SELECT p.id,p.intent_id,p.status FROM attention_intents a JOIN proactive_items p ON p.intent_id=a.id WHERE a.status IN ('pending','selected','running','paused','waiting') AND p.status IN ('sent','unknown')").all())this.attention.complete(row.intent_id,{status:row.status,itemId:row.id,receiptOnly:true});
  }
  preview(row){
    const item=this.store.get(row.payload.itemId);if(!item||item.binding_id!==this.qq.binding?.id||hash(JSON.stringify(item.source))!==item.source_hash)return {state:'source_unavailable'};
    if(item.source.kind==='requested_platform_result'){const original=this.attention.store.get(item.source.originIntentId),live=platformCompletionSource(this.adapter,original);if(!live||hash(JSON.stringify(live))!==item.source_hash)return {state:'source_changed',boundary:'旧结果失效，不据此发送'};}
    return {itemId:item.id,deliveryState:item.status,sourceKind:item.source.kind,requestedReply:item.source.requestedReply===true,requestQuote:(item.source.requestQuote??'').slice(0,900),result:item.source.text.slice(0,3500),boundary:'这是原请求的实际结果候选，尚未通知；可回应、暂缓或沉默。不要求新兴趣或新外部经历才能考虑请求结果，不强制发送。'};
  }
  readiness(row){
    const item=this.store.get(row.payload.itemId);
    if(!item||finished.has(item.status)){this.attention.complete(row.id,{status:item?.status??'missing'});return {waiting:false};}
    if(!this.deliveryEnabled(item))return {waiting:true,wake:{kind:'proactive_resume'},reason:'主动联系已暂停，等待明确恢复'};
    if(!this.qq.ready)return {waiting:true,wake:{kind:'qq_ready'},reason:'QQ账号尚未核验登录，未生成出站正文'};
    const last=item.source.requestedReply?null:this.store.lastSent(),due=last?Date.parse(last)+this.config.minIntervalSeconds*1000:0;
    if(due>this.now().valueOf())return {waiting:true,wake:{kind:'time',at:due},reason:'主动消息间隔保护；到期重新决定，不定时补发正文'};
    return null;
  }
  async source(item,signal){
    if(hash(JSON.stringify(item.source))!==item.source_hash)return null;
    const intent=this.attention.store.get(item.source.originIntentId),live=await proactiveSource(this.adapter,intent,signal);
    return live&&hash(JSON.stringify(live))===item.source_hash?live:null;
  }
  version(){const a=this.adapter,q=this.qq;return JSON.stringify([this.attention.store.meta().epoch,a.growth.store.revision(),a.growth.emotions.store.revision(),a.goals?.store.revision()??0,this.store.control().revision,q.epoch,q.binding?.id,this.store.db.prepare('SELECT max(rowid) id FROM qq_inbox').get().id]);}
  park(row,reason,wake={kind:'time',at:this.now().valueOf()+60000}){if(this.attention.store.terminal(row.id))return {status:'closed'};this.attention.store.patch(row.id,'waiting',{wake,result:{reason}});return {pending:true};}
  async execute(row,signal){
    const ready=this.readiness(row);if(this.attention.store.terminal(row.id))return {status:'closed'};
    if(ready?.waiting)return this.park(row,ready.reason,ready.wake);
    const item=this.store.get(row.payload.itemId);if(item.binding_id!==this.qq.binding.id){this.store.state(item.id,'cancelled');return {status:'binding_changed'};}
    if(this.active)return this.park(row,'已有主动表达正在执行，结束后重新考虑',{kind:'task_end'});
    if(!this.host)throw new Error('主动表达模型尚未就绪');
    this.active={id:item.id};const version=this.version();
    try{
      const source=await this.source(item,signal);if(!source||item.expires_at<=this.now().valueOf()){this.store.state(item.id,'expired');return {status:'source_changed'};}
      const state=await this.host.state(signal),frame={intentId:row.id,source,state,recentPublished:this.store.publications(),destination:'已绑定主用户QQ私聊，仅此一人'};
      const decision=proactiveDecision((await this.host.review('compose',frame,signal)).decision,source);signal.throwIfAborted();
      if(this.version()!==version)return this.park(row,'表达期间有新消息或状态变化，未保存旧稿');
      if(decision.action==='silent'){this.store.state(item.id,'silent');return {status:'silent',reason:decision.reason};}
      if(decision.action==='defer')return this.park(row,decision.reason,decision.wake.kind==='time'?{kind:'time',at:this.now().valueOf()+decision.wake.afterSeconds*1000}:decision.wake);
      const audit=(await this.host.review('audit',{source,state,draft:decision.body},signal)).decision;
      if(typeof audit?.allow!=='boolean'||typeof audit.reason!=='string'||audit.reason.length>700)throw new Error('主动出站核验格式无效');
      if(!audit.allow){this.lastError='主动出站内容未通过核验：'+audit.reason;this.store.state(item.id,'rejected');return {status:'rejected',reason:audit.reason};}
      if(this.version()!==version||!await this.source(item,signal))return this.park(row,'发送前状态或原件变化，未提交旧稿');
      noSecret(decision.body);this.store.prepare(item.id,decision.body);
      const preparedAt=this.now().valueOf();
      const result=await this.qq.privateText(item.binding_id,decision.body,{signal,beforeSend:async()=>{
        if(this.version()!==version||!this.deliveryEnabled(item)||this.now().valueOf()-preparedAt>90000||this.now().valueOf()>=item.expires_at||!await this.source(item,signal))throw new Error('主动发送前原件、状态或有效期变化');
      },onDispatch:()=>this.store.attempt(item.id,'sending')});
      this.store.attempt(item.id,'sent',{platformId:result.messageId});this.lastError=null;
      return {status:'sent',itemId:item.id,platformId:result.messageId,scope:'OneBot确认发送，不表示对方已读；未增加独立外部事实或人格依据'};
    }catch(error){
      this.lastError=this.safe(error);const current=this.store.get(item.id);
      if(error.code==='PROACTIVE_DUPLICATE'){this.store.state(item.id,'duplicate');return {status:'duplicate',itemId:item.id};}
      if(error.qqDispatched||current.status==='sending'){this.store.attempt(item.id,'unknown',{error:'发送回执未确认；未自动重发。'+this.lastError});return {status:'unknown',itemId:item.id};}
      this.store.discard(item.id,this.lastError);
      if(signal.aborted)throw error;
      return this.park(row,'主动表达暂未完成：'+this.lastError);
    }finally{this.active=null;}
  }
  dismiss(row){const item=this.store.get(row.payload.itemId);if(item&&item.status==='candidate')this.store.state(item.id,'silent');}
  control(action){
    if(!['pause','resume','cancel_pending'].includes(action))throw new Error('主动联系控制只支持pause/resume/cancel_pending');
    if(action==='pause')this.store.pause(true);if(action==='resume')this.store.pause(false);
    if(action!=='resume')for(const item of this.store.live()){if(action==='pause'&&item.source.requestedReply)continue;this.store.discard(item.id,'主用户取消或暂停主动联系');if(action==='cancel_pending'){this.store.state(item.id,'cancelled');if(item.intent_id)this.attention.complete(item.intent_id,{status:'cancelled'});}}
    this.adapter.profileNotices?.control(action);
    this.attention.signal(action==='resume'?'proactive_resume':'state_change');return {status:'controlled',...this.status()};
  }
}
