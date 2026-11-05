import {hash,noSecret,aborted} from './validation.js';
import {eligibleHeader} from './preview-sessions.js';
import {originalOwnerEvent} from './source-identity.js';
import {goalNoSave} from './goals.js';

const protocol='ai-friend/video-memory-grounding/1';
const body=blocks=>(blocks??[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n');
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const id=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);
const videoText=value=>/(?:视频|字幕|画面|观后|观看|B站|bilibili|BV[\dA-Za-z]{10})/i.test(value??'');
function claimProblem(content,items){
  const positive=pattern=>[...content.matchAll(pattern)].some(m=>!/(?:未|没|不|不能|没有|并非|不代表|而非).{0,6}$/.test(content.slice(Math.max(0,m.index-12),m.index)));
  if(positive(/(?:完整|全部|从头到尾|逐帧)(?:地)?(?:看|观看|读)|看完(?:了)?(?:整[个部条段]|全[部片])/g))return '抽样或文本原件不支持完整观看断言';
  if(!items.some(v=>v.segments.some(s=>s.frames.length))&&positive(/画面(?:中|里)|镜头(?:中|里)|看见/g))return '只有语言来源的原件不支持画面经历';
  if([...content.matchAll(/BV[\dA-Za-z]{10}/g)].some(m=>!items.some(v=>v.bvid===m[0])))return '内容的视频编号与原件不一致';
  if([...content.matchAll(/第\s*(\d+)\s*[Pp]/g)].some(m=>!items.some(v=>v.page===Number(m[1]))))return '内容分P与原件不一致';
  const ranges=[...content.matchAll(/(\d+(?:\.\d+)?)\s*[–—~至到-]\s*(\d+(?:\.\d+)?)\s*秒/g)];
  for(const m of ranges){
    let cursor=Number(m[1]),end=Number(m[2]);if(end<=cursor)return '内容的时间区间无效';
    // Only merge coverage of one video/page, never join unrelated observations across videos.
    const covered=items.some(v=>{let start=cursor;for(const s of [...v.segments].sort((a,b)=>a.startSeconds-b.startSeconds)){if(s.startSeconds>start+0.01)break;if(s.endSeconds>start)start=s.endSeconds;if(start>=end)return true;}return false;});
    if(!covered)return '内容的时间区间超出实际原件覆盖';
  }
  return null;
}

/** Read-only association. No new memory store, model, download or learning call. */
export class VideoGrounding {
  constructor({journal,workspace,activities}){Object.assign(this,{db:journal.db,workspace,activities});}
  table(name){return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));}
  async turn(source,persistence,signal){
    aborted(signal);
    if(!Number.isSafeInteger(source.turnStart)||!Number.isSafeInteger(source.turnEnd)||source.turnEnd<=source.turnStart||source.turnEnd-source.turnStart>512)return null;
    const handle=await persistence.open(source.sessionId,'read',{signal});
    try{
      if(!eligibleHeader(handle.header,this.workspace)||handle.header.id!==source.sessionId)throw Error('视频关联的会话范围不正确');
      const size=source.turnEnd-source.turnStart+1,{events}=await handle.read(source.turnStart,size,{signal});
      if(events.length!==size||events.some((e,i)=>e.seq!==source.turnStart+i)||events[0].type!=='turn/start'||events.at(-1).type!=='turn/end'||events.at(-1).data.reason?.kind!=='completed')throw Error('视频关联回合未完整结束');
      const user=events.find(e=>e.seq===source.seq);
      if(!user||!originalOwnerEvent(user,handle.header)||user.data.id!==source.messageId||body(user.data.content)!==source.text||hash(source.text)!==source.contentHash)throw Error('视频关联的主用户原话变化');
      return events;
    }finally{await handle.close();}
  }
  async anchors(source,persistence,signal){
    const events=await this.turn(source,persistence,signal);if(!events)return [];
    const calls=new Map(events.filter(e=>e.type==='tool/call'&&e.data.name==='friend_bilibili_explore').map(e=>[e.data.callId,e]));
    const anchors=[];
    for(const event of events){
      if(event.type!=='tool/result'||event.data.message?.isError)continue;
      const m=event.data.message;if(m.callId&&m.toolCallId&&m.callId!==m.toolCallId)continue;
      const call=calls.get(m.toolCallId??m.callId);if(!call||call.seq>=event.seq||call.seq<=source.seq)continue;
      const result=parse(body(m.content));if(!result||Array.isArray(result))continue;
      // A real tool result supplies IDs. Assistant text, metadata searches and recalls do not.
      const a={sessionId:source.sessionId,userSourceId:source.id,messageId:source.messageId,seq:source.seq,turnStart:source.turnStart,turnEnd:source.turnEnd,callSeq:call.seq,resultSeq:event.seq,callId:call.data.callId,resultHash:hash(body(m.content))};
      if(id(result.requestId))anchors.push({...a,kind:'background',requestId:result.requestId});
      else if(id(result.activityId))anchors.push({...a,kind:'direct',runId:result.activityId,observationId:result.observationId??null});
      else anchors.push({...a,kind:'unresolved'});
    }
    return anchors;
  }
  resolve(anchor,source){
    if(goalNoSave(source.text))throw Error('原回合要求不保存，观察不能用于新增学习');
    let runId=anchor.runId;
    if(anchor.kind==='background'){
      if(!this.table('activity_requests'))throw Error('后台观看请求原件不可用');
      const row=this.db.prepare('SELECT * FROM activity_requests WHERE id=?').get(anchor.requestId),s=parse(row?.source_json),request=parse(row?.request_json);
      if(!row||!s||hash(row.source_json)!==row.source_hash||s.sessionId!==source.sessionId||s.messageId!==source.messageId||s.seq!==source.seq||s.body!==source.text||request?.learn===false||row.status==='cancelled')throw Error('后台观看请求与原话不一致或禁止学习');
      runId=row.run_id;
    }
    if(!id(runId))throw Object.assign(Error('观看任务尚未产生可核对原件'),{code:'VIDEO_ORIGINAL_PENDING'});
    const run=this.activities.store.get(runId);
    if(!run||run.request?.learn===false||anchor.kind==='background'&&run.request.backgroundRequestId!==anchor.requestId)throw Error('观看任务不可核对或禁止学习');
    if(!id(run.observation_id))throw Object.assign(Error('观看任务尚未产生观察原件'),{code:'VIDEO_ORIGINAL_PENDING'});
    if(anchor.observationId&&anchor.observationId!==run.observation_id)throw Error('观看任务与观察编号不一致');
    if(Date.parse(run.created_at)<Date.parse(source.occurredAt)||!Number.isFinite(Date.parse(run.created_at)))throw Error('旧观看的再次读取不算新观看');
    const observation=this.activities.store.observation(run.observation_id);
    if(!observation||Date.parse(observation.created_at)<Date.parse(source.occurredAt))throw Error('观看原件缺失或时间早于本次请求');
    const p=observation.payload;
    if(p.protocol!==undefined&&p.protocol!=='ai-friend/video-observation/1'||!p.protocol&&!['subtitle','ai_subtitle'].includes(p.dataSource))throw Error('观察来源协议不支持');
    if(!/^BV[\dA-Za-z]{10}$/.test(p.bvid)||!Number.isSafeInteger(p.page)||p.page<1||typeof p.text!=='string'||!p.text.trim()||typeof p.scope!=='string')throw Error('观察原件缺少视频身份和范围');
    const sourceRow=this.activities.store.reportSource(observation.id);
    if(!this.activities.store.verify(sourceRow))throw Error('观察原件完整性核验失败');
    const segments=(p.video?.segments??[]).map(s=>{
      if(s.bvid!==p.bvid||s.page!==p.page||s.cid!=null&&String(s.cid)!==String(p.video.cid)||!Number.isFinite(s.startSeconds)||!Number.isFinite(s.endSeconds)||!Number.isFinite(p.video.durationSeconds)||s.startSeconds<0||s.endSeconds<=s.startSeconds||s.endSeconds>p.video.durationSeconds)throw Error('视频、分P或观察区间不一致');
      return {startSeconds:s.startSeconds,endSeconds:s.endSeconds,language:s.language?.source??'none',frames:(s.frames??[]).filter(f=>f.description).map(f=>{
        if(!Number.isFinite(f.seconds)||f.seconds<s.startSeconds||f.seconds>s.endSeconds||!(/^[\da-f]{64}$/i.test(f.sha256??'')))throw Error('抽样画面范围或校验值无效');
        return {seconds:f.seconds,sha256:f.sha256,evidenceType:f.evidenceType};
      })};
    });
    if(p.protocol==='ai-friend/video-observation/1'&&(!segments.length||!p.video?.cid))throw Error('视频原件缺少媒体身份或片段');
    const evidence={sourceId:sourceRow.id,observationId:observation.id,payloadHash:observation.content_hash,bvid:p.bvid,page:p.page,cid:p.video?.cid??null,title:p.title??null,dataSource:p.dataSource??'transcript',scope:p.scope,textTruncated:p.truncated===true,segments};
    return {source:sourceRow,evidence,anchor:{...anchor,runId,observationId:observation.id}};
  }
  waiting(anchor){
    if(anchor.kind==='background'&&this.table('activity_requests')){
      const row=this.db.prepare('SELECT status,request_json,run_id FROM activity_requests WHERE id=?').get(anchor.requestId);
      return Boolean(row&&parse(row.request_json)?.learn!==false&&['queued','running'].includes(row.status));
    }
    const run=anchor.runId?this.activities.store.get(anchor.runId):null;
    return Boolean(run&&run.request?.learn!==false&&['running','paused','interrupted'].includes(run.status));
  }
  history(item,userSourceIds=[]){
    if(!this.table('apply_steps'))return [];
    const rows=this.db.prepare(`SELECT s.id,s.run_id,s.status,s.operation_json,s.receipt_json,r.frame_json FROM apply_steps s JOIN apply_runs r ON r.id=s.run_id
      WHERE s.status IN ('applied','writing','written') AND json_extract(s.operation_json,'$.kind')='native_add'
        AND (instr(s.operation_json,?)>0 OR instr(r.frame_json,?)>0 ${userSourceIds.length?'OR '+userSourceIds.map(()=> 'instr(s.operation_json,?)>0').join(' OR '):''}) ORDER BY s.rowid DESC LIMIT 64`).all(item.observationId,item.observationId,...userSourceIds);
    return rows.flatMap(row=>{
      const op=parse(row.operation_json),frame=parse(row.frame_json),receipt=parse(row.receipt_json);
      const explicit=op?.videoEvidence?.some(v=>v.observationId===item.observationId)||op?.evidence?.some(e=>frame?.sources?.some(s=>s.id===e.sourceId&&s.observationId===item.observationId));
      // Legacy chat-only applications are possible duplicates, never retroactively certified proof.
      const knownOriginal=op?.videoEvidence?.length||op?.evidence?.some(e=>frame?.sources?.some(s=>s.id===e.sourceId&&s.observationId));
      const legacy=!explicit&&!knownOriginal&&videoText(op?.content)&&op?.evidence?.some(e=>userSourceIds.includes(e.sourceId));
      return explicit||legacy?[{applicationId:row.run_id,stepId:row.id,status:row.status,verified:receipt?.verified===true,match:explicit?'same_observation':'same_request_possible_duplicate',nativeId:receipt?.nativeId??null}]:[];
    });
  }
  async enrich(sources,persistence,limits,signal){
    const grounding={protocol,items:[],attempts:[],notices:[],scope:'只关联本批已核对主用户回合的真实观看工具；回忆、标题相似与助手自述不证明新观看'};
    const grouped=new Map();let extra=0;
    for(const user of sources.sources.filter(s=>s.kind==='user_message')){
      aborted(signal);const anchors=await this.anchors(user,persistence,signal);
      for(const a of anchors){
        const attempt={userSourceId:user.id,callSeq:a.callSeq,resultSeq:a.resultSeq,status:'unresolved'};
        try{
          const resolved=this.resolve(a,user),item=resolved.evidence;
          if(grouped.has(item.observationId)){grouped.get(item.observationId).anchors.push(resolved.anchor);attempt.status='linked';attempt.observationId=item.observationId;}
          else if(groupingFull())attempt.reason='本批视频原件数量或字符预算不足，未截断或替换原件';
          else{
            noSecret(JSON.stringify(resolved));const row={...item,anchors:[resolved.anchor],previousApplications:[]};row.previousApplications=this.history(row,[user.id]);
            grouped.set(item.observationId,row);sources.sources.push(resolved.source);extra+=resolved.source.text.length;attempt.status='linked';attempt.observationId=item.observationId;
          }
          function groupingFull(){return grouped.size>=4||sources.characters+extra+resolved.source.text.length>limits.maxSourceChars;}
        }catch(error){aborted(signal);const reason=String(error.message??error).slice(0,240);try{noSecret(reason);attempt.reason=reason;}catch{attempt.reason='观察核对失败，敏感诊断已省略';}
          if(error.code==='VIDEO_ORIGINAL_PENDING'&&!goalNoSave(user.text)&&this.waiting(a)){attempt.retryable=true;const range=sources.ranges.find(r=>r.sessionId===user.sessionId);if(range)range.nextSeq=Math.min(range.nextSeq,user.turnStart);}
        }
        grounding.attempts.push(attempt);
      }
    }
    grounding.items=[...grouped.values()];sources.characters+=extra;
    if(grounding.attempts.some(a=>a.status!=='linked'))grounding.notices.push('有观看未能关联完整原件；不能据助手自述确认已观看，也不新增独立观看支持');
    return {...sources,videoGrounding:grounding};
  }
  async verify(grounding,sources,persistence,signal){
    if(!grounding)return;
    if(grounding.protocol!==protocol)throw Error('视频记忆核验协议不支持');
    for(const item of grounding.items){
      for(const anchor of item.anchors){
        const user=sources.find(s=>s.kind==='user_message'&&s.id===anchor.userSourceId);if(!user)throw Error('视频观察没有原始主用户依据');
        const actual=(await this.anchors(user,persistence,signal)).find(a=>a.callSeq===anchor.callSeq&&a.resultSeq===anchor.resultSeq);
        if(!actual||actual.resultHash!==anchor.resultHash)throw Error('视频观察的原始工具回执变化');
        const resolved=this.resolve(actual,user);
        if(JSON.stringify(resolved.evidence)!==JSON.stringify(Object.fromEntries(Object.entries(item).filter(([k])=>!['anchors','previousApplications'].includes(k)))))throw Error('视频原件身份、内容或范围变化');
      }
      if(!item.anchors.length)throw Error('视频观察缺少可核对工具回执');
    }
  }
  refresh(grounding){
    return grounding?{...grounding,items:grounding.items.map(item=>({...item,previousApplications:this.history(item,item.anchors.map(a=>a.userSourceId))}))}:{protocol,items:[],attempts:[],notices:['旧报告没有视频原件关联；视频经历需重新核对后再应用']};
  }
  current(frame,operation,applicationId){
    // The ordinary activity writer and nightly writer share this final boundary.
    // A retry from either direction cannot duplicate the other writer's receipt.
    if(frame.protocol==='ai-friend/activity-memory/1'&&operation.kind==='native_add'&&frame.authorization?.observationId){
      const observationId=frame.authorization.observationId,source=frame.sources.find(s=>s.kind==='external_observation'&&s.channel==='bilibili'&&s.observationId===observationId);
      if(!source||!this.activities.store.verify(source))throw Error('活动提交前观察原件已变化');
      if(this.history({observationId}).some(h=>h.applicationId!==applicationId))throw Error('同一次观看已有其他入口的保存或不确定提交，未重复新增');
    }
    if(frame.protocol==='ai-friend/memory-application/1'&&operation.kind==='native_add'&&videoText(operation.content)&&!operation.videoEvidence?.length)throw Error('旧视频写入计划缺少观察原件关联，未执行；请重新核对');
    for(const item of operation.videoEvidence??[]){
      const expected=frame.videoGrounding?.items.find(v=>v.observationId===item.observationId);
      if(!expected)throw Error('应用缺少视频原件检查点');
      for(const anchor of expected.anchors){
        const user=frame.sources.find(s=>s.id===anchor.userSourceId),resolved=this.resolve(anchor,user);
        if(resolved.evidence.payloadHash!==item.payloadHash||resolved.evidence.bvid!==item.bvid||resolved.evidence.page!==item.page||resolved.evidence.cid!==item.cid)throw Error('提交前视频原件已变化');
      }
      if(this.history(expected,expected.anchors.map(a=>a.userSourceId)).some(h=>h.applicationId!==applicationId))throw Error('同一次观看已有保存或不确定提交，未重复计为新经历');
    }
  }
}

