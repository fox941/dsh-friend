import {qqId} from './qq-config.js';
const sources=new WeakMap();
export const historyProvenance=event=>sources.get(event)??null;
export const sourceTime=event=>event.raw?.historyRecovery?.originalAt??event.created_at;
/** Only strict, actual inbound OneBot history envelopes may be recovered. */
export function normalizeHistoryMessage(raw,scope,binding,{now,baselineAt,lookbackMs,respondMs}){
 if(!raw||raw.post_type!=='message'||raw.message_type!==(scope.kind==='group'?'group':'private')||String(raw.self_id)!==binding.bot_qq)return null;
 let sender;try{sender=qqId(raw.user_id);}catch{return null;}
 if(sender===binding.bot_qq||String(raw.sender?.user_id)!==sender||!Array.isArray(raw.message)||raw.message.length>128||JSON.stringify(raw).length>160000)return null;
 if(scope.kind==='group'){if(String(raw.group_id)!==scope.id)return null;}else if(sender!==scope.id||raw.group_id)return null;
 if(!/^-?\d{1,24}$/.test(String(raw.message_id))||!Number.isSafeInteger(raw.time)||raw.time<1577836800||raw.time*1000>now+30000||raw.is_recalled===true||raw.is_withdraw===true)return null;
 const original=raw.time*1000;if(original<Math.max(baselineAt,now-lookbackMs))return null;
 const text=raw.message.filter(s=>s?.type==='text'&&typeof s.data?.text==='string').map(s=>s.data.text).join('');
 const control=/^\s*\//.test(text),historyOnly=now-original>respondMs||control;
 const event=JSON.parse(JSON.stringify(raw)),proof=Object.freeze({schema:'ai-friend/qq-history-source/1',method:scope.kind==='group'?'get_group_msg_history':'get_friend_msg_history',account:binding.bot_qq,scope:scope.key,platformId:String(raw.message_id),originalAt:new Date(original).toISOString(),recoveredAt:new Date(now).toISOString(),historyOnly,reason:control?'historical_control':historyOnly?'outside_reply_window':'recent_missing_event',learningAllowed:false});
 sources.set(event,proof);return event;
}
