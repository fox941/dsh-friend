import {randomUUID} from 'node:crypto';
import {hash} from './validation.js';
const decode=row=>row?{...row,source:JSON.parse(row.source_json)}:null;
export class ProactiveStore{
  constructor(journal,now=()=>new Date(),{namespace=''}={}){
    Object.assign(this,{journal,db:journal.db,now});
    if(namespace){if(!/^[a-z][a-z0-9_]{0,30}_$/.test(namespace))throw Error('Invalid outgoing store namespace');const sql=q=>q.replace(/\bproactive_(control|items|attempts|active|intent)\b/g,m=>namespace+m);this.db={prepare:q=>journal.db.prepare(sql(q)),exec:q=>journal.db.exec(sql(q))};}
    this.db.exec(`CREATE TABLE IF NOT EXISTS proactive_control(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,paused INTEGER NOT NULL,revision INTEGER NOT NULL,cursor_at TEXT NOT NULL,cursor_row INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS proactive_items(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,source_json TEXT NOT NULL,source_hash TEXT NOT NULL,binding_id TEXT NOT NULL,intent_id TEXT,status TEXT NOT NULL,body TEXT,body_hash TEXT,attempt_id TEXT,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS proactive_active ON proactive_items(status);
      CREATE INDEX IF NOT EXISTS proactive_intent ON proactive_items(intent_id);
      CREATE TABLE IF NOT EXISTS proactive_attempts(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT,body_hash TEXT,platform_id TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO proactive_control VALUES(1,1,0,0,?,0)').run(this.time());
    if(this.control().schema_version!==1)throw new Error('不支持的主动联系数据版本');
    this.journal.transaction(()=>{
      this.db.prepare("UPDATE proactive_attempts SET status='unknown',error='发送途中进程退出，未自动重发',updated_at=? WHERE status='sending'").run(this.time());
      this.db.prepare("UPDATE proactive_items SET status='unknown',updated_at=? WHERE status='sending'").run(this.time());
      this.db.prepare("UPDATE proactive_attempts SET status='discarded',error='重启后废弃旧草稿，须重新选择和生成',updated_at=? WHERE status='prepared'").run(this.time());
      this.db.prepare("UPDATE proactive_items SET status='candidate',body=NULL,body_hash=NULL,attempt_id=NULL,updated_at=? WHERE status='prepared'").run(this.time());
    });
  }
  time(){return this.now().toISOString();}
  control(){return this.db.prepare('SELECT * FROM proactive_control WHERE id=1').get();}
  get(id){return decode(this.db.prepare('SELECT * FROM proactive_items WHERE id=?').get(id));}
  bySource(key){return decode(this.db.prepare('SELECT * FROM proactive_items WHERE source_key=?').get(key));}
  offer(source,bindingId,ttl){
    const existing=this.bySource(source.key);if(existing){
      // A fresher receipt may replace a not-yet-sent result, never a sent,
      // unknown or deliberately silent item, and never another request/binding.
      if(existing.status==='candidate'&&!existing.attempt_id&&existing.binding_id===bindingId&&source.kind==='requested_platform_result'&&existing.source.kind===source.kind&&source.requestedReply===true&&existing.source.requestId===source.requestId&&source.key==='requested-qq-operation:'+source.requestId){
        const raw=JSON.stringify(source),digest=hash(raw);if(digest!==existing.source_hash)this.db.prepare("UPDATE proactive_items SET source_json=?,source_hash=?,updated_at=? WHERE id=? AND status='candidate' AND attempt_id IS NULL AND source_hash=?").run(raw,digest,this.time(),existing.id,existing.source_hash);
      }
      return this.get(existing.id);
    }
    const id=randomUUID(),raw=JSON.stringify(source),at=this.time();this.db.prepare("INSERT INTO proactive_items VALUES(?,?,?,?,?,NULL,'candidate',NULL,NULL,NULL,?,?,?)").run(id,source.key,raw,hash(raw),bindingId,this.now().valueOf()+ttl,at,at);return this.get(id);
  }
  link(id,intent){this.db.prepare('UPDATE proactive_items SET intent_id=? WHERE id=?').run(intent,id);}
  state(id,status){this.db.prepare('UPDATE proactive_items SET status=?,updated_at=? WHERE id=?').run(status,this.time(),id);}
  pause(value){this.db.prepare('UPDATE proactive_control SET paused=?,revision=revision+1 WHERE id=1').run(value?1:0);}
  advance(at,row){this.db.prepare('UPDATE proactive_control SET cursor_at=?,cursor_row=? WHERE id=1').run(at,row);}
  live(){return this.db.prepare("SELECT * FROM proactive_items WHERE status IN ('candidate','prepared') ORDER BY rowid").all().map(decode);}
  prepare(id,body){return this.journal.transaction(()=>{
    const row=this.get(id);if(row?.status!=='candidate')throw new Error('主动联系事项已经结束或发送状态不明');
    const bodyHash=hash(body.normalize('NFKC').replace(/\s/g,''));
    if(this.db.prepare("SELECT 1 FROM proactive_attempts WHERE body_hash=? AND status IN ('sent','sending','unknown') AND (?=0 OR item_id=?) LIMIT 1").get(bodyHash,row.source.requestedReply?1:0,id))throw Object.assign(new Error('相同主动正文已发送或结果未确认，未重复发送'),{code:'PROACTIVE_DUPLICATE'});
    const attempt=randomUUID(),at=this.time();this.db.prepare("INSERT INTO proactive_attempts VALUES(?,?,'prepared',?,?,NULL,NULL,?,?)").run(attempt,id,body,bodyHash,at,at);this.db.prepare("UPDATE proactive_items SET status='prepared',body=?,body_hash=?,attempt_id=?,updated_at=? WHERE id=?").run(body,bodyHash,attempt,at,id);return this.get(id);
  });}
  attempt(id,status,{platformId=null,error=null}={}){return this.journal.transaction(()=>{
    const row=this.get(id);if(!row?.attempt_id)throw new Error('主动联系缺少发送尝试');
    this.db.prepare('UPDATE proactive_attempts SET status=?,platform_id=coalesce(?,platform_id),error=?,updated_at=? WHERE id=?').run(status,platformId,error,this.time(),row.attempt_id);
    this.state(id,status);
  });}
  discard(id,reason){return this.journal.transaction(()=>{const row=this.get(id);if(row?.status!=='prepared')return;if(row.attempt_id)this.db.prepare("UPDATE proactive_attempts SET status='discarded',error=?,updated_at=? WHERE id=?").run(reason,this.time(),row.attempt_id);this.db.prepare("UPDATE proactive_items SET status='candidate',body=NULL,body_hash=NULL,attempt_id=NULL,updated_at=? WHERE id=?").run(this.time(),id);});}
  lastSent(){return this.db.prepare("SELECT max(updated_at) at FROM proactive_attempts WHERE status IN ('sent','sending','unknown')").get().at;}
  publications(limit=3,query=''){if(!Number.isSafeInteger(limit)||limit<1||limit>20||typeof query!=='string'||query.length>80)throw new Error('主动发言查询范围无效');const pattern='%'+query.replace(/[\\%_]/g,ch=>'\\'+ch)+'%';return this.db.prepare("SELECT a.id,a.item_id,a.body,a.platform_id,a.updated_at AS at,i.source_json FROM proactive_attempts a JOIN proactive_items i ON i.id=a.item_id WHERE a.status='sent' AND a.body LIKE ? ESCAPE '\\' ORDER BY a.rowid DESC LIMIT ?").all(pattern,limit).map(row=>({...row,source:JSON.parse(row.source_json),source_json:undefined,receipt:'OneBot确认发送并返回消息ID；不表示对方已读'}));}
  status({query='',limit=3}={}){return {paused:Boolean(this.control().paused),counts:Object.fromEntries(this.db.prepare('SELECT status,count(*) n FROM proactive_items GROUP BY status').all().map(row=>[row.status,row.n])),recent:this.db.prepare('SELECT id,status,source_key,intent_id,updated_at FROM proactive_items ORDER BY rowid DESC LIMIT 8').all(),published:this.publications(limit,query)};}
}
