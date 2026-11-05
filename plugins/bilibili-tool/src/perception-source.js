// 从宿主 attention-affect 迁出的B站感知分支；公共逐字校验与密封仍由宿主完成。
export function bilibiliPerceptionSource(c,row,record){
 if(!c.bilibiliSocial?.config.learning)return null;
 const event=c.bilibiliInbox.store.event(row.payload.eventId),account=c.bilibiliInbox.store.control().account_id;
 if(!event||['withdrawn','cancelled','quarantined'].includes(event.status)||!account||event.payload.account!==account)return null;
 return {original:event.payload.text,occurredAt:event.created_at,origin:{platform:'bilibili',eventId:event.id,sender:event.sender,account,privacy:event.kind==='private'?'private':'public',scope:event.payload.scope,causeKeys:['bilibili:'+event.id]}};
}
