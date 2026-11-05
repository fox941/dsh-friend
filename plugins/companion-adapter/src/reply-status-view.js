import {viewText as clean} from './view-text.js';
const json=s=>{try{return s?JSON.parse(s):null;}catch{return null;}};
const channels={group:'QQ群聊',friend:'QQ好友',qzone_comment:'QQ空间',owner_voice:'QQ语音'};
const label=status=>status==='sent'||status==='replied'||status==='delivered'?'已发送，有平台回执':status==='unknown'?'发送结果不明，未自动重发':status==='ignored'||status==='silent'?'主动未回复':status==='deferred'||status==='waiting'||status==='defer'?'暂缓，等待重新选择':status==='blocked'?'核实未通过，未发送':status==='failed'||status==='interrupted'?'处理未完成':status==='proposed'?'已形成候选，尚未确认发布':status==='observed'?'原件下读到匹配回复':status==='confirmed'?'平台结果已核验':'正在处理或结果待确认';
export function replyStatusView(adapter){
 const db=adapter.journal.db,has=n=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n)),items=[];
 if(has('qq_inbox')&&has('qq_reply_plans'))for(const r of db.prepare('SELECT i.id,i.status,i.error,i.updated_at,p.status AS reply_status,p.reason FROM qq_inbox i LEFT JOIN qq_reply_plans p ON p.inbox_id=i.id ORDER BY i.rowid DESC LIMIT 12').all()){
  const blocked=has('qq_reply_events')&&db.prepare("SELECT 1 FROM qq_reply_events WHERE inbox_id=? AND status='reply_integrity_blocked' LIMIT 1").get(r.id),status=blocked&&['interrupted','blocked'].includes(r.status)?'blocked':r.reply_status??r.status;
  items.push({id:r.id,channel:'QQ主用户私聊',status,label:label(status),reason:clean(r.error??r.reason,350)||'未记录具体原因',at:r.updated_at});
 }
 if(has('platform_events'))for(const r of db.prepare("SELECT id,kind,status,receipt_json,updated_at FROM platform_events WHERE kind IN ('group','friend','qzone_comment') ORDER BY rowid DESC LIMIT 16").all()){
  const check=has('platform_meta')?json(db.prepare('SELECT value FROM platform_meta WHERE key=?').get('qq-reply-check:'+r.id)?.value):null,receipt=json(r.receipt_json),op=receipt?.operationId&&has('platform_operations')?db.prepare('SELECT status,value_json FROM platform_operations WHERE id=?').get(receipt.operationId):null;
  const detail=json(op?.value_json),status=check?.phase==='blocked'&&['failed','proposed'].includes(r.status)||receipt?.stage==='reply_integrity'?'blocked':op?.status??r.status;
  const reason=status==='blocked'?'回复依据不足或发生变化，草稿保留，未自动重发':detail?.error??receipt?.notice??check?.reason??'未保存具体原因，不推断心情';
  items.push({id:r.id,channel:channels[r.kind]??'QQ',status,label:status==='ignored'&&check?.phase!=='ignored'?'未回复，原因记录不足':label(status),reason:clean(reason,350),at:r.updated_at,correction:check?.attempts>1?'原模型已使用一次修正机会':null});
 }
 if(has('platform_meta'))for(const r of db.prepare("SELECT key,value FROM platform_meta WHERE key LIKE 'qq-reply-check:voice:%' OR key LIKE 'qq-reply-check:voice-send:%' ORDER BY rowid DESC LIMIT 8").all()){
  const c=json(r.value);if(!c)continue;const op=c.operationId&&has('platform_operations')?db.prepare('SELECT status FROM platform_operations WHERE id=?').get(c.operationId):null,status=op?.status??(c.phase==='blocked'?'blocked':'prepared');items.push({id:r.key,channel:'QQ语音',status,label:status==='prepared'?'正文检查完成，尚不代表发送':label(status),reason:clean(c.reason,350),at:c.at});
 }
 return {items:items.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,24),coverage:'最近24条QQ处理记录；主动未回复、核实阻止和发送结果分别展示。未发送不能据此推断情绪；本页不重新发送、取消或唤醒任务。'};
}