/** A model may interpret an observation; it cannot invent its identity, coverage or independence. */
export function groundVideoPlan(plan,frame){
  if(!frame.videoGrounding||frame.videoGrounding.protocol!==protocol)return plan;
  const items=frame.videoGrounding.items,seen=new Set();
  return {decisions:plan.decisions.map(decision=>{
    let reason=null,duplicate=false;const localSeen=new Set();
    const operations=decision.operations.map(op=>{
      if(op.kind!=='native_add')return op;
      const userIds=op.evidence.map(e=>e.sourceId),proposal=frame.proposals.find(p=>p.index===decision.proposalIndex);
      const required=videoText(op.content)||videoText(proposal?.summary)||frame.videoGrounding.attempts.some(a=>userIds.includes(a.userSourceId));
      const selected=(op.observationIds??[]).map(value=>items.find(v=>v.observationId===value));
      if(!required&&!selected.length)return op;
      if(!selected.length||selected.some(v=>!v)){reason='视频经历缺少本批已核对原件，暂缓保存，不能仅凭聊天自述确认观看';return op;}
      if(selected.some(v=>!v.anchors.some(a=>userIds.includes(a.userSourceId))||!op.evidence.some(e=>e.sourceId===v.sourceId))){reason='视频原件与本提案原话或逐字观察引文没有同时对应，暂缓保存';return op;}
      const problem=claimProblem(op.content,selected);if(problem){reason=problem+'，暂缓保存';return op;}
      if(selected.some(v=>v.previousApplications.length||seen.has(v.observationId)||localSeen.has(v.observationId))){duplicate=true;return op;}
      for(const item of selected)localSeen.add(item.observationId);
      const videoEvidence=selected.map(({anchors,previousApplications,...v})=>v);
      const coverage=selected.map(v=>`观察编号：${v.observationId}\n视频：${v.bvid} 第${v.page}P${v.cid?' CID '+v.cid:''}\n实际范围：${v.scope}\n来源方式：${v.dataSource}`).join('\n');
      // Preserve the reviewed interpretation, while the runtime supplies authoritative bounds.
      const content=`${op.content}\n\n【程序核对的观察边界；不代表完整观看】\n${coverage}`;
      if(content.length>3000){reason='完整理解与权威观察边界超过单条预算，暂缓保存，不截断原件';return op;}
      return {...op,content,videoEvidence};
    });
    if(reason||duplicate)return {...decision,verdict:reason?'defer':'noop',reason:reason??'同一次观看已有保存或不确定提交记录，未重复增加经历；旧记录保留',operations:[]};
    for(const op of operations)for(const item of op.videoEvidence??[])seen.add(item.observationId);
    return {...decision,operations};
  })};
}
