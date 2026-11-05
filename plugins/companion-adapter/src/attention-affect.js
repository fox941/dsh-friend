import {hash,noSecret} from './validation.js';
import {sealObservationSource} from './activity-source.js';
import {emotionBatchId,emotionCauseKeys} from './emotion.js';
import {eligibleHeader} from './preview-sessions.js';
import {ownerIdentity} from './source-identity.js';

// Byte-identical copy of the bilibili-social-store noLearning filter; a shared
// regression test pins both copies to the same behaviour.
export const noLearning=events=>events.some(e=>/(?:不要|不必|无需|不需要|别).{0,10}(?:保存|学习|记住|记忆)|不保存|不学习|接入测试|收发测试|测试消息|do not (?:save|remember)|don't (?:save|remember)/i.test(e.payload.text));

const prefix='affect:';
const proposalKeys=new Set(['action','episodeId','label','topic','statement','reason','appraisal','intensity','duration','evidenceQuote','dependsOn']);
export const learningForbidden=text=>noLearning([{payload:{text}}])||/(?:只(?:读|查询|查看|读取)|(?:不要|不做|不进行|别).{0,8}(?:写入|更新|修改).{0,8}(?:情绪|状态|记忆))/.test(text);
function proposal(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!proposalKeys.has(k)))throw new Error('情绪提案字段无效');
  noSecret(JSON.stringify(value));return JSON.parse(JSON.stringify(value));
}
const sourceHash=source=>hash(JSON.stringify([source.sessionId,source.messageId,source.seq,source.occurredAt,source.content]));
const words=message=>(message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');

export function perceptionSource(adapter,row,record,header){
  if(row.status==='cancelled'||!adapter.growth.config.enabled||!adapter.growth.writeEnabled())return null;
  let original,origin,occurredAt=row.created_at;
  if(row.kind==='message'){
    if(!eligibleHeader(header,adapter.workspace)||header.id!==row.payload.sessionId)return null;
    const identity=ownerIdentity({type:'user/message',data:row.payload.message},header);if(!identity)return null;
    original=words(row.payload.message);
    const inboxId=row.payload.message.source?.principal?.inboxId;
    if(inboxId){const inbox=adapter.qq.store.get(inboxId);if(!inbox||inbox.status==='cancelled')return null;occurredAt=inbox.created_at;}
    origin={platform:identity.channel,principal:identity,sessionId:header.id,messageId:row.payload.message.id,privacy:'private',causeKeys:emotionCauseKeys({sessionId:header.id,messageId:row.payload.message.id,origin:identity})};
  }else if(row.kind==='bilibili'){const sourced=adapter.bilibili?.perceptionSource?.(row,record);if(!sourced)return null;original=sourced.original;origin=sourced.origin;occurredAt=sourced.occurredAt;
  }else if(row.payload.platformEventId){const e=adapter.platforms?.store.event(row.payload.platformEventId);if(!e||!['group','friend'].includes(e.kind)||['ignored','cancelled','withdrawn'].includes(e.status)||e.account!==adapter.qq.binding?.bot_qq)return null;original=e.body;occurredAt=e.created_at;origin={platform:'qq',eventId:e.id,sender:e.sender,account:e.account,privacy:e.kind==='group'?'public':'private',thread:e.thread_key,causeKeys:['qq-social:'+e.id]};
  }else return null;
  if(typeof original!=='string'||learningForbidden(original)||original.slice(0,700)!==record.text)return null;
  return sealObservationSource({owner:false,sessionId:'perception:'+row.id,messageId:row.id,seq:0,occurredAt,content:record.text,context:[],origin:{kind:'external_observation',channel:'attention_perception',intentId:row.id,...origin,previewOnly:true,truncated:original.length>record.text.length,presentedCharacters:record.text.length,sourceCharacters:original.length,presentedAt:record.seenAt,publication:'此来源仅证明向模型呈现了预览，不证明她已回复或接受约定'}});
}

/** Reuses attention checkpoints and the existing emotion controller, without another state store. */
export class AttentionAffect {
  constructor({attention,growth}){
    Object.assign(this,{attention,growth});this.store=attention.store;this.host=null;this.active=null;this.lastError=null;
    this.store.db.exec("CREATE INDEX IF NOT EXISTS attention_affect_status ON attention_checkpoints(json_extract(value_json,'$.status')) WHERE task_id LIKE 'affect:%'");
    // A crash after commit must acknowledge that commit, never repeat the appraisal.
    for(const row of this.rows('processing')){
      const receipt=row.batchId?growth.emotions.store.batch(row.batchId)?.receipt:null;
      this.save({...row,status:receipt?'completed':'interrupted',receipt:receipt??null,error:receipt?null:'审核中断，未自动重试；已提交批次已先核对'});
    }
  }
  bind(host){this.host=host;}
  key(kind,id){return `${prefix}${kind}:${id}`;}
  read(kind,id){return this.store.readCheckpoint(this.key(kind,id));}
  save(row){this.store.checkpoint(this.key(row.kind,row.intentId),{...row,updatedAt:this.store.time()});}
  rows(status,limit=100){
    return this.store.db.prepare("SELECT value_json FROM attention_checkpoints WHERE task_id LIKE 'affect:%' AND json_extract(value_json,'$.status')=? ORDER BY rowid LIMIT ?").all(status,limit).map(r=>JSON.parse(r.value_json));
  }
  status(){
    const counts=this.store.db.prepare("SELECT json_extract(value_json,'$.status') status,count(*) count FROM attention_checkpoints WHERE task_id LIKE 'affect:%' GROUP BY status").all();
    const recent=this.store.db.prepare("SELECT value_json FROM attention_checkpoints WHERE task_id LIKE 'affect:%' ORDER BY updated_at DESC,rowid DESC LIMIT 8").all().map(({value_json})=>{
      const r=JSON.parse(value_json);return {intentId:r.intentId,kind:r.kind,status:r.status,presentedCharacters:r.text?.length??0,previewOnly:r.kind==='perception',receipt:r.receipt??null,error:r.error??null,updatedAt:r.updatedAt};
    });
    return {processing:Boolean(this.active),counts,recent,lastError:this.lastError,scope:'只提交有来源的情绪变化；未回复不是已交流，反思不是新增外部证据'};
  }
  describe(row,preview){
    const eligible=['message','bilibili'].includes(row.kind)&&typeof preview==='string'&&Boolean(preview.trim())&&!learningForbidden(preview)&&this.growth.config.enabled&&this.growth.writeEnabled();
    return {eligible,alreadyPresented:Boolean(this.read('perception',row.id)),presentedCharacters:typeof preview==='string'?preview.length:0,previewOnly:true};
  }
  capture({frame,decision,call}){
    const malformed=decision.affect!=null&&(!Array.isArray(decision.affect)||decision.affect.length>3);
    const requested=!malformed&&Array.isArray(decision.affect)?decision.affect:[];
    this.store.journal.transaction(()=>{
      for(const item of frame.candidates){
        const row=this.store.get(item.id);if(!row||!['message','bilibili'].includes(row.kind)||this.read('perception',row.id))continue;
        const permitted=item.perception?.eligible===true&&typeof item.preview==='string';
        const record={version:1,kind:'perception',intentId:row.id,decisionId:call,seenAt:this.store.time(),status:permitted?'seen':'skipped',text:permitted?item.preview:null,previewHash:typeof item.preview==='string'?hash(item.preview):null,expectedRevision:frame.emotionRevision??this.growth.emotions.store.revision(),error:null};
        if(permitted&&row.id===decision.targetId)record.status='delegated';
        else if(permitted){
          if(malformed){record.status='invalid';record.error='附带情绪提案应为最多3个原件的数组';this.save(record);continue;}
          const entries=requested.filter(p=>p?.intentId===row.id);
          if(entries.length===1)try{
            const entry=entries[0];
            if(entry.proposal&&entry.proposals||entry.proposals!==undefined&&(!Array.isArray(entry.proposals)||entry.proposals.length<1||entry.proposals.length>4))throw new Error('每个原件需要1–4项情绪提案');
            record.proposals=(entry.proposals??[entry.proposal]).map(proposal);record.status='pending';
          }catch(error){record.status='invalid';record.error=this.safe(error);}
          else if(entries.length>1){record.status='invalid';record.error='同一原件不能提交重复的感知情绪提案';}
        }
        this.save(record);
      }
    });
  }
  reflectionFrame(){
    const emotion=this.growth.emotions.read(),candidates=[];
    for(const episode of emotion.episodes){
      if(candidates.length===4)break;
      if(episode.status!=='active'||episode.effectiveStatus==='needs_review')continue;
      const source=this.growth.store.event(episode.sourceId);
      if(!source||learningForbidden(source.content))continue;
      candidates.push({episodeId:episode.episodeId,versionId:episode.versionId,label:episode.label,topic:episode.topic,statement:episode.statement,reason:episode.reason,appraisal:episode.appraisal,degree:episode.intensityLevel,sourceId:source.id,sourceHash:sourceHash(source),originalQuote:episode.causeQuote.slice(0,1000)});
    }
    return {expectedRevision:emotion.revision,candidates,boundary:'只是重读既有原件。允许保持不变、降低感受或纠正误读；不能新建情绪、提高程度/把握、刷新时间或新增支持事件。'};
  }
  captureReflection(row,frame,value,note){
    if(value==null)return {status:'no_change'};
    const old=this.read('reappraisal',row.id);if(old)return {status:old.status};
    const record={version:1,kind:'reappraisal',intentId:row.id,seenAt:this.store.time(),status:'pending',expectedRevision:frame.expectedRevision,error:null};
    try{
      noSecret(note);record.note=note;
      record.proposal=proposal(value);
      const candidate=frame.candidates.find(c=>c.episodeId===value.episodeId);
      if(!candidate||!candidate.originalQuote.includes(value.evidenceQuote)||!value.evidenceQuote?.trim())throw new Error('反思只能引用本次呈现的已有情绪及原话');
      Object.assign(record,{episodeVersionId:candidate.versionId,sourceId:candidate.sourceId,sourceHash:candidate.sourceHash});
    }catch(error){record.status='invalid';record.error=this.safe(error);}
    this.save(record);return {status:record.status};
  }
  async resolve(record){
    if(record.kind==='perception'){
      const row=this.store.get(record.intentId);if(!row||!this.host?.source)return null;
      const source=await this.host.source(row,record);
      if(!source||source.content!==record.text||hash(source.content)!==record.previewHash||learningForbidden(source.content))return null;
      return source;
    }
    const episode=this.growth.emotions.store.head(record.proposal.episodeId),source=this.growth.store.event(record.sourceId);
    if(!episode||episode.versionId!==record.episodeVersionId||episode.sourceId!==record.sourceId||!source||sourceHash(source)!==record.sourceHash||learningForbidden(source.content))return null;
    return sealObservationSource({...source,owner:false,context:[...(source.context??[])],origin:{...(source.origin??{}),archivedOriginal:true}});
  }
  drain(signal){
    if(this.active||!this.host||this.growth.emotions.inflight)return this.active??Promise.resolve();
    const operation=this.run(signal).finally(()=>{this.active=null;});this.active=operation;return operation;
  }
  async run(signal){
    const record=this.rows('pending',1)[0];if(!record)return;
    try{
      signal?.throwIfAborted();
      const source=await this.resolve(record);
      if(!source){this.save({...record,status:'skipped',error:'原件范围、身份、学习设置或版本已变化，未提交情绪'});return;}
      const args={expectedRevision:record.expectedRevision,proposals:record.proposals??[record.proposal]};
      const batchId=emotionBatchId(args,source);this.save({...record,status:'processing',batchId});
      const receipt=await this.growth.emotions.propose(args,source,(snapshot,s)=>this.host.review(snapshot,s),signal,{
        assessment:record.kind==='reappraisal'?{kind:'reappraisal',intentId:record.intentId,note:record.note}:null,
        guard:async()=>Boolean(await this.resolve(record)),
      });
      this.save({...record,status:'completed',batchId,receipt});
      // Proposals from one frozen decision may follow our own preceding commit;
      // an unrelated later decision still keeps its old expected revision and fails safely.
      if(receipt.status==='applied'&&record.kind==='perception')for(const pending of this.rows('pending')){
        if(pending.kind==='perception'&&pending.decisionId===record.decisionId&&pending.expectedRevision===record.expectedRevision)this.save({...pending,expectedRevision:receipt.revision});
      }
      this.lastError=null;
    }catch(error){this.lastError=this.safe(error);const current=this.read(record.kind,record.intentId);this.save({...current,...record,batchId:current?.batchId??null,status:signal?.aborted?'interrupted':'failed',error:this.lastError});}
  }
  safe(error){try{const message=String(error?.message??error).slice(0,500);noSecret(message);return message;}catch{return '情绪接续异常含敏感信息，未展示正文';}}
}
