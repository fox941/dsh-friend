import {QQReliability} from './reliability.js';
import {QQStore} from './qq-store.js';
import {qqId} from './qq-config.js';
import {QQ_SOURCE} from './source-identity.js';
import {noSecret} from './validation.js';
import {QQReplies} from './qq-replies.js';
const words=blocks=>(blocks??[]).filter(row=>row.type==='text'&&typeof row.text==='string').map(row=>row.text).join('\n');
const stopReply='已停止当前回复；已经保存的记忆不会因此撤销。';
const wireId=value=>{const id=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;if(typeof id!=='string'||!/^[-a-zA-Z0-9_:]{1,100}$/.test(id))throw new Error('QQ消息ID不可核验');return id;};
const cqDecode=value=>value.replaceAll('&#91;','[').replaceAll('&#93;',']').replaceAll('&#44;',',').replaceAll('&amp;','&');
const omittedKind=type=>['reply','at','image','record','forward','video','file','face'].includes(type)?type:'unsupported';
export function qqInbound(event,binding,{media=false}={}){
  if(event?.post_type!=='message'||event.message_type!=='private')throw new Error('首版只接收主用户私聊文字');
  if(qqId(event.self_id)!==binding.bot_qq||qqId(event.user_id)!==binding.owner_qq||String(event.user_id)===binding.bot_qq||event.sender?.user_id!==undefined&&String(event.sender.user_id)!==binding.owner_qq)throw new Error('QQ发送者或机器人账号不匹配');
  const platformId=wireId(event.message_id),omissions=new Set();let body='';
  if(Array.isArray(event.message)){
    if(event.message.length>128)throw new Error('QQ消息段超出处理预算');
    for(const segment of event.message){if(segment?.type==='text'&&typeof segment.data?.text==='string')body+=segment.data.text;else if(typeof segment?.type==='string')omissions.add(omittedKind(segment.type));else throw new Error('不完整的QQ消息段');}
  }else if(typeof event.message==='string')body=cqDecode(event.message.replace(/\[CQ:([a-zA-Z_]+)(?:,[^\]]*)?\]/g,(_all,type)=>{omissions.add(omittedKind(type));return '';}));
  else throw new Error('QQ原始消息格式不支持');
  if(media&&!body.trim()&&Array.isArray(event.message)&&event.message.some(s=>['image','record','reply','forward','face'].includes(s.type)))body='【QQ媒体消息：图片、语音、引用或转发尚待实际读取】';
  if(!body.trim()||body.length>6000)throw new Error('QQ本条没有可处理的有界文字');noSecret(body);
  return {platformId,body,omissions:[...omissions].sort(),platformTime:Number.isFinite(event.time)?event.time:null};
}
export function replyParts(body,max=1500){const chars=Array.from(body),parts=[];if(chars.length>24000)throw new Error('QQ回复超出发送预算，完整内容保留在网页会话');for(let index=0;index<chars.length;index+=max)parts.push(chars.slice(index,index+max).join(''));return parts;}
export class QQController{
  constructor({journal,workspace,settings,createConnection,authority,reliability={},now=()=>new Date()}){
    if(!authority||['register','ownerIdentity','ownerMessage'].some(k=>typeof authority[k]!=='function'))throw new Error('QQ bridge requires a trusted source authority port');
    this.authority=authority;this.reliabilityOptions=reliability;this.clock=()=>now().valueOf();
    Object.assign(this,{journal,workspace,settings,createConnection});this.store=new QQStore(journal,now);this.binding=null;
    this.replies=new QQReplies(journal,{now,maxDeferSeconds:settings.maxDeferSeconds,deferTtlSeconds:settings.deferTtlSeconds});
    this.unregister=authority.register(workspace,(event,header)=>this.store.trusted(event,header),{assistant:(event,header)=>this.replies.assistantDelivered(event,header),pending:(event,header)=>this.replies.publicationPending(event,header)});
    this.deliveries=new Set();this.deliveryStop=new AbortController();this.outgoingTail=Promise.resolve();
    this.publicName=null;this.closed=false;this.ready=false;this.connection=null;this.host=null;this.driving=null;this.sending=null;this.timers=new Map();this.lastError=null;this.dropped=0;this.epoch=0;
    try{this.binding=this.store.bind(settings);}catch(error){this.lastError=this.safe(error);this.settings={enabled:false,configured:false};}
  }
  safe(error){let value=String(error?.message??error).slice(0,500);for(const secret of [this.settings.accessToken,process.env.DEEPSEEK_API_KEY])if(secret)value=value.replaceAll(secret,'[已隐藏]');try{noSecret(value);return value;}catch{return 'QQ错误详情包含疑似凭据，未展示正文';}}
  status(){return {configured:this.settings.configured??false,enabled:this.settings.enabled,connected:Boolean(this.connection?.connected),accountVerified:this.ready,binding:this.binding?{ownerQQ:this.binding.owner_qq,botQQ:this.binding.bot_qq,sessionId:this.binding.session_id}:null,...this.store.summary(),responses:this.replies.summary(),lastError:this.lastError,droppedThisRun:this.dropped,reliability:this.reliability?.status()??null,scope:this.platforms?'主用户私聊共享记忆；已接入群与其他好友独立话题，按统一注意力选择回应':this.attention?.enabled()?'绑定主用户私聊；同一角色全局选择是否与何时回应；不开放群聊或自主联系他人':'绑定主用户私聊文字'};}
  planResponse(args,agent){if(this.attention?.enabled()&&args.action==='defer')throw new Error('全局行为协调启用后，延后由意图清单重新考虑，不保存定时发送旧稿');const event=this.authority.ownerMessage(agent),identity=this.authority.ownerIdentity(event,agent.session.header);if(identity?.channel!=='qq'||agent.session.header.id!==this.binding?.session_id)throw new Error('只能为本实例当前QQ主用户消息设置回应意图');const row=this.store.get(identity.qq.inboxId);if(row.event_seq!==event.seq||row.message_id!==event.data.id)throw new Error('回应意图原话已变化');return this.replies.propose(row.id,args);}
  cancelDeferred(reason='主用户明确取消待发答复'){return {status:'cancelled',cancelled:this.binding?this.replies.cancel(this.binding.id,reason):0,summary:'尚未发出的延后答复已取消；已发出的网络请求和已送达文字不能撤回'};}
  async start(host){
    this.host=host;if(!this.settings.enabled)return;if(this.attention?.enabled())this.cancelDeferred('全局行为协调已启用，取消旧的定时草稿；原文与历史保留');
    if(!this.binding)throw new Error('QQ缺少主用户绑定');
    this.connection=await this.createConnection({...this.settings,mode:'forward',host:'127.0.0.1',port:0,reconnectMaxAttempts:0,log:(level,_message)=>{if(level==='error')this.lastError='QQ连接发生错误，请核对本地协议端及访问令牌';}});
    if(this.closed){await this.connection.stop();return;}
    this.connection.onMessage=event=>{void this.receive(event).catch(error=>{this.lastError=this.safe(error);});};
    this.connection.onEvent=event=>{void this.platforms?.receive(event).catch(error=>{this.lastError=this.safe(error);});};
    if(this.platforms){this.reliability=new QQReliability(this,{config:this.reliabilityOptions,now:this.clock});this.connection.onMeta=e=>this.reliability.observe(e);}
    this.connection.onStatus=connected=>{if(connected)this.reliability?.connected();else this.reliability?.disconnected();this.ready=false;const epoch=++this.epoch;if(connected)void this.handshake(epoch).catch(error=>{this.lastError=this.safe(error);});};
    this.connection.start();this.reliability?.start();this.tick=setInterval(()=>{try{this.replies.settle();}catch(error){this.lastError=this.safe(error);}void this.drive().catch(error=>{this.lastError=this.safe(error);});void this.flush().catch(error=>{this.lastError=this.safe(error);});},2000);this.tick.unref?.();
  }
  async handshake(epoch){
    const info=await this.connection.call('get_login_info',{});
    if(epoch!==this.epoch||this.closed)return;
    if(qqId(info.user_id)!==this.binding.bot_qq)throw new Error('OneBot实际登录账号与绑定的AI账号不同，尚未开放聊天');
    this.publicName=typeof info.nickname==='string'&&info.nickname.length<=80?info.nickname:null;this.ready=true;this.lastError=null;this.attention?.signal('qq_ready');await this.drive();await this.flush();
  }
  async receive(event){
    const recovery=this.reliability?.provenance(event);if(!recovery)this.reliability?.observe(event);
    if(this.closed||!this.ready||!this.settings.enabled){this.dropped++;return {status:'not_ready'};}
    if(this.platforms&&(event.post_type!=='message'||event.message_type!=='private'||String(event.user_id)!==this.binding.owner_qq))return this.platforms.receive(event);
    let message;try{message=qqInbound(event,this.binding,{media:Boolean(this.media)});}catch(error){this.dropped++;this.lastError=this.safe(error);return {status:'dropped'};}
    const newer=recovery&&this.store.db.prepare("SELECT 1 FROM qq_inbox WHERE binding_id=? AND COALESCE(platform_time,CAST(strftime('%s',created_at) AS REAL))>? LIMIT 1").get(this.binding.id,message.platformTime);
    const historyOnly=Boolean(recovery&&(recovery.historyOnly||newer));
    // Persist provenance and inbox admission in one transaction: interrupted
    // recovery must never leave a pending message with ordinary live authority.
    const saveRecovery=recovery?row=>this.reliability.saveOwner(row,{...recovery,historyOnly,reason:newer?'newer_message_already_seen':recovery.reason}):undefined;
    const accepted=historyOnly?this.store.archive(this.binding,message,saveRecovery):this.store.accept(this.binding,message,this.settings,saveRecovery);
    if(recovery&&accepted.duplicate)return {status:'duplicate',inboxId:accepted.row.id};
    if(this.media&&Array.isArray(event.message))this.media.remember('owner:'+accepted.row.id,event,{account:this.binding.bot_qq,peer:this.binding.owner_qq,groupId:null,thread:this.binding.session_id});
    if(historyOnly)return {status:'recovered_history',inboxId:accepted.row.id};
    if(!accepted.duplicate)this.replies.cancel(this.binding.id,'收到更新的主用户消息，旧延后答复已取代',{beforeId:accepted.row.id,status:'superseded'});
    if(!accepted.duplicate&&message.body.trim()==='/stop'){
      for(const controller of this.mediaStops?.values()??[])controller.abort(new Error('主用户停止当前媒体读取'));
      this.activityRequests?.cancelSession(this.binding.session_id);this.attention?.cancelSession(this.binding.session_id);this.store.db.prepare("UPDATE qq_inbox SET status='cancelled',error='主用户停止待考虑回应',updated_at=? WHERE session_id=? AND status='attention_waiting'").run(this.store.time(),this.binding.session_id);const agent=await this.host.ensureAgent(this.binding);agent.cancel({kind:'user'});
      this.replies.cancel(this.binding.id,'主用户通过QQ停止',{beforeId:accepted.row.id,all:true});
      for(const pending of this.store.pending())if(pending.id!==accepted.row.id)this.store.state(pending.id,'cancelled','主用户通过QQ停止');
      this.store.prepareReply(accepted.row.id,[stopReply]);await this.flush();return {status:'stopped',inboxId:accepted.row.id};
    }
    if(!accepted.duplicate)await this.drive();return {status:accepted.duplicate?'duplicate':'accepted',inboxId:accepted.row.id};
  }
  drive(){
    if(this.closed||!this.ready||!this.host)return Promise.resolve();this.driveAgain=true;
    if(this.driving)return this.driving.then(()=>this.driveAgain&&!this.closed&&this.ready?this.drive():undefined);
    this.driving=(async()=>{do{this.driveAgain=false;await this.drain();}while(this.driveAgain&&!this.closed&&this.ready);})().finally(()=>{this.driving=null;});return this.driving;
  }
  async prepareMedia(row,signal=this.deliveryStop.signal){if(!this.media||!this.platforms)return null;const input=this.platforms.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('input:owner:'+row.id);if(!input)return null;this.mediaStops??=new Map();const stop=new AbortController();this.mediaStops.set(row.id,stop);const activeSignal=AbortSignal.any([signal,stop.signal,AbortSignal.timeout(240000)]);try{return await this.media.read(input.id,activeSignal);}catch(error){signal?.throwIfAborted();this.lastError=this.safe(error);return {status:'media_unavailable',notice:'本轮图片/语音/引用/转发未完成实际读取，不能据此回答其内容'};}finally{this.mediaStops.delete(row.id);}}
  mediaContext(inboxId){if(!this.platforms)return null;const input=this.platforms.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('input:owner:'+inboxId);if(!input)return null;const cached=this.platforms.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('read:'+input.id);return cached?this.platforms.store.media(cached.id):{status:'not_read',notice:'附件尚未实际读取，不可猜测其内容'};}
  async drain(){
    await this.reconcileCompletedAdmission();
    for(let row of this.store.pending()){
      if(this.closed||!this.ready)break;
      if(row.binding_id!==this.binding.id)continue;
      const agent=await this.host.ensureAgent(this.binding);
      row=this.store.get(row.id);if(!['received','dispatching','queued','processing'].includes(row.status))continue;
      if(this.closed)break;
      const intent=this.attention?.store.byKey(`message:${row.session_id}:${row.message_id}`);
      if(this.attention?.enabled()&&intent&&['pending','waiting','dismissed','admitting','waking','selected'].includes(intent.status))continue;
      // A restart first reconciles the durable identified input. It never
      // generates a replacement message merely because a receipt was lost.
      if(row.status!=='received'){
        if(agent.inbox.nextTurn.some(item=>item.id===row.message_id)||agent.inbox.nextStep.some(item=>item.id===row.message_id))return;
        let seen=null,end=null;for(let seq=0;seq<agent.session.seq;seq++){const event=agent.session.eventAt(seq);if(event?.type==='user/message'&&event.data.id===row.message_id)seen=event;if(seen&&event?.type==='turn/end'){end=event;break;}}
        if(seen){if(end){this.finish(agent.session,end,row);continue;}if(agent.status==='idle'){this.replies.transition(row.id,'interrupted','恢复时原始回合已中断');this.store.state(row.id,'interrupted','上次回合中断且当前会话已空闲；保留原话，未重复调用模型');continue;}return;}
        // DSH claims input before awaiting prompt assembly and only then logs it.
        // A live step can therefore have neither a queued item nor a durable user event yet.
        if(agent.status==='running'&&this.clock()-Date.parse(row.updated_at)<(this.settings.turnTimeoutMs??180000))return;
        this.replies.transition(row.id,'interrupted','恢复时原始投递缺少持久回执');this.store.state(row.id,'interrupted','上次投递缺少持久回执，保留原话等待核对，未盲目再次调用模型');continue;
      }
      this.store.state(row.id,'dispatching');
      if(row.body.trim()==='/stop'){
        agent.cancel({kind:'user'});for(const pending of this.store.pending())if(pending.binding_id===row.binding_id&&pending.id!==row.id)this.store.state(pending.id,'cancelled','主用户通过QQ停止');
        this.store.prepareReply(row.id,[stopReply]);continue;
      }
      if(!this.attention?.enabled())await this.prepareMedia(row);if(this.closed||this.store.get(row.id)?.status==='cancelled')continue;
      const source=this.store.source(row);
      agent.followup(Object.freeze({id:row.message_id,role:'user',content:[{type:'text',text:row.body}],source}));
      await this.host.flush();this.store.queued(row.id);return;
    }
  }
  async reconcileCompletedAdmission(){
    if(this.closed||!this.ready||!this.binding||!this.host)return;
    const missing='上次投递缺少持久回执，保留原话等待核对，未盲目再次调用模型';
    const row=this.store.db.prepare("SELECT i.* FROM qq_inbox i WHERE i.binding_id=? AND i.status='interrupted' AND i.error=? AND i.event_seq IS NULL AND i.turn IS NULL AND i.updated_at>? AND NOT EXISTS(SELECT 1 FROM qq_inbox n WHERE n.binding_id=i.binding_id AND n.rowid>i.rowid) AND NOT EXISTS(SELECT 1 FROM qq_outbox o WHERE o.inbox_id=i.id) AND NOT EXISTS(SELECT 1 FROM qq_reply_plans p WHERE p.inbox_id=i.id) LIMIT 1").get(this.binding.id,missing,new Date(this.clock()-3600000).toISOString());
    if(!row)return;
    const agent=await this.host.ensureAgent(this.binding);if(this.closed||!this.ready||agent.session.header.id!==row.session_id)return;
    const checkKey=row.id+':'+agent.session.seq;if(this.admissionCheckKey===checkKey)return;this.admissionCheckKey=checkKey;
    const sources=[];let source,end,start;
    for(let seq=Math.max(0,agent.session.seq-2000);seq<agent.session.seq;seq++){const e=agent.session.eventAt(seq);if(e?.type==='user/message'&&e.data.id===row.message_id)sources.push(e);}
    if(sources.length!==1)return;source=sources[0];
    const principal=this.authority.ownerIdentity(source,agent.session.header);
    if(principal?.channel!=='qq'||principal.qq?.inboxId!==row.id||principal.qq?.recovery||principal.qq?.senderQQ!==this.binding.owner_qq||words(source.data.content)!==row.body)return;
    for(let seq=source.seq-1;seq>=Math.max(0,source.seq-1000);seq--){const e=agent.session.eventAt(seq);if(e?.type==='turn/start'){start=e;break;}}
    for(let seq=source.seq+1;seq<agent.session.seq;seq++){const e=agent.session.eventAt(seq);if(e?.type==='turn/start')return;if(e?.type==='turn/end'){end=e;break;}}
    if(!start||!end||end.data.turn!==start.data.turn||end.data.reason?.kind!=='completed'||(!Number.isFinite(start.time)||!Number.isFinite(end.time)||end.time<start.time||end.time-start.time>(this.settings.turnTimeoutMs??180000)))return;
    const recovered=this.journal.transaction(()=>{
      const n=this.store.db.prepare("UPDATE qq_inbox SET status='processing',event_seq=?,turn=?,error=NULL,updated_at=? WHERE id=? AND status='interrupted' AND error=? AND event_seq IS NULL AND turn IS NULL AND NOT EXISTS(SELECT 1 FROM qq_inbox n WHERE n.binding_id=qq_inbox.binding_id AND n.rowid>qq_inbox.rowid) AND NOT EXISTS(SELECT 1 FROM qq_outbox o WHERE o.inbox_id=qq_inbox.id) AND NOT EXISTS(SELECT 1 FROM qq_reply_plans p WHERE p.inbox_id=qq_inbox.id)").run(source.seq,end.data.turn,this.store.time(),row.id,missing).changes;
      if(n)this.replies.audit(row.id,'interrupted','admission_reconciled','真实原消息与正常完成回执匹配；未重投输入或再次调用模型');return n;
    });
    if(recovered)this.finish(agent.session,end,this.store.get(row.id));
  }
  event(session,event){
    if(!this.binding||session.header.id!==this.binding.session_id)return;
    if(event.type==='user/message'&&event.data.source?.principal?.kind===QQ_SOURCE){
      if(this.authority.ownerIdentity(event,session.header)?.channel!=='qq')return;
      let turn;for(let seq=event.seq-1;seq>=Math.max(0,event.seq-1000);seq--){const prior=session.eventAt(seq);if(prior?.type==='turn/start'){turn=prior.data.turn;break;}}
      if(turn===undefined)return;const row=this.store.get(event.data.source.principal.inboxId);this.store.claim(row.id,event.seq,turn);
      if(!this.timers.has(row.id)){const timer=setTimeout(()=>{this.timers.delete(row.id);if(this.store.get(row.id)?.status==='processing'){this.lastError='QQ单轮处理超时，已请求停止并保留回执';this.host?.getAgent(session.header.id)?.cancel({kind:'hook',reason:'QQ单轮处理超时'});}},this.settings.turnTimeoutMs??180000);timer.unref?.();this.timers.set(row.id,timer);}
    }
    if(event.type==='turn/end'){
      const row=this.store.db.prepare('SELECT * FROM qq_inbox WHERE session_id=? AND turn=?').get(session.header.id,event.data.turn);if(row)this.finish(session,event,row);
      void this.flush().catch(error=>{this.lastError=this.safe(error);});
    }
  }
  finish(session,end,row){
    clearTimeout(this.timers.get(row.id));this.timers.delete(row.id);
    if(['completed','replied','cancelled','deferred','silent','superseded','expired','superseded_partial','cancelled_partial','expired_partial','delivered_after_cancel'].includes(this.store.get(row.id)?.status))return;
    if(end.data.reason?.kind!=='completed'){this.replies.transition(row.id,'interrupted','原始回合未正常完成，未执行回应意图');this.store.state(row.id,'interrupted',`QQ回合结束：${end.data.reason?.kind??'unknown'}；未声称回复成功`);return;}
    let text='',found=false,finalSeq=null;const owners=[];
    for(let seq=end.seq-1;seq>=0;seq--){const event=session.eventAt(seq);if(event?.type==='turn/start')break;
      if(event?.type==='assistant/message'&&!event.data.interrupted&&!found){const candidate=words(event.data.message.content);if(candidate.trim()){text=candidate;found=true;finalSeq=event.seq;}}
      if(event?.type==='user/message'&&['user',QQ_SOURCE].includes(event.data.source?.kind))owners.push(event.data.id);
    }
    if(owners.length!==1||owners[0]!==row.message_id){this.replies.transition(row.id,'interrupted','本轮混入其他直接消息，未执行回应意图');this.store.state(row.id,'interrupted','本轮混入其他直接消息，未把网页或其他回合内容发送到QQ');return;}
    try{if(text)noSecret(text);if(text&&this.replies.plan(row.id)?.action!=='silent')this.host?.verifyReply?.({session,row,body:text,finalSeq});this.replies.finish(row.id,{turnTime:end.time,finalSeq,parts:replyParts(text)});}catch(error){this.replies.transition(row.id,'interrupted',this.safe(error));if(error.replyIntegrityBlocked)this.replies.audit(row.id,'processing','reply_integrity_blocked',this.safe(error));this.store.state(row.id,'interrupted',this.safe(error));}
  }
  flush(){if(this.closed)return Promise.resolve();this.replies.settle();if(this.sending)return this.sending;if(!this.ready)return Promise.resolve();this.sending=this.sendPending().finally(()=>{this.sending=null;});return this.sending;}
  /** Shared bound-recipient transport. Outgoing initiatives never fabricate an inbox row. */
  privateText(bindingId,body,{signal,beforeSend,onDispatch}={}){
    const operation=this.outgoingTail.then(async()=>{
      signal?.throwIfAborted();const binding=this.store.binding(bindingId),epoch=this.epoch;
      if(this.closed||!this.ready||!this.connection?.connected||!binding?.active||binding.id!==this.binding?.id||binding.owner_qq!==this.binding.owner_qq||binding.bot_qq!==this.binding.bot_qq)throw new Error('QQ连接或原绑定尚未核验，未发送');
      noSecret(body);if(typeof body!=='string'||!body.trim()||Array.from(body).length>1500)throw new Error('QQ出站文字超出单条范围');
      await beforeSend?.();signal?.throwIfAborted();
      if(this.closed||!this.ready||this.epoch!==epoch)throw new Error('发送准备期间QQ连接变化');
      onDispatch?.();let abort;
      try{
        const network=this.connection.call('send_private_msg',{user_id:Number(binding.owner_qq),message:[{type:'text',data:{text:body}}]});
        const result=signal?await Promise.race([network,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]):await network;
        return {messageId:wireId(result.message_id)};
      }catch(error){const failure=new Error(this.safe(error));failure.qqDispatched=true;throw failure;}
      finally{if(abort)signal.removeEventListener('abort',abort);}
    });this.outgoingTail=operation.catch(()=>{});return operation;
  }
  async sendPending(){
    while(!this.closed&&this.ready&&this.connection?.connected){
      const row=this.replies.outbox()[0];if(!row)break;
      const binding=this.store.binding(row.binding_id);if(!binding?.active||binding.id!==this.binding.id){this.store.sendState(row.id,'blocked',{error:'原绑定已失效，未改投其他账号'});continue;}
      this.store.sendState(row.id,'sending');
      try{const agent=this.host.verifyReply?await this.host.ensureAgent(binding):null;const result=await this.privateText(binding.id,row.body,{beforeSend:()=>{
        if(!this.host.verifyReply)return;
        const input=this.store.get(row.inbox_id),plan=this.replies.plan(row.inbox_id),parts=this.store.db.prepare('SELECT body FROM qq_outbox WHERE inbox_id=? ORDER BY part').all(row.inbox_id);
        if(input.body.trim()==='/stop'&&input.event_seq===null&&input.turn===null&&parts.length===1&&parts[0].body===stopReply)return;
        try{this.host.verifyReply({session:agent.session,row:input,body:parts.map(p=>p.body).join(''),finalSeq:plan?.final_seq});}catch(error){error.replyIntegrityBlocked=true;throw error;}
      }});const id=result.messageId;this.store.sendState(row.id,'sent',{platformId:id});const outcome=this.replies.outcome(row.inbox_id);if(outcome.delivered&&this.host.afterDelivery){const work=Promise.resolve().then(()=>this.host.afterDelivery(row.inbox_id,this.deliveryStop.signal)).catch(error=>{this.lastError=this.safe(error);}).finally(()=>this.deliveries.delete(work));this.deliveries.add(work);}}
      catch(error){if(error.replyIntegrityBlocked&&!error.qqDispatched){const reason=this.safe(error);this.store.db.prepare("UPDATE qq_outbox SET status='blocked',error=?,updated_at=? WHERE inbox_id=? AND status IN ('pending','sending')").run(reason,this.store.time(),row.inbox_id);this.replies.transition(row.inbox_id,'interrupted',reason);this.replies.audit(row.inbox_id,'ready','reply_integrity_blocked',reason);this.store.state(row.inbox_id,'interrupted',reason);this.lastError=reason;}else{this.store.sendState(row.id,'unknown',{error:'发送结果未确认，不自动重发以免重复。'+this.safe(error)});this.replies.outcome(row.inbox_id);this.lastError='有QQ回复的发送结果未确认，可在网页查询回执';}}
      if(!this.closed&&this.ready)await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  close(){
    if(this.closing)return this.closing;this.closed=true;this.ready=false;this.deliveryStop.abort();clearInterval(this.tick);for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();
    this.closing=(async()=>{try{await this.reliability?.close();await this.connection?.stop();await Promise.allSettled([this.driving,this.sending,...this.deliveries].filter(Boolean));await this.host?.close();}finally{this.unregister();}})();return this.closing;
  }
}
