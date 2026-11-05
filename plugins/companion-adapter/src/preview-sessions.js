import path from 'node:path';
import { hash, noSecret, aborted } from './validation.js';
import {ownerIdentity,originalOwnerEvent,QQ_SOURCE,assistantResponseDelivered,assistantPublicationPending} from './source-identity.js';

const samePath=(a,b)=>typeof a==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const content=blocks=>(blocks??[]).filter(row=>row.type==='text'&&typeof row.text==='string').map(row=>row.text).join('\n');
const maintenance=new Set(['friend_memory_preview','friend_memory_preview_read','friend_memory_apply','friend_memory_apply_read','friend_nightly_read','friend_nightly_control','friend_memory_changes']);
const observation=/^(?:bili|douyin|web_|browser_|mcp__.*(?:browser|bili|douyin))/;
export function eligibleHeader(header,workspace){
  return Boolean(header?.id&&header.agentPreset==='companion'&&samePath(header.cwd,workspace)&&!header.origin&&!header.delegationDepth&&!header.isSeeded&&!header.parentSession);
}
function source(sessionId,event,kind,text,header){
  return {id:`event:${hash(`${sessionId}:${event.seq}:${kind}`)}`,sessionId,seq:event.seq,messageId:event.data.id??null,kind,occurredAt:new Date(event.time).toISOString(),text,contentHash:hash(text),...kind==='user_message'?ownerIdentity(event,header):{}};
}

