import {randomUUID} from 'node:crypto';
import {hash} from './validation.js';
async function bounded(fn,signal){signal?.throwIfAborted();let abort;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{abort=()=>reject(signal.reason??Error('Maintenance cancelled'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();})]);}finally{signal?.removeEventListener('abort',abort);}}
// Aging affects recall, never truth, provenance, or physical retention.
export function socialPriority(note,now=Date.now(),relevant=false){
 const days=Math.max(0,(now-Date.parse(note.created_at))/86400000),half={impression:30,interest:120,pending_topic:14,experience:730}[note.kind]??120;
 const freshness=Math.pow(.5,days/half);
 return {score:(relevant?3:0)+freshness+(note.kind==='experience'?.3:0),ageDays:Math.floor(days),stale:freshness<.25,tier:days<=7?'hot':freshness>=.25?'warm':'cold'};
}
const shape=n=>n?{id:n.id,status:n.status,content_hash:n.content_hash,previous_id:n.previous_id}:null;
export class QQSocialLifecycle{
 constructor(memory){this.memory=memory;this.store=memory.store;this.db=this.store.db;this.db.exec(`
 CREATE TABLE IF NOT EXISTS qq_social_batches(id TEXT PRIMARY KEY,batch_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,thread_key TEXT NOT NULL,source_event TEXT,status TEXT NOT NULL,snapshot_json TEXT NOT NULL,details_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS qq_social_changes(batch_id TEXT NOT NULL,note_id TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,PRIMARY KEY(batch_id,note_id));
 CREATE INDEX IF NOT EXISTS qq_social_changes_note ON qq_social_changes(note_id);
 CREATE TABLE IF NOT EXISTS qq_social_maintenance_cursor(account TEXT PRIMARY KEY,event_row INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS qq_social_maintenance_calls(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,event_id TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
 `);this.db.prepare("UPDATE qq_social_maintenance_calls SET status='interrupted' WHERE status='running'").run();this.active=false;
 }
 used(){const day=new Date(this.memory.now().valueOf()+8*3600000).toISOString().slice(0,10);return this.db.prepare("SELECT count(*) n FROM qq_social_memory_jobs WHERE status!='pending' AND date(updated_at,'+8 hours')=?").get(day).n+this.db.prepare("SELECT count(*) n FROM qq_social_maintenance_calls WHERE date(created_at,'+8 hours')=?").get(day).n;}
 eligible(job,approved){return approved.filter(i=>{const p=job.proposals[i],old=p.targetId?this.store.note(p.targetId):null;if(p.targetId)return old?.status==='active'&&old.account===job.account&&old.thread_key===job.thread_key&&old.subject===job.sender&&old.kind===p.kind&&old.content_hash===p.expectedHash;return !this.db.prepare("SELECT 1 FROM qq_social_notes WHERE account=? AND thread_key=? AND subject=? AND kind=? AND content_hash=? AND status='active'").get(job.account,job.thread_key,job.sender,p.kind,hash(p.content));});}
 async capture(id,signal){try{if(typeof this.memory.host?.capture!=='function')throw Error('QQ social snapshot service unavailable');const result=await this.memory.host.capture(id,signal);if(!result?.sha256||!result?.file)throw Error('QQ social snapshot not verified');signal?.throwIfAborted();return result;}catch(e){e.code='SOCIAL_BACKUP_BLOCKED';throw e;}}
 async commit(job,event,approved,signal,{key='chat:'+event.id,kind='chat',finish=true,review=null}={}){
  const existing=this.db.prepare('SELECT * FROM qq_social_batches WHERE batch_key=?').get(key);if(existing)return {status:existing.status,batchId:existing.id};
  if(!this.eligible(job,approved).length){if(finish)this.store.finish(job.event_id,'completed','No effective changes',{approved,written:[]});return {status:'no_changes'};}
  if(!await this.memory.validateSource(event,signal))throw Error('Source is not currently visible in this memory scope');const id=randomUUID(),snapshot=await this.capture(id,signal);if(!await this.memory.validateSource(event,signal))throw Error('Source changed during memory snapshot');if(!this.memory.live(event,{processed:true}))throw Error('Social source changed before commit');
  const chosen=this.eligible(job,approved),before=new Map(chosen.map(i=>job.proposals[i].targetId).filter(Boolean).map(id=>[id,this.store.note(id)]));
  if(!chosen.length)return {status:'no_changes'};
  const written=this.store.commit(job,event,chosen,{finish,offset:finish?0:this.db.prepare('SELECT coalesce(max(proposal_index),-1)+1 n FROM qq_social_notes WHERE event_id=?').get(event.id).n,onWritten:ids=>{
   if(!ids.length)return;const changes=[...before].map(([id,n])=>({id,before:n,after:this.store.note(id)}));for(const id of ids)changes.push({id,before:null,after:this.store.note(id)});
   this.record({id,key,kind,thread:job.thread_key,event:event.id,snapshot,details:{approved:chosen,proposals:job.proposals,review},changes});
  }});return {status:written.length?'completed':'no_changes',batchId:written.length?id:null,written};
 }
 record({id,key,kind,thread,event,snapshot,details,changes}){this.db.prepare('INSERT INTO qq_social_batches VALUES(?,?,?,?,?,?,?, ?,?)').run(id,key,kind,thread,event,'completed',JSON.stringify(snapshot),JSON.stringify(details),this.store.time());for(const c of changes)this.db.prepare('INSERT INTO qq_social_changes VALUES(?,?,?,?)').run(id,c.id,c.before?JSON.stringify(c.before):null,JSON.stringify(c.after));}
 inspect(id){const batch=this.db.prepare('SELECT * FROM qq_social_batches WHERE id=?').get(id);if(!batch)return null;return {...batch,snapshot:JSON.parse(batch.snapshot_json),details:JSON.parse(batch.details_json),changes:this.db.prepare('SELECT * FROM qq_social_changes WHERE batch_id=?').all(id).map(c=>({id:c.note_id,before:c.before_json?JSON.parse(c.before_json):null,after:JSON.parse(c.after_json),current:this.store.note(c.note_id)}))};}
 undoCheck(id){const batch=this.inspect(id);if(!batch)return {status:'missing'};if(batch.status==='undone')return {status:'undone'};if(batch.kind==='undo')return {status:'blocked',reason:'Undo batches cannot be undone'};for(const c of batch.changes){if(JSON.stringify(shape(c.current))!==JSON.stringify(shape(c.after)))return {status:'blocked',reason:'Target was modified after this batch'};const later=this.db.prepare('SELECT 1 FROM qq_social_changes c JOIN qq_social_batches b ON c.batch_id=b.id WHERE c.note_id=? AND b.rowid>(SELECT rowid FROM qq_social_batches WHERE id=?) LIMIT 1').get(c.id,id);if(later)return {status:'blocked',reason:'A later batch touched this target'};}return {status:'ready',batch};}
 async undo(id,signal){const check=this.undoCheck(id);if(check.status!=='ready')return check;const undoId=randomUUID(),snapshot=await this.capture(undoId,signal);signal?.throwIfAborted();return this.store.journal.transaction(()=>{const fresh=this.undoCheck(id);if(fresh.status!=='ready')return fresh;const changes=[];for(const c of fresh.batch.changes){this.db.prepare('UPDATE qq_social_notes SET status=? WHERE id=?').run(c.before?.status??'retracted',c.id);if(c.before?.status==='active'&&!c.current.native_id)this.db.prepare("UPDATE qq_social_notes SET index_status='pending',index_attempts=0,next_index_at=0 WHERE id=?").run(c.id);changes.push({id:c.id,before:c.current,after:this.store.note(c.id)});}this.record({id:undoId,key:'undo:'+id,kind:'undo',thread:fresh.batch.thread_key,event:fresh.batch.source_event,snapshot,details:{undoes:id},changes});this.db.prepare("UPDATE qq_social_batches SET status='undone' WHERE id=?").run(id);return {status:'undone',batchId:id,undoId};});}
 async call(role,run,event,frame,signal){if(this.used()>=this.memory.config.dailyReviews)throw Error('Social maintenance daily review budget exhausted');const id=randomUUID();this.db.prepare("INSERT INTO qq_social_maintenance_calls VALUES(?,?,?,?,'running',?)").run(id,run,event.id,role,this.store.time());try{const result=await bounded(()=>this.memory.host[role](frame,signal),signal);signal?.throwIfAborted();this.db.prepare("UPDATE qq_social_maintenance_calls SET status='completed' WHERE id=?").run(id);return result;}catch(e){this.db.prepare("UPDATE qq_social_maintenance_calls SET status='failed' WHERE id=?").run(id);throw e;}}
 async maintain(runId,signal,normalize){
  if(this.active||this.memory.running)return {status:'busy'};if(!this.memory.enabled()||!this.memory.host?.maintenance)return {status:'disabled'};this.active=true;let scanned=0,changed=0;
  try{const account=this.memory.currentAccount(),cursor=this.db.prepare('SELECT event_row FROM qq_social_maintenance_cursor WHERE account=?').get(account)?.event_row??0;
   const rows=this.db.prepare("SELECT rowid event_row,id FROM platform_events WHERE account=? AND rowid>? AND kind IN ('group','friend','qzone_comment') AND status IN ('sent','ignored','withdrawn','cancelled','expired','failed','unknown','proposed') ORDER BY rowid LIMIT 20").all(account,cursor);
   for(const r of rows){signal?.throwIfAborted();if(!this.memory.enabled())return {status:'disabled',scanned,changed};const e=this.memory.readEvent(r.id);
    if(this.memory.live(e,{processed:true})&&await this.memory.validateSource(e,signal)){const candidates=this.store.notes(e,40).filter(n=>n.subject===e.sender&&this.memory.live(this.memory.readEvent(n.event_id),{processed:true})&&this.db.prepare('SELECT rowid n FROM platform_events WHERE id=?').get(n.event_id)?.n<r.event_row);
     const targets=[],sourceCache=new Map();for(const n of candidates)if(await this.memory.validateSource(this.memory.readEvent(n.event_id),signal,sourceCache))targets.push(n);if(targets.length&&this.used()+2<=this.memory.config.dailyReviews){const frame={source:{id:e.id,senderQQ:e.sender,text:e.body,scope:this.store.notes(e,1)[0]?.thread_key??e.thread_key,occurredAt:e.created_at,...e.kind==='qzone_comment'?{originThread:e.thread_key,postVisibility:e.raw.postVisibility,observedAssistantReply:this.memory.sourceEvidence(e)}:{}},targets:targets.map(n=>({id:n.id,kind:n.kind,content:n.content,expectedHash:n.content_hash}))};
      const proposed=await this.call('maintenance',runId,e,frame,signal),proposals=normalize(proposed?.proposals,e,this.store);if(proposals.some(p=>p.action==='add'))throw Error('Nightly maintenance cannot create new facts');
      if(proposals.length){const decision=await this.call('audit',runId,e,{...frame,proposals},signal);if(!Array.isArray(decision?.approved)||new Set(decision.approved).size!==decision.approved.length||decision.approved.some(i=>!Number.isInteger(i)||i<0||i>=proposals.length)||typeof decision.reason!=='string')throw Error('Invalid social maintenance audit');
       const job={event_id:e.id,account:e.account,thread_key:targets[0].thread_key,sender:e.sender,proposals};const result=await this.commit(job,e,decision.approved,signal,{key:'nightly:'+runId+':'+e.id,kind:'nightly',finish:false,review:decision});if(result.status==='completed')changed++;
      }
     }else if(targets.length)return {status:'budget_exhausted',scanned,changed};
    }
    this.db.prepare('INSERT INTO qq_social_maintenance_cursor VALUES(?,?) ON CONFLICT(account) DO UPDATE SET event_row=excluded.event_row').run(account,r.event_row);scanned++;
   }
   return {status:rows.length===20?'partial':'completed',scanned,changed};
  }finally{this.active=false;}
 }
}
