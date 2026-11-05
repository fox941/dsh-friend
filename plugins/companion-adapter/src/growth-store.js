import crypto from 'node:crypto';
import { hash } from './validation.js';

const decode=value=>value==null?null:JSON.parse(value);
export class GrowthStore {
  constructor(journal,now=()=>new Date()) {
    this.journal=journal;this.db=journal.db;this.now=now;
    journal.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS growth_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
        INSERT OR IGNORE INTO growth_schema VALUES(1,1);`);
      if(this.db.prepare('SELECT version FROM growth_schema WHERE id=1').get().version!==1)throw new Error('不支持的成长数据版本');
      this.db.exec(`CREATE TABLE IF NOT EXISTS growth_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS growth_events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,message_id TEXT NOT NULL,seq INTEGER NOT NULL,occurred_at TEXT NOT NULL,content TEXT NOT NULL,fingerprint TEXT NOT NULL,context_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS growth_event_origins(event_id TEXT PRIMARY KEY,origin_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS growth_event_fingerprint ON growth_events(fingerprint);
        CREATE TABLE IF NOT EXISTS growth_batches(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,base_revision INTEGER NOT NULL,proposals TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,review TEXT,receipt TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS growth_budget(day TEXT PRIMARY KEY,started_calls INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS growth_review_attempts(batch_id TEXT NOT NULL,attempt INTEGER NOT NULL,request_json TEXT NOT NULL,result_json TEXT,status TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(batch_id,attempt));
        CREATE TABLE IF NOT EXISTS growth_versions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,state_key TEXT NOT NULL,statement TEXT NOT NULL,status TEXT NOT NULL,supports TEXT NOT NULL,dependencies TEXT NOT NULL,reason TEXT NOT NULL,batch_id TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT);
        CREATE INDEX IF NOT EXISTS growth_version_history ON growth_versions(state_key,created_at);
        CREATE TABLE IF NOT EXISTS growth_heads(state_key TEXT PRIMARY KEY,version_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS growth_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,batch_id TEXT NOT NULL,state_key TEXT,action TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL);`);
      this.db.prepare('INSERT OR IGNORE INTO growth_meta VALUES(?,?)').run('identity',crypto.randomUUID());
      this.db.prepare('INSERT OR IGNORE INTO growth_meta VALUES(?,?)').run('revision','0');
      // A request interrupted by host shutdown is inspectable and can be explicitly retried.
      this.db.prepare("UPDATE growth_batches SET status='failed',last_error='上次审核被中断，尚未提交；可明确重试',updated_at=? WHERE status='reviewing'").run(this.time());
    });
  }
  time(){return this.now().toISOString();}
  day(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(this.now());}
  meta(key){return this.db.prepare('SELECT value FROM growth_meta WHERE key=?').get(key)?.value;}
  revision(){return Number(this.meta('revision'));}
  event(id){const row=this.db.prepare('SELECT * FROM growth_events WHERE id=?').get(id),origin=this.db.prepare('SELECT origin_json FROM growth_event_origins WHERE event_id=?').get(id);return row&&{id:row.id,sessionId:row.session_id,messageId:row.message_id,seq:row.seq,occurredAt:row.occurred_at,content:row.content,fingerprint:row.fingerprint,context:decode(row.context_json),...origin?{origin:decode(origin.origin_json)}:{}};}
  saveEvent(event){this.db.prepare('INSERT OR IGNORE INTO growth_events VALUES(?,?,?,?,?,?,?,?)').run(event.id,event.sessionId,event.messageId,event.seq,event.occurredAt,event.content,event.fingerprint,JSON.stringify(event.context??[]));if(event.origin)this.db.prepare('INSERT OR IGNORE INTO growth_event_origins VALUES(?,?)').run(event.id,JSON.stringify(event.origin));}
  version(id){return this.decodeVersion(this.db.prepare('SELECT * FROM growth_versions WHERE id=?').get(id));}
  decodeVersion(row){return row&&{id:row.id,kind:row.kind,key:row.state_key,statement:row.statement,status:row.status,supports:decode(row.supports),dependsOn:decode(row.dependencies),reason:row.reason,batchId:row.batch_id,at:row.created_at,expiresAt:row.expires_at};}
  heads(){return this.db.prepare('SELECT v.* FROM growth_heads h JOIN growth_versions v ON v.id=h.version_id ORDER BY v.created_at DESC,v.rowid DESC').all().map(row=>this.decodeVersion(row));}
  head(key){return this.decodeVersion(this.db.prepare('SELECT v.* FROM growth_heads h JOIN growth_versions v ON v.id=h.version_id WHERE h.state_key=?').get(key));}
  usable(row){return row&&['tentative','established','current'].includes(row.status)&&(!row.expiresAt||row.expiresAt>this.time());}
  read(){const rows=this.heads();return {identityId:this.meta('identity'),revision:this.revision(),states:rows.map(row=>({...row,effectiveStatus:row.expiresAt&&row.expiresAt<=this.time()?'expired':row.status})),blank:!rows.some(row=>this.usable(row))};}
  batch(id){const row=this.db.prepare('SELECT * FROM growth_batches WHERE id=?').get(id);return row&&{...row,proposals:decode(row.proposals),review:decode(row.review),receipt:decode(row.receipt)};}
  budget(){return this.db.prepare('SELECT started_calls FROM growth_budget WHERE day=?').get(this.day())?.started_calls??0;}
  begin(id,source,base,proposals,limit){
    return this.journal.transaction(()=>{
      const existing=this.batch(id);
      if(existing&&['applied','rejected','deferred','stale'].includes(existing.status))return {existing};
      if(existing?.status==='reviewing')throw new Error('同一成长提案正在审核，请稍后核对');
      if(this.revision()!==base)throw new Error('自我状态已变化，请重新读取后再提案');
      if(this.budget()>=limit)throw new Error('今日成长审核额度已用完，普通聊天仍可继续');
      this.saveEvent(source);
      const at=this.time();
      if(existing)this.db.prepare("UPDATE growth_batches SET status='reviewing',attempts=attempts+1,last_error=NULL,updated_at=? WHERE id=?").run(at,id);
      else this.db.prepare("INSERT INTO growth_batches(id,source_id,base_revision,proposals,status,attempts,created_at,updated_at) VALUES(?,?,?,?,'reviewing',1,?,?)").run(id,source.id,base,JSON.stringify(proposals),at,at);
      this.db.prepare('INSERT INTO growth_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET started_calls=started_calls+1').run(this.day());
      return {started:true};
    });
  }
  fail(id,status,message){this.db.prepare('UPDATE growth_batches SET status=?,last_error=?,updated_at=? WHERE id=?').run(status,message,this.time(),id);}
  recordReview(id,request,result,status){
    const attempt=this.batch(id)?.attempts;if(!attempt)return;
    this.db.prepare('INSERT OR IGNORE INTO growth_review_attempts VALUES(?,?,?,?,?,?)').run(id,attempt,JSON.stringify(request??{}),result?JSON.stringify(result):null,status,this.time());
  }
  awaiting(sourceId){return this.db.prepare("SELECT id FROM growth_batches WHERE source_id=? AND status='awaiting_response' AND attempts<2 ORDER BY rowid LIMIT 1").all(sourceId).map(row=>this.batch(row.id));}
  evidence(keys){
    const ids=new Set();
    for(const key of keys){
      for(const row of this.db.prepare('SELECT supports FROM growth_versions WHERE state_key=? ORDER BY rowid DESC LIMIT 12').all(key))for(const id of decode(row.supports))ids.add(id);
    }
    return [...ids].slice(-12).map(id=>this.event(id)).filter(Boolean);
  }
  audit(batch,key,action,reason){this.db.prepare('INSERT INTO growth_audit(batch_id,state_key,action,reason,at) VALUES(?,?,?,?,?)').run(batch,key,action,reason,this.time());}
  put({kind,key,statement,status,supports,dependsOn,reason,batchId,expiresAt=null}){
    const id=crypto.randomUUID(),at=this.time();
    this.db.prepare('INSERT INTO growth_versions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,kind,key,statement,status,JSON.stringify(supports),JSON.stringify(dependsOn),reason,batchId,at,expiresAt);
    this.db.prepare('INSERT INTO growth_heads VALUES(?,?) ON CONFLICT(state_key) DO UPDATE SET version_id=excluded.version_id').run(key,id);
    this.audit(batchId,key,status,reason);return this.version(id);
  }
  invalidate(key,batchId){
    const affected=[],changed=new Set([key]);
    for(let depth=0;depth<24;depth++){
      let grew=false;
      for(const row of this.heads()){
        if(changed.has(row.key)||!this.usable(row))continue;
        if(!row.dependsOn.some(id=>changed.has(this.version(id)?.key)))continue;
        const next=this.put({...row,status:'needs_review',reason:'依赖的自我认识已修正，等待重新核对',batchId});
        changed.add(row.key);affected.push({key:row.key,versionId:next.id});grew=true;
      }
      if(!grew)break;
    }
    return affected;
  }
  finish(id,status,review,receipt){this.db.prepare('UPDATE growth_batches SET status=?,review=?,receipt=?,updated_at=? WHERE id=?').run(status,JSON.stringify(review),JSON.stringify(receipt),this.time(),id);}
  advanceRevision(){const revision=this.revision()+1;this.db.prepare("UPDATE growth_meta SET value=? WHERE key='revision'").run(String(revision));return revision;}
  history(key,limit=10){
    const versions=key?this.db.prepare('SELECT * FROM growth_versions WHERE state_key=? ORDER BY rowid DESC LIMIT ?').all(key,limit):this.db.prepare('SELECT * FROM growth_versions ORDER BY rowid DESC LIMIT ?').all(limit);
    const batches=key?this.db.prepare('SELECT DISTINCT b.* FROM growth_batches b JOIN growth_audit a ON a.batch_id=b.id WHERE a.state_key=? ORDER BY b.rowid DESC LIMIT ?').all(key,limit):this.db.prepare('SELECT * FROM growth_batches ORDER BY rowid DESC LIMIT ?').all(limit);
    return {revision:this.revision(),versions:versions.map(row=>this.decodeVersion(row)),proposals:batches.map(row=>({id:row.id,status:row.status,proposals:decode(row.proposals),review:decode(row.review),reviewSteps:this.db.prepare('SELECT attempt,result_json,status,at FROM growth_review_attempts WHERE batch_id=? ORDER BY attempt').all(row.id).map(step=>({attempt:step.attempt,result:decode(step.result_json),status:step.status,at:step.at})),lastError:row.last_error,source:this.event(row.source_id),at:row.created_at}))};
  }
}

export function evidenceFingerprint(content){return hash(content.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase());}
