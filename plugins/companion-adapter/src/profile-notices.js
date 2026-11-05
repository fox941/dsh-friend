import {isSocialNotice,socialOriginalResponse,sendSocialNotice,socialNoticeRevision,socialNoticeDestination} from './profile-notice-social.js';
import {ProactiveStore} from './proactive-store.js';
import {proactiveDecision} from './proactive-reviewer.js';
import {profileNoticeSource,noticeOutcome,noticeSignature} from './profile-notice-source.js';
import {hash,noSecret} from './validation.js';
const closed=new Set(['sent','silent','expired','cancelled','unknown','rejected','duplicate','unconfirmed','observed']);
export class ProfileNotices{
 constructor(adapter,{now=()=>new Date()}={}){
  Object.assign(this,{a:adapter,now});this.raw=adapter.journal.db;this.store=new ProactiveStore(adapter.journal,now,{namespace:'profile_notice_'});this.host=null;this.active=null;this.collecting=null;this.closed=false;this.stop=new AbortController();this.lastError=null;
  this.raw.exec('CREATE TABLE IF NOT EXISTS profile_notice_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS profile_notice_observed(job_id TEXT PRIMARY KEY,signature TEXT NOT NULL);CREATE TABLE IF NOT EXISTS profile_notice_receipts(item_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL);');
  if(!this.raw.prepare("SELECT 1 FROM profile_notice_meta WHERE key='initialized'").get())adapter.journal.transaction(()=>{for(const r of this.raw.prepare("SELECT id FROM profile_change_jobs WHERE status!='ignored'").all()){const j=adapter.profileChanges.store.job(r.id);this.seen(j);}this.raw.prepare("INSERT INTO profile_notice_meta VALUES('initialized',?)").run(this.now().toISOString());});
 }
 bind(host){this.host=host;}
 seen(job){this.raw.prepare('INSERT INTO profile_notice_observed VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET signature=excluded.signature').run(job.id,noticeSignature(job,this.a.applications));}
 enabled(){return !this.closed&&this.a.writeEnabled!==false&&this.a.policy().writeEnabled&&this.a.attention.enabled();}
 paused(){return Boolean(this.store.control().paused||this.a.proactive?.store.control().paused);}
 status(){const raw=this.store.status();return {enabled:this.enabled(),hostReady:Boolean(this.host),running:Boolean(this.active),lastError:this.lastError,...raw,published:[...raw.published,...this.observedRecords()].map(p=>({...p,receipt:p.observed?'原评论下已观察到匹配回复；不证明提交归属、对方可见或已读':p.source.destination.channel==='bilibili'?'B站平台消息ID与精确读回已核验；不代表已读':'OneBot已返回消息ID；不代表已读'})),scope:'画像更正结果自主回报；原QQ/B站私聊、原群或原空间评论；未知结果不重发，公开回报不含私密旧值'};}
 originalResponse(source){const j=this.a.profileChanges.store.job(source.jobId);if(!j)return [];if(isSocialNotice(source))return socialOriginalResponse(this.a,source);if(source.destination.channel==='qq')return this.raw.prepare("SELECT body,platform_id,updated_at FROM qq_outbox WHERE inbox_id=? AND status='sent' ORDER BY rowid DESC LIMIT 3").all(j.source.eventId).map(r=>({body:r.body,platformId:r.platform_id,at:r.updated_at,receipt:'平台已确认发送，不代表已读'}));return this.raw.prepare("SELECT body,platform_id,receipt_json,updated_at FROM bili_social_outbox WHERE turn_id=? AND status='sent' LIMIT 1").all(j.source.turnId).filter(r=>JSON.parse(r.receipt_json??'{}').readBackVerified===true).map(r=>({body:r.body,platformId:r.platform_id,at:r.updated_at,receipt:'精确读回通过，不代表已读'}));}
 source(jobId,signal){return profileNoticeSource(this.a,jobId,signal);}
 async liveSource(item,signal){const source=await this.source(item.source.jobId,signal);return source&&hash(JSON.stringify(source))===item.source_hash?source:null;}
 collect(){if(this.collecting)return this.collecting;this.collecting=this.gather().catch(e=>{this.lastError=this.safe(e);}).finally(()=>{this.collecting=null;});return this.collecting;}
 async gather(){
  if(!this.enabled())return;const signal=AbortSignal.any([this.stop.signal,AbortSignal.timeout(20000)]);
  // Reconcile committed sends before exposing more candidates after a restart.
  for(const r of this.store.db.prepare("SELECT id,intent_id,status FROM proactive_items WHERE status IN ('sent','unknown','unconfirmed','observed') AND intent_id IS NOT NULL").all())if(!this.a.attention.store.terminal(r.intent_id))this.a.attention.complete(r.intent_id,{status:r.status,itemId:r.id,receiptOnly:true});
  const rows=this.raw.prepare("SELECT id FROM profile_change_jobs WHERE status!='ignored' ORDER BY rowid DESC LIMIT 64").all();
  for(const r of rows){signal.throwIfAborted();const job=this.a.profileChanges.store.job(r.id),prior=this.raw.prepare('SELECT signature FROM profile_notice_observed WHERE job_id=?').get(job.id);if(!noticeOutcome(job)||prior?.signature===noticeSignature(job,this.a.applications))continue;if(this.store.live().length>=20)break;
   const source=await this.source(job.id,signal);if(source)this.store.offer(source,JSON.stringify(source.destination),86400000);this.seen(job);
  }
  for(const item of this.store.live()){
   if(item.expires_at<=this.now().valueOf()||!await this.liveSource(item,signal)){this.cancel(item,'expired','结果已变化、撤销、被新更正替代或机会过期');continue;}
   if(!item.intent_id){const row=this.a.attention.offer({key:'profile-notice:'+item.id,kind:'proactive',scope:'owner',summary:'先前画像更正的实际结果：'+JSON.parse(item.source.text).status+'；可告知、暂缓或安静',payload:{profileNoticeId:item.id}});this.store.link(item.id,row.id);}
  }
 }
 safe(e){try{const s=String(e?.message??e).slice(0,500);noSecret(s);return s;}catch{return '结果回报暂未完成';}}
 cancel(item,status,reason){this.store.discard(item.id,reason);this.store.state(item.id,status);if(item.intent_id&&!this.a.attention.store.terminal(item.intent_id))this.a.attention.complete(item.intent_id,{status,itemId:item.id,reason});}
 preview(row){const item=this.store.get(row.payload.profileNoticeId);if(!item)return {state:'missing'};return {itemId:item.id,destination:item.source.destination.channel,status:item.status,requestQuote:item.source.requestQuote,result:item.source.text,boundary:item.source.scope};}
 readiness(row){const item=this.store.get(row.payload.profileNoticeId);if(!item||closed.has(item.status)){this.a.attention.complete(row.id,{status:item?.status??'missing'});return {waiting:false};}if(!this.enabled()||this.paused())return {waiting:true,wake:{kind:'proactive_resume'},reason:'结果回报已暂停'};if(item.source.destination.channel==='qq'&&!this.a.qq.ready)return {waiting:true,wake:{kind:'qq_ready'},reason:'原QQ账号尚未恢复'};if(item.source.destination.channel==='bilibili'&&!this.a.bilibiliSocial.outgoing())return {waiting:true,wake:{kind:'time',at:this.now().valueOf()+60000},reason:'B站原私聊出站暂不可用'};if(this.active||this.a.profileChanges.active||this.a.applications.active)return {waiting:true,wake:{kind:'time',at:this.now().valueOf()+30000},reason:'等待当前记忆处理完成，再核对结果'};return null;}
 version(){return hash(JSON.stringify([this.a.attention.store.meta().epoch,this.a.growth.store.revision(),this.a.growth.emotions.store.revision(),this.a.qq.epoch,socialNoticeRevision(this.a),this.raw.prepare('SELECT max(rowid) n FROM qq_inbox').get().n,this.raw.prepare('SELECT max(rowid) n FROM bili_inbox_events').get().n,this.raw.prepare('SELECT family,version_id FROM profile_change_heads ORDER BY family').all()]));}
 park(row,reason,wake={kind:'time',at:this.now().valueOf()+60000}){if(this.a.attention.store.terminal(row.id))return {status:'closed'};this.a.attention.store.patch(row.id,'waiting',{wake,result:{reason}});return {pending:true};}
 async execute(row,parentSignal){
  const ready=this.readiness(row);if(this.a.attention.store.terminal(row.id))return {status:'closed'};if(ready?.waiting)return this.park(row,ready.reason,ready.wake);if(!this.host)throw Error('结果表达模型尚未就绪');
  const item=this.store.get(row.payload.profileNoticeId),signal=AbortSignal.any([parentSignal,this.stop.signal,AbortSignal.timeout(120000)]);this.active={id:item.id};const version=this.version();
  const fresh=async()=>{signal.throwIfAborted();if(this.version()!==version||!this.enabled()||this.paused()||item.expires_at<=this.now().valueOf()||!await this.liveSource(item,signal))throw Error('新消息、状态或更正结果发生变化，未提交旧稿');};
  try{
   const source=await this.liveSource(item,signal);if(!source){this.cancel(item,'expired','原结果已失效');return {status:'source_changed'};}
   const state=await this.host.state(source,signal),frame={source,state,recentPublished:this.publications(source.destination),destination:isSocialNotice(source)?'原群或原空间评论（公开表达边界）':source.destination.channel+'原主用户私聊'},decision=proactiveDecision((await this.host.review('compose',frame,signal)).decision,source);await fresh();
   if(decision.action==='silent'){this.store.state(item.id,'silent');return {status:'silent',reason:decision.reason};}
   if(decision.action==='defer')return this.park(row,decision.reason,decision.wake.kind==='time'?{kind:'time',at:this.now().valueOf()+decision.wake.afterSeconds*1000}:decision.wake);
   const audit=(await this.host.review('audit',{source,state,draft:decision.body},signal)).decision;if(typeof audit?.allow!=='boolean'||typeof audit.reason!=='string'||audit.reason.length>700)throw Error('结果出站核验格式无效');
   if(!audit.allow){this.store.state(item.id,'rejected');return {status:'rejected',reason:audit.reason};}await fresh();this.store.prepare(item.id,decision.body);
   let receipt;
   if(isSocialNotice(source))receipt=await sendSocialNotice(this.a,source,decision.body,{itemId:item.id,attemptId:this.store.get(item.id).attempt_id,signal,beforeSend:fresh,check:()=>{signal.throwIfAborted();if(this.version()!==version||!this.enabled()||this.paused()||JSON.stringify(socialNoticeDestination(this.a,this.a.profileChanges.store.job(source.jobId).source))!==JSON.stringify(source.destination))throw Error('提交前状态已变化');},onDispatch:()=>this.store.attempt(item.id,'sending')});
   else if(source.destination.channel==='qq'){const r=await this.a.qq.privateText(source.destination.bindingId,decision.body,{signal,beforeSend:fresh,onDispatch:()=>this.store.attempt(item.id,'sending')});receipt={platformId:r.messageId,apiAccepted:true};}
   else receipt=await this.a.bilibiliSocial.sendPrivateResult({eventId:source.jobId?this.a.profileChanges.store.job(source.jobId).source.eventId:null,account:source.destination.account,peer:source.destination.peer,body:decision.body,operationId:this.store.get(item.id).attempt_id,signal,beforeSend:fresh,onDispatch:()=>this.store.attempt(item.id,'sending')});
   this.raw.prepare('INSERT OR REPLACE INTO profile_notice_receipts VALUES(?,?)').run(item.id,JSON.stringify(receipt));
   if(isSocialNotice(source)&&source.destination.kind==='qzone_comment'){const state=receipt.observed===true?'observed':'unconfirmed';this.lastError=null;this.store.attempt(item.id,state,{platformId:receipt.platformId??null,error:state==='observed'?'原评论下已观察到匹配回复，不证明对方可见或已读':'空间受理尚未读回，不自动重发'});return {status:state,itemId:item.id};}
   if(source.destination.channel==='bilibili'&&receipt.readBackVerified!==true){this.store.attempt(item.id,'unconfirmed',{platformId:receipt.platformId,error:'平台已受理，尚未通过精确读回；不自动重发'});return {status:'unconfirmed',itemId:item.id};}
   this.store.attempt(item.id,'sent',{platformId:receipt.platformId});this.lastError=null;return {status:'sent',itemId:item.id,platformId:receipt.platformId,independentMemoryEvidence:false};
  }catch(e){this.lastError=this.safe(e);const current=this.store.get(item.id);if(current?.status==='sending'||e.qqDispatched||e.dispatched){this.store.attempt(item.id,'unknown',{error:'发送结果不明，不自动重发。'+this.lastError});return {status:'unknown',itemId:item.id};}if(e.code==='PROACTIVE_DUPLICATE'){this.store.state(item.id,'duplicate');return {status:'duplicate'};}this.store.discard(item.id,this.lastError);if(signal.aborted)throw e;return this.park(row,this.lastError);
  }finally{this.active=null;}
 }
 observedRecords(){return this.store.db.prepare("SELECT a.id,a.body,a.platform_id,a.updated_at at,i.source_json FROM proactive_attempts a JOIN proactive_items i ON i.id=a.item_id WHERE a.status='observed' ORDER BY a.rowid DESC LIMIT 20").all().map(r=>({...r,source:JSON.parse(r.source_json),observed:true}));}
 publications(dest){return [...this.store.publications(20),...this.observedRecords()].sort((a,b)=>String(b.at).localeCompare(String(a.at))).filter(p=>(!dest.audience||dest.audience==='private'||isSocialNotice(p.source))&&p.source.destination?.channel===(dest.channel??dest.platform)&&p.source.destination.scene===dest.scene).slice(0,4).map(p=>({body:p.body,platformId:p.platform_id,at:p.at,kind:'profile_change_result',receipt:p.observed?'原评论下已观察到同文回复；不证明提交归属或对方可见，不构成新事实证据':'已确认发送；不代表已读，不构成新的事实证据'}));}
 control(action){if(action==='pause')this.store.pause(true);if(action==='resume')this.store.pause(false);if(action==='cancel_pending')for(const item of this.store.live())this.cancel(item,'cancelled','主用户取消未发结果回报');}
 capability(){return {stateKey:()=>hash(JSON.stringify(this.store.status().recent)),capabilities:()=>[],boundary:'proactive中profileNoticeId是先前主用户画像更正的实际结果回报，非视频、非新增记忆；可回报、暂缓或忽略。',claims:r=>r.kind==='proactive'&&Boolean(r.payload.profileNoticeId),preview:r=>r.payload.profileNoticeId?this.preview(r):undefined,dismiss:r=>{if(!r.payload.profileNoticeId)return false;const item=this.store.get(r.payload.profileNoticeId);if(item&&!closed.has(item.status))this.cancel(item,'silent','模型选择暂不通知');return true;},readiness:r=>r.payload.profileNoticeId?this.readiness(r):undefined,execute:(r,s)=>this.execute(r,s),collect:()=>this.collect()};}
 async close(){this.closed=true;this.stop.abort();await this.collecting?.catch(()=>{});}
}
