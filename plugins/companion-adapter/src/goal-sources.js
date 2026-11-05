import {ownerIdentity} from './source-identity.js';
import {eligibleHeader} from './preview-sessions.js';
import {goalNoSave} from './goals.js';

const words=message=>(message?.content??[]).filter(row=>row.type==='text').map(row=>row.text).join('\n');
/** This index is planning provenance, never a new memory/growth source. */
export async function goalSources(adapter,agents,persistence,candidates){
  if(!adapter.goals?.enabled())return [];
  const sources=[];
  for(const row of candidates){
    if(row.kind==='message'){
      const message=row.payload.message,header=agents.get(row.payload.sessionId)?.session.header??(await persistence.stat(row.payload.sessionId))?.header;
      if(!header||!eligibleHeader(header,adapter.workspace)||!ownerIdentity({type:'user/message',data:message},header))continue;
      const raw=words(message);sources.push({id:'intent:'+row.id,kind:'owner_message',owner:true,channel:row.payload.channel??'web',privacy:'owner',text:raw.slice(0,350),eligible:!goalNoSave(raw)});
    }else if(row.kind==='bilibili'){
      const event=adapter.bilibiliInbox.store.event(row.payload.eventId);if(!event||event.status!=='queued')continue;
      const raw=event.payload.text;sources.push({id:'intent:'+row.id,kind:'platform_message',owner:event.sender===adapter.bilibiliSocial?.config.ownerUid,channel:'bilibili',privacy:event.kind==='private'?'private':'public',text:raw.slice(0,350),eligible:!goalNoSave(raw)});
    }
  }
  let state;try{state=JSON.parse(adapter.growth.context());}catch{state=null;}
  for(const row of (state?.states??[]).filter(row=>['interest','self_description','trait'].includes(row.kind)).slice(0,8))sources.push({id:'self:'+row.id,kind:'current_self_state',text:row.statement.slice(0,350),eligible:!goalNoSave(row.statement),privacy:'owner'});
  for(const row of adapter.attention.store.recent(20).filter(row=>row.kind==='reflect'&&row.status==='completed'&&row.result?.status==='reflected').slice(0,2))sources.push({id:'reflection:'+row.id,kind:'internal_reflection',text:row.result.note.slice(0,350),eligible:!goalNoSave(row.result.note),privacy:'owner'});
  return sources;
}