/** Reads completed, original companion turns through DSH's public persistence seam. */
export async function collectPreviewSources({persistence,workspace,cursors,currentSessionId,currentTurnStart,scope,limits,signal,background=false,inspection=null}){
  if(!persistence?.list||!persistence?.open||!inspection&&!persistence?.flush)throw new Error('当前 DSH 没有可用的持久会话读取接口');
  aborted(signal);if(!inspection)await persistence.flush();else if(typeof inspection.forbidden!=='function')throw Error('概况读取缺少禁存检查');aborted(signal);
  const catalog=await persistence.list({signal});
  let permitted=catalog.filter(row=>eligibleHeader(row.header,workspace)&&(scope==='companion'||row.header.id===currentSessionId));
  if(!(background&&scope==='companion')&&!permitted.some(row=>row.header.id===currentSessionId))throw new Error('当前会话不属于本实例的直接陪伴会话');
  permitted.sort((a,b)=>String(cursors[a.header.id]?.updatedAt??'').localeCompare(String(cursors[b.header.id]?.updatedAt??''))||a.header.createdAt-b.header.createdAt||a.header.id.localeCompare(b.header.id));
  let consumedSessions=0;
  if(inspection){const prior=permitted.length;permitted=permitted.filter(row=>!Number.isSafeInteger(row.eventCount)||row.eventCount!==(cursors[row.header.id]?.nextSeq??0));consumedSessions=prior-permitted.length;permitted.sort((a,b)=>{const score=r=>Number.isSafeInteger(r.eventCount)?r.eventCount>(cursors[r.header.id]?.nextSeq??0)?0:-1:1;return score(a)-score(b)||String(cursors[a.header.id]?.updatedAt??'').localeCompare(String(cursors[b.header.id]?.updatedAt??''))||a.header.id.localeCompare(b.header.id);});}
  if(inspection&&permitted.length){const offset=(inspection.offset??0)%permitted.length;permitted=[...permitted.slice(offset),...permitted.slice(0,offset)];}
  const selected=permitted.slice(0,limits.maxSessions);
  const result={sources:[],ranges:[],excluded:[],deferredSessions:Math.max(0,permitted.length-selected.length),scannedEvents:0,readEvents:0,completedTurns:0,characters:0,notices:[],...inspection?{inspection:{scannedClosedTurns:0,noSaveTurns:0,maintenanceTurns:0,mixedPrincipalTurns:0,consumedSessions}}:{}};
  function exclude(sessionId,seq,reason){if(result.excluded.length<40)result.excluded.push({sessionId,seq,reason});}
  for(const item of selected){
    aborted(signal);const sessionId=item.header.id,from=cursors[sessionId]?.nextSeq??0;
    const knownCount=Number.isSafeInteger(item.eventCount)&&item.eventCount>=0?item.eventCount:null;
    let upper=sessionId===currentSessionId?Math.min(knownCount??currentTurnStart,currentTurnStart):knownCount;
    if(upper!==null&&from>upper)throw new Error('预演游标超出会话范围，拒绝静默重置');
    const range={sessionId,from,upper,nextSeq:from,waitingForTurn:false,limited:false};result.ranges.push(range);
    if(from===upper)continue;
    const handle=await persistence.open(sessionId,'read',{signal});
    try{
      if(!eligibleHeader(handle.header,workspace)||handle.header.id!==sessionId)throw new Error('读取时会话范围发生变化');
      let offset=from,turn=null,stop=false,captured=null,captureLimited=false;
      if(upper===null){
        const remaining=limits.maxScannedEvents-result.readEvents;
        if(remaining<=0){range.upper=from;range.limited=true;continue;}
        // eventCount is optional in DSH. One bounded public read fixes this batch's prefix.
        const read=await handle.read(from,remaining,{signal});captured=read.events;
        if(captured.length>remaining)throw new Error('会话接口返回超过请求上限的事件');
        result.readEvents+=captured.length;captureLimited=captured.length===remaining;
        upper=captured.length?captured[captured.length-1].seq+1:from;range.upper=upper;
        if(captureLimited)result.notices.push({sessionId,reason:'目录没有事件总数，已固定有界快照，后续事件留给下一批'});
      }
      while(offset<upper&&!stop){
        let batch;
        if(captured){batch={events:captured};captured=null;}
        else{
          const remaining=limits.maxScannedEvents-result.readEvents;
          if(remaining<=0){range.limited=true;break;}
          const length=Math.min(128,upper-offset,remaining);batch=await handle.read(offset,length,{signal});
          if(batch.events.length>length)throw new Error('会话接口返回超过请求上限的事件');
          result.readEvents+=batch.events.length;
        }
        if(!batch.events.length)throw new Error('持久会话在固定读取上界前提前结束');
        for(const event of batch.events){
          aborted(signal);
          if(event.seq!==offset||event.seq>=upper)throw new Error('持久会话事件顺序不连续');
          offset++;result.scannedEvents++;
          if(event.type==='turn/start'){
            if(turn)throw new Error('发现未闭合的会话回合，拒绝跳过依据');
            turn={start:event.seq,number:event.data.turn,events:[],calls:new Map(),maintenance:false};
          }else if(turn){
            if(event.type==='tool/call'){
              turn.calls.set(event.data.callId,event.data.name);
              if(maintenance.has(event.data.name))turn.maintenance=true;
            }
            if(event.type==='user/message'||event.type==='assistant/message'||event.type==='tool/result')turn.events.push(event);
            if(event.type==='turn/end'){
              if(event.data.turn!==turn.number)throw new Error('会话回合结束标识不一致');
              if(turn.events.some(entry=>assistantPublicationPending(entry,handle.header))){range.waitingForTurn=true;result.notices.push({sessionId,reason:'QQ答复尚在待发或发送中，保留游标等待实际结果'});stop=true;break;}
              const gathered=[];let hasOwner=false,mixedPrincipal=false;
              for(const entry of turn.events){
                if(entry.type==='user/message'&&['user',QQ_SOURCE].includes(entry.data.source?.kind)&&!originalOwnerEvent(entry,handle.header))mixedPrincipal=true;
              }
              if(inspection)result.inspection.scannedClosedTurns++;
              if(inspection&&turn.events.some(entry=>originalOwnerEvent(entry,handle.header)&&inspection.forbidden(content(entry.data.content)))){result.inspection.noSaveTurns++;exclude(sessionId,turn.start,'禁存/只读回合，仅计数而不复制预览');}
              else if(turn.maintenance){if(inspection)result.inspection.maintenanceTurns++;exclude(sessionId,turn.start,'预演或报告查询回合，不再作为新经历');}
              else if(mixedPrincipal){if(inspection)result.inspection.mixedPrincipalTurns++;exclude(sessionId,turn.start,'包含尚未绑定的其他身份');}
              else{
                for(const entry of turn.events){
                  let value,kind;
                  if(originalOwnerEvent(entry,handle.header)){
                    value=content(entry.data.content);kind='user_message';
                  }else if(assistantResponseDelivered(entry,handle.header)&&event.data.reason?.kind==='completed'){
                    value=content(entry.data.message.content);kind='assistant_response';
                  }else if(entry.type==='tool/result'){
                    const message=entry.data.message;
                    if(message.toolCallId&&message.callId&&message.toolCallId!==message.callId){exclude(sessionId,entry.seq,'工具结果身份字段冲突，未作为观察');continue;}
                    const name=turn.calls.get(message.toolCallId??message.callId);
                    if(!observation.test(name??'')||entry.data.message.isError)continue;
                    value=content(entry.data.message.content);kind='tool_observation';
                  }else continue;
                  if(!value?.trim())continue;
                  if(value.length>(kind==='user_message'?limits.maxMessageChars:2400)){exclude(sessionId,entry.seq,'消息过长，本次未送入模型');continue;}
                  try{noSecret(value);}catch{exclude(sessionId,entry.seq,'包含疑似凭据，未复制正文');continue;}
                  if(!Number.isFinite(entry.time)){exclude(sessionId,entry.seq,'没有可核对的事件时间');continue;}
                  if(kind==='user_message')hasOwner=true;
                  gathered.push(source(sessionId,entry,kind,value,handle.header));
                }
              }
              const sources=hasOwner?gathered:[],chars=sources.reduce((sum,row)=>sum+row.text.length,0);
              if(chars>limits.maxSourceChars){exclude(sessionId,turn.start,'单个回合超出预演输入预算，需另行处理');}
              else if(sources.length&&(result.completedTurns>=limits.maxTurns||result.characters+chars>limits.maxSourceChars)){
                range.limited=true;stop=true;break;
              }else{
                result.sources.push(...sources.map(row=>({...row,turnStart:turn.start,turnEnd:event.seq})));result.characters+=chars;
                if(sources.length)result.completedTurns++;
              }
              range.nextSeq=event.seq+1;turn=null;
            }
          }else range.nextSeq=event.seq+1;
        }
      }
      if(turn&&!range.limited&&!stop){range.waitingForTurn=offset===upper&&!captureLimited;range.limited=offset<upper||captureLimited;}
      if(range.nextSeq<upper&&!range.waitingForTurn)range.limited=true;
      if(captureLimited)range.limited=true;
    }finally{await handle.close();}
  }
  return result;
}
