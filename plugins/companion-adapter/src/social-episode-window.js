import {hash} from './validation.js';
/** Receipt-order window assignment, independent of completion/evaluation order. */
export function experienceWindow(a,event,cutoff){
 const db=a.journal.db,store=a.platforms.store,key=id=>'social-experience-window-v2:'+id,scope=e=>hash(JSON.stringify([e.account,e.sender,e.thread_key,...e.kind==='qzone_comment'?[e.raw.postVisibility]:[]]));
 const cached=e=>{try{const r=db.prepare('SELECT value FROM platform_meta WHERE key=?').get(key(e.id));if(!r)return null;const v=JSON.parse(r.value);return v.rawHash===e.raw_hash&&v.scope===scope(e)&&/^[a-f0-9]{64}$/.test(v.window?.id)&&Number.isFinite(Date.parse(v.window.startedAt))?v.window:null;}catch{return null;}};
 const nodes=[];let cursor=event,base=null,uncertain=false;
 for(let n=0;n<32;n++){
  base=cached(cursor);if(base)break;nodes.push(cursor);
  const previous=db.prepare("SELECT id FROM platform_events WHERE account=? AND thread_key=? AND sender=? AND kind IN ('group','friend','qzone_comment') AND rowid>? AND rowid<(SELECT rowid FROM platform_events WHERE id=?) AND created_at>=? AND json_type(raw_json,'$.historyRecovery') IS NULL AND (? IS NULL OR json_extract(raw_json,'$.postVisibility')=?) ORDER BY rowid DESC LIMIT 1").get(cursor.account,cursor.thread_key,cursor.sender,cutoff,cursor.id,new Date(Date.parse(cursor.created_at)-20*60000).toISOString(),cursor.kind==='qzone_comment'?cursor.raw.postVisibility:null,cursor.kind==='qzone_comment'?cursor.raw.postVisibility:null);
  if(!previous)break;if(n===31){uncertain=true;break;}cursor=store.event(previous.id);
 }
 for(const e of nodes.reverse()){
  if(!base||Date.parse(e.created_at)-Date.parse(base.startedAt)>60*60000)base={id:hash('qq-experience-window-v2:'+e.thread_key+':'+e.sender+':'+e.id),startedAt:e.created_at,...uncertain?{independenceUncertain:true}:{}};
  const value=JSON.stringify({rawHash:e.raw_hash,scope:scope(e),window:base});db.prepare('INSERT INTO platform_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(e.id),value);
 }
 return base;
}
