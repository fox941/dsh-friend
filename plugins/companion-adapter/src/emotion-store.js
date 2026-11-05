import crypto from 'node:crypto';
const decode=row=>row?{...JSON.parse(row.record_json),versionId:row.id,previousVersionId:row.previous_id,sourceId:row.source_id,createdAt:row.created_at}:null;
export class EmotionStore{
  constructor(journal,now){Object.assign(this,{journal,db:journal.db,now});journal.transaction(()=>{
    this.db.exec(`CREATE TABLE IF NOT EXISTS emotion_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);INSERT OR IGNORE INTO emotion_schema VALUES(1,1);
      CREATE TABLE IF NOT EXISTS emotion_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);INSERT OR IGNORE INTO emotion_meta VALUES('revision',0);
      CREATE TABLE IF NOT EXISTS emotion_versions(id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,previous_id TEXT,source_id TEXT NOT NULL,record_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS emotion_versions_episode ON emotion_versions(episode_id,created_at);
      CREATE TABLE IF NOT EXISTS emotion_heads(episode_id TEXT PRIMARY KEY,version_id TEXT NOT NULL,topic_label TEXT NOT NULL UNIQUE,active_until INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS emotion_heads_active ON emotion_heads(active_until);
      CREATE TABLE IF NOT EXISTS emotion_supports(episode_id TEXT NOT NULL,fingerprint TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(episode_id,fingerprint));
      CREATE TABLE IF NOT EXISTS emotion_review_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,batch_id TEXT NOT NULL,status TEXT NOT NULL,request_json TEXT NOT NULL,review_json TEXT,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
      CREATE TABLE IF NOT EXISTS emotion_batches(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,base_revision INTEGER NOT NULL,status TEXT NOT NULL,request_json TEXT NOT NULL,review_json TEXT,receipt_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
    if(this.db.prepare('SELECT version FROM emotion_schema').get().version!==1)throw new Error('不支持的情绪数据版本');
    this.db.prepare("UPDATE emotion_batches SET status='interrupted',error='上次情绪审核中断，未提交变化',updated_at=? WHERE status='reviewing'").run(this.time());
    this.db.prepare("UPDATE emotion_review_attempts SET status='interrupted',error='上次情绪审核中断，未提交变化',finished_at=? WHERE status='reviewing'").run(this.time());
  });}
  time(){return this.now().toISOString();}
  revision(){return this.db.prepare("SELECT value FROM emotion_meta WHERE key='revision'").get().value;}
  advance(){this.db.prepare("UPDATE emotion_meta SET value=value+1 WHERE key='revision'").run();return this.revision();}
  head(id){return decode(this.db.prepare('SELECT v.* FROM emotion_heads h JOIN emotion_versions v ON v.id=h.version_id WHERE h.episode_id=?').get(id));}
  topic(key){return this.db.prepare('SELECT episode_id FROM emotion_heads WHERE topic_label=?').get(key)?.episode_id;}
  heads({all=false,limit=128}={}){return this.db.prepare(`SELECT v.* FROM emotion_heads h JOIN emotion_versions v ON v.id=h.version_id ${all?'':'WHERE h.active_until>?'} ORDER BY v.rowid DESC LIMIT ?`).all(...all?[]:[this.now().valueOf()],limit).map(decode);}
  put(record,sourceId,{fingerprint=null}={}){
    const previous=this.head(record.episodeId),id=crypto.randomUUID(),at=this.time();
    this.db.prepare('INSERT INTO emotion_versions VALUES(?,?,?,?,?,?)').run(id,record.episodeId,previous?.versionId??null,sourceId,JSON.stringify(record),at);
    const until=Date.parse(record.anchorAt)+record.halfLifeMinutes*48*60000;
    this.db.prepare('INSERT INTO emotion_heads VALUES(?,?,?,?) ON CONFLICT(episode_id) DO UPDATE SET version_id=excluded.version_id,active_until=excluded.active_until').run(record.episodeId,id,record.topicLabel,until);
    if(fingerprint)this.db.prepare('INSERT OR IGNORE INTO emotion_supports VALUES(?,?,?)').run(record.episodeId,fingerprint,sourceId);
    return this.head(record.episodeId);
  }
  supported(id,fingerprint){return Boolean(this.db.prepare('SELECT 1 FROM emotion_supports WHERE episode_id=? AND fingerprint=?').get(id,fingerprint));}
  batch(id){const r=this.db.prepare('SELECT * FROM emotion_batches WHERE id=?').get(id);return r&&{...r,request:JSON.parse(r.request_json),review:r.review_json?JSON.parse(r.review_json):null,receipt:r.receipt_json?JSON.parse(r.receipt_json):null};}
  begin(id,source,revision,request){const at=this.time(),json=JSON.stringify(request);this.db.prepare("INSERT INTO emotion_batches VALUES(?,?,?,'reviewing',?,NULL,NULL,NULL,?,?) ON CONFLICT(id) DO UPDATE SET status='reviewing',error=NULL,updated_at=excluded.updated_at").run(id,source,revision,json,at,at);this.db.prepare("INSERT INTO emotion_review_attempts(batch_id,status,request_json,created_at) VALUES(?,'reviewing',?,?)").run(id,json,at);}
  finish(id,status,review,receipt,error=null){const at=this.time(),json=review?JSON.stringify(review):null;this.db.prepare('UPDATE emotion_batches SET status=?,review_json=?,receipt_json=?,error=?,updated_at=? WHERE id=?').run(status,json,receipt?JSON.stringify(receipt):null,error,at,id);this.db.prepare('UPDATE emotion_review_attempts SET status=?,review_json=?,error=?,finished_at=? WHERE id=(SELECT max(id) FROM emotion_review_attempts WHERE batch_id=?)').run(status,json,error,at,id);}
  history(id,limit=10){return this.db.prepare(`SELECT * FROM emotion_versions ${id?'WHERE episode_id=?':''} ORDER BY rowid DESC LIMIT ?`).all(...id?[id]:[],limit).map(decode);}
}
