// Extracted unchanged from dsh-bili-whale 8b0009f8ce2ebdc421afcb2e727b19ac18912ec6 (MIT).
import crypto from 'node:crypto';
export function normalizeMessage(row) {
  const ts=Number(row.timestamp),sender=String(row.sender_uid??'')
  if(!Number.isFinite(ts)||ts<0||!sender)throw Error('私信历史消息缺少有效时间或发送者')
  const type=Number(row.msg_type ?? 1)
  let withdrawn=null
  if(type===5){try{const v=JSON.parse(String(row.content));withdrawn=String(v?.msg_key ?? v?.msg_key_str ?? v)}catch{withdrawn=String(row.content??'')}}
  let text=String(row.content??'')
  try {const j=JSON.parse(text);text=String(j.content??j.text??text)} catch {}
  const seq=String(row.msg_seqno??'')
  const key=String(row.msg_key??(seq||crypto.createHash('sha256').update(JSON.stringify([ts,sender,row.content])).digest('hex')))
  return {ts,sender,text,key,type,withdrawn,seq:/^\d+$/.test(seq)?seq:null}
}

