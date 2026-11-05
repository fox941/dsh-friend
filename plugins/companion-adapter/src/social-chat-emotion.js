import {chatNamingReferences,namingReferencesCurrent} from './social-chat-names.js';
import {randomUUID} from 'node:crypto';
import {hash,noSecret} from './validation.js';
import {socialExperienceBasis,singleExperienceSource,knownSingleSocialSource} from './social-experience-source.js';
import {sealObservationSource} from './activity-source.js';
import {experienceWindow} from './social-episode-window.js';
import {episodeExperienceSource} from './social-episode-source.js';
import {learningForbidden} from './attention-affect.js';

/** Optional chat proposals, durable independent audit, no second behavioral choice. */
export class SocialChatEmotion {
 constructor(parent){
  this.parent=parent;this.a=parent.a;this.db=parent.db;this.closed=false;this.running=null;this.stop=new AbortController();this.frames=new WeakMap();this.lastError=null;
  this.db.exec('CREATE TABLE IF NOT EXISTS social_chat_emotion_jobs(id TEXT PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,value_json TEXT NOT NULL,value_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS social_chat_emotion_status ON social_chat_emotion_jobs(status);');
  this.db.prepare("INSERT OR IGNORE INTO social_experience_meta VALUES('space-chat-emotion-cutoff',?)").run(String(this.db.prepare('SELECT coalesce(max(rowid),0) n FROM platform_events').get().n));
  this.db.prepare("INSERT OR IGNORE INTO social_experience_meta VALUES('chat-emotion-cutoff',?)").run(String(this.db.prepare('SELECT coalesce(max(rowid),0) n FROM platform_events').get().n));
  const g=this.a.growth,previous=g.sourceUsable;
  this.sourceUsable=id=>{if(previous?.(id)===false)return false;if(!id)return true;const r=this.db.prepare('SELECT id FROM social_chat_emotion_jobs WHERE source_id=?').get(id);return !r||knownSingleSocialSource(this.a,this.read(r.id));};g.sourceUsable=this.sourceUsable;
  this.restore=()=>{if(g.sourceUsable===this.sourceUsable)g.sourceUsable=previous;};
  for(const r of this.db.prepare("SELECT id FROM social_chat_emotion_jobs WHERE status='running'").all()){const j=this.read(r.id),receipt=this.receipt(j);this.save(j,receipt?'completed':'interrupted',{receipt,reason:'重启仅核对已有审核回执，不重放模型或对外消息'});}
 }
 enabled(){return !this.closed&&this.parent.enabled();}
 read(id){const row=this.db.prepare('SELECT * FROM social_chat_emotion_jobs WHERE id=?').get(id);if(!row)return null;if(hash(row.value_json)!==row.value_hash)throw Error('聊天情绪记录校验失败');return {...JSON.parse(row.value_json),id:row.id,status:row.status};}
 save(job,status,patch={}){const value={...job,...patch},raw=JSON.stringify(value);noSecret(raw);this.db.prepare('UPDATE social_chat_emotion_jobs SET status=?,value_json=?,value_hash=?,updated_at=? WHERE id=?').run(status,raw,hash(raw),this.parent.a.attention.store.time(),job.id);return this.read(job.id);}
 status(){return {enabled:this.enabled(),running:Boolean(this.running),lastError:this.lastError,counts:Object.fromEntries(this.db.prepare('SELECT status,count(*) n FROM social_chat_emotion_jobs GROUP BY status').all().map(r=>[r.status,r.n])),recent:this.db.prepare('SELECT id,event_id,status,updated_at FROM social_chat_emotion_jobs ORDER BY rowid DESC LIMIT 8').all(),scope:'QQ群、普通好友和空间评论的可选临时感受；空提案零审核，非空复用独立审核与共享额度，不修改兴趣、性格、画像，不代表必回'};}
 async source(job,signal,options={}){
  if(!this.enabled())return null;const event=this.a.platforms.store.event(job.eventId);if(event?.kind==='qzone_comment'&&this.a.platforms.qzoneInbox?.policy().enabled!==true)return null;const single=await singleExperienceSource(this.a,job,signal,{allowQueued:true,includeReply:false,includeSpaceContext:true,sourceCache:options.sourceCache});
  if(!single)return null;const current=sealObservationSource({...single,sessionId:'qq-chat-emotion:'+this.a.platforms.store.event(job.eventId).thread_key});
  return episodeExperienceSource(this.a,job,current,signal,()=>{throw Error('聊天即时感受不读取历史原件');});
 }
 async context(event,signal,memoryFrame,options={}){try{
  if(!this.enabled()||!['group','friend','qzone_comment'].includes(event.kind)||event.status!=='queued'||event.raw.historyRecovery)return {allowed:false};
  const row=this.db.prepare('SELECT rowid n FROM platform_events WHERE id=?').get(event.id),cutoff=Number(this.db.prepare("SELECT value FROM social_experience_meta WHERE key='chat-emotion-cutoff'").get().value),spaceCutoff=Number(this.db.prepare("SELECT value FROM social_experience_meta WHERE key='space-chat-emotion-cutoff'").get().value);
  if(!row||row.n<=Math.max(cutoff,event.kind==='qzone_comment'?spaceCutoff:0)||this.db.prepare('SELECT 1 FROM social_chat_emotion_jobs WHERE event_id=?').get(event.id))return {allowed:false};
  const basis=socialExperienceBasis(this.a,event,{allowQueued:true});if(!basis)return {allowed:false};
  const windowCutoff=Number(this.db.prepare("SELECT value FROM social_experience_meta WHERE key='window-v2-cutoff'").get().value),job={...basis,eventId:event.id,sourceId:hash('qq-chat-emotion:'+event.thread_key+':'+event.id+':0'),rawHash:event.raw_hash,account:event.account,sender:event.sender,queuedSource:true,episodeProtocol:1,episodeWindow:experienceWindow(this.a,event,Math.max(windowCutoff,event.kind==='qzone_comment'?spaceCutoff:0))};
  const source=await this.source(job,signal,options);if(!source||learningForbidden(source.content))return {allowed:false};
  const namingReferences=await chatNamingReferences(this.a,event,memoryFrame,signal,options.sourceCache);const feelings=this.a.growth.emotions.read(),episodes=feelings.episodes.filter(e=>{const s=this.a.growth.store.event(e.sourceId);return s?.origin?.scope===event.thread_key&&s.origin.account===event.account&&e.effectiveStatus!=='needs_review';}).slice(0,8).map(e=>({episodeId:e.episodeId,label:e.label,topic:e.topic,status:e.status,intensityLevel:e.intensityLevel}));
  const frame={allowed:true,source:{eventId:event.id,content:source.content,uncertain:source.origin.mediaUncertain===true},feelings:{revision:feelings.revision,episodes},boundary:'仅本次冻结原件可作逐字引文。允许零变化，不要求回复；这不是独立审核通过。既有感受只展示同会话的简要事项，不加载其他人的私密原文。'};
  this.frames.set(frame,{...job,namingReferences,expectedRevision:feelings.revision,sourceHash:hash(JSON.stringify(source)),expiresAt:Date.parse(this.a.attention.store.time())+900000});Object.freeze(frame.source);Object.freeze(frame.feelings);return Object.freeze(frame);
 }catch{signal?.throwIfAborted();return {allowed:false};}}
 enqueue(event,proposals,frame){
  if(proposals===undefined||Array.isArray(proposals)&&proposals.length===0)return {status:'no_proposals'};
  const old=this.db.prepare('SELECT id,status FROM social_chat_emotion_jobs WHERE event_id=?').get(event.id);if(old)return {status:old.status,id:old.id,duplicate:true};
  const frozen=this.frames.get(frame);if(!this.enabled()||!frozen||frozen.eventId!==event.id||!knownSingleSocialSource(this.a,frozen))return {status:'not_eligible'};
  if(this.db.prepare("SELECT count(*) n FROM social_chat_emotion_jobs WHERE status='pending'").get().n>=100)return {status:'queue_full'};
  let status='pending',args;try{
   if(!Array.isArray(proposals)||proposals.length>4||JSON.stringify(proposals).length>14000)throw Error('Invalid optional proposal');
   const fields=['action','episodeId','label','topic','statement','reason','appraisal','intensity','duration','evidenceQuote','dependsOn'];
   if(proposals.some(p=>!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!fields.includes(k))))throw Error('Invalid optional fields');
   noSecret(JSON.stringify(proposals));args={expectedRevision:frozen.expectedRevision,proposals};this.a.growth.emotions.validate(args,{content:frame.source.content});
   // Only same-scene IDs presented to this chat may be modified.
   if(proposals.some(p=>p.episodeId&&!frame.feelings.episodes.some(e=>e.episodeId===p.episodeId)))throw Error('Unpresented episode');
  }catch{status='rejected';args=null;}
  const id=randomUUID(),at=this.a.attention.store.time(),value={...frozen,id,args,disposition:event.status==='queued'?'defer':event.status,reason:status==='pending'?'等待独立情绪审核；不阻塞聊天':'可选情绪提案不合规，聊天处理保留'},raw=JSON.stringify(value);
  this.db.prepare('INSERT INTO social_chat_emotion_jobs VALUES(?,?,?,?,?,?,?,?)').run(id,event.id,frozen.sourceId,status,raw,hash(raw),at,at);return {status,id};
 }
 receipt(job){const row=this.db.prepare('SELECT id,receipt_json FROM emotion_batches WHERE source_id=? AND receipt_json IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(job.sourceId);return row?{batchId:row.id,...JSON.parse(row.receipt_json)}:null;}
 pump(){
  const a=this.a;if(this.running||!this.enabled()||!this.parent.host?.emotion||!a.qq.ready||a.platforms.active||this.parent.active||a.growth.emotions.inflight||a.attention.choosing||a.attention.store.running?.().length||a.activities.active||a.nightly?.active||a.applications?.active||a.profileChanges?.active||a.platforms.host?.busy?.())return this.running??Promise.resolve();
  this.running=this.work().catch(()=>{this.lastError='聊天情绪审核未完成；普通聊天与原状态保留';}).finally(()=>{this.running=null;});return this.running;
 }
 async work(){
  const row=this.db.prepare("SELECT id FROM social_chat_emotion_jobs WHERE status='pending' ORDER BY rowid LIMIT 1").get();if(!row)return;
  let job=this.read(row.id);if(Date.parse(this.a.attention.store.time())>job.expiresAt)return this.save(job,'expired',{reason:'临时感受提案超过15分钟，不迟到补写'});
  const g=this.a.growth;if(g.store.budget()>=g.config.dailyReviewLimit)return;
  const signal=AbortSignal.any([this.stop.signal,AbortSignal.timeout(g.config.reviewTimeoutMs)]);
  job=this.save(job,'running');try{
   const source=await this.source(job,signal);if(!source||hash(JSON.stringify(source))!==job.sourceHash||!await namingReferencesCurrent(this.a,this.a.platforms.store.event(job.eventId),job.namingReferences??[],signal))return this.save(job,'source_changed',{reason:'原件、账号、学习许可或已读媒体证据已变化'});
   const guard=async()=>{const s=await this.source(job,signal);return Boolean(s&&hash(JSON.stringify(s))===job.sourceHash&&await namingReferencesCurrent(this.a,this.a.platforms.store.event(job.eventId),job.namingReferences??[],signal)&&Date.parse(this.a.attention.store.time())<=job.expiresAt);};
   const receipt=await g.emotions.propose(job.args,source,(frame,s)=>this.parent.host.emotion(frame,s),signal,{...job.namingReferences?.length?{assessment:{kind:'qq_chat_context',namingReferences:job.namingReferences}}:{},guard,beforeCommit:async()=>{try{const snapshot=await this.parent.host.snapshot(job.id,signal);job=this.save(this.read(job.id),'running',{snapshot});}catch(error){this.save(this.read(job.id),'running',{snapshotError:true});throw error;}}});
   this.lastError=null;return this.save(this.read(job.id),'completed',{receipt,reason:'按独立审核实际回执处理；完成不保证状态有变化'});
  }catch(error){this.lastError='聊天情绪审核未完成；普通聊天与原状态保留';let detail=String(error?.message??error).slice(0,300);try{noSecret(detail);}catch{detail='敏感诊断已省略';}return this.save(this.read(job.id),this.read(job.id).snapshotError?'backup_blocked':signal.aborted?'interrupted':'failed',{receipt:this.receipt(job),error:detail,reason:this.lastError});}
 }
 async close(){this.closed=true;this.stop.abort();await this.running;this.restore();}
}
