import {nextIntentStatus} from './intent-machine.js';
import {randomUUID,createHash} from 'node:crypto';

const json = value => value == null ? null : JSON.parse(value);
const terminal = new Set(['completed','dismissed','cancelled','failed']);
export class AttentionStore {
  constructor(journal, now=()=>new Date(),diagnostics=null) {
    Object.assign(this,{journal,db:journal.db,now,diagnostics});
    this.db.exec(`CREATE TABLE IF NOT EXISTS attention_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,epoch INTEGER NOT NULL,considered INTEGER NOT NULL,retry_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO attention_meta VALUES(1,1,0,-1,0);
      CREATE TABLE IF NOT EXISTS attention_intents(id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,scope TEXT NOT NULL,summary TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL,wake_json TEXT,result_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attention_pending ON attention_intents(status);
      CREATE TABLE IF NOT EXISTS attention_decisions(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,snapshot_hash TEXT NOT NULL,decision_json TEXT,status TEXT NOT NULL,usage_json TEXT,error TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attention_attempts(decision_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('initial','repair')),status TEXT NOT NULL,error TEXT,usage_json TEXT,output_hash TEXT,started_at TEXT NOT NULL,finished_at TEXT,PRIMARY KEY(decision_id,phase));
      CREATE INDEX IF NOT EXISTS attention_attempts_recent ON attention_attempts(started_at);
      CREATE TABLE IF NOT EXISTS attention_checkpoints(task_id TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);`);
    if(this.meta().schema_version!==1)throw new Error('不支持的行为协调数据版本');
    // Execution is reconciled by each adapter. Never blindly replay a selected send.
    const recovering=diagnostics?this.db.prepare("SELECT id,kind,status FROM attention_intents WHERE status IN ('selected','admitting','waking','running','paused')").all():[];
    this.db.prepare("UPDATE attention_intents SET status='pending',error='重启后先核对原会话或任务，再决定是否继续',updated_at=? WHERE status IN ('selected','admitting','waking','running','paused')").run(this.time());
    for(const row of recovering)diagnostics.transition(row,row.status,'pending',{reason:'重启后先核对，未盲重放'});
    this.db.prepare("UPDATE attention_decisions SET status='interrupted',error='重启后不盲重放纠正请求' WHERE id IN (SELECT decision_id FROM attention_attempts WHERE status='running') AND status='thinking'").run();
    this.db.prepare("UPDATE attention_attempts SET status='interrupted',error='进程重启，未盲重放',finished_at=? WHERE status='running'").run(this.time());this.signal('restart');
  }
  time(){return this.now().toISOString();}
  meta(){return this.db.prepare('SELECT * FROM attention_meta WHERE id=1').get();}
  signal(kind='event'){
    this.journal.transaction(()=>{
      this.db.prepare('UPDATE attention_meta SET epoch=epoch+1 WHERE id=1').run();
      for(const row of this.db.prepare("SELECT id,kind,wake_json FROM attention_intents WHERE status='waiting'").all()){
        const wake=json(row.wake_json);
        if(wake?.kind===kind||wake?.kind==='change'&&kind!=='timer'){
          nextIntentStatus('waiting','pending');this.db.prepare("UPDATE attention_intents SET status='pending',wake_json=NULL,updated_at=? WHERE id=?").run(this.time(),row.id);
          this.diagnostics?.transition(row,'waiting','pending',{wake,reason:'等待条件唤起：'+kind});
        }
      }
    });
  }
  decode(row){if(!row)return null;const {payload_json,wake_json,result_json,...rest}=row;return {...rest,payload:json(payload_json),wake:json(wake_json),result:json(result_json)};}
  get(id){return this.decode(this.db.prepare('SELECT * FROM attention_intents WHERE id=?').get(id));}
  byKey(key){return this.decode(this.db.prepare('SELECT * FROM attention_intents WHERE event_key=?').get(key));}
  offer({key,kind,scope='owner',summary,payload={}}){
    const old=this.byKey(key);if(old)return old;
    if(typeof key!=='string'||key.length>300||typeof kind!=='string'||kind.length>40||!['owner','public','external','internal'].includes(scope))throw new Error('行为事项身份或范围无效');
    if(typeof summary!=='string'||!summary.trim()||summary.length>1000||JSON.stringify(payload).length>150000)throw new Error('行为事项正文超出范围');
    const id=randomUUID(),at=this.time();
    this.journal.transaction(()=>{this.db.prepare("INSERT INTO attention_intents VALUES(?,?,?,?,?,?,'pending',NULL,NULL,NULL,?,?)").run(id,key,kind,scope,summary,JSON.stringify(payload),at,at);this.db.prepare('UPDATE attention_meta SET epoch=epoch+1 WHERE id=1').run();this.diagnostics?.transition({id,kind},null,'pending',{reason:'新事项已保存，尚未选择回应'});});
    this.signal('event');return this.get(id);
  }
  patch(id,status,{wake=null,result=null,error=null,reconcile=false}={}){
    const previous=this.get(id);if(!previous)return false;status=nextIntentStatus(previous.status,status,{reconcile});
    this.db.prepare('UPDATE attention_intents SET status=?,wake_json=?,result_json=coalesce(?,result_json),error=?,updated_at=? WHERE id=? AND status=?').run(status,wake?JSON.stringify(wake):null,result?JSON.stringify(result):null,error,this.time(),id,previous.status);
    if(this.diagnostics&&previous&&(previous.status!==status||JSON.stringify(previous.wake)!==JSON.stringify(wake)||result?.reason&&result.reason!==previous.result?.reason))this.diagnostics.transition(previous,previous.status,status,{wake:wake??previous.wake,reason:result?.reason??error??null});
  }
  updatePayload(id,payload){this.db.prepare('UPDATE attention_intents SET payload_json=?,updated_at=? WHERE id=?').run(JSON.stringify(payload),this.time(),id);}
  pending(){return this.db.prepare("SELECT * FROM attention_intents WHERE status IN ('pending','paused') ORDER BY rowid LIMIT 32").all().map(row=>this.decode(row));}
  running(){return this.db.prepare("SELECT * FROM attention_intents WHERE status IN ('selected','running') ORDER BY rowid").all().map(row=>this.decode(row));}
  recent(limit=15){return this.db.prepare('SELECT * FROM attention_intents ORDER BY updated_at DESC,rowid DESC LIMIT ?').all(limit).map(row=>this.decode(row));}
  due(){
    const due=this.db.prepare("SELECT id,wake_json FROM attention_intents WHERE status='waiting' AND json_extract(wake_json,'$.kind')='time' AND json_extract(wake_json,'$.at')<=?").all(this.now().valueOf());
    if(due.length)this.journal.transaction(()=>{for(const row of due)this.patch(row.id,'pending');this.db.prepare('UPDATE attention_meta SET epoch=epoch+1 WHERE id=1').run();});
    return due.length;
  }
  begin(epoch,frame){const id=randomUUID();this.db.prepare("INSERT INTO attention_decisions VALUES(?,?,?,NULL,'thinking',NULL,NULL,?)").run(id,epoch,createHash('sha256').update(JSON.stringify(frame)).digest('hex'),this.time());return id;}
  finish(id,status,answer,error=null){this.db.prepare('UPDATE attention_decisions SET status=?,decision_json=?,usage_json=?,error=? WHERE id=?').run(status,answer?JSON.stringify(answer.decision):null,answer?.usage?JSON.stringify(answer.usage):null,error,id);}
  beginAttempt(call,phase){this.db.prepare("INSERT INTO attention_attempts VALUES(?,?,'running',NULL,NULL,NULL,?,NULL)").run(call,phase,this.time());}
  finishAttempt(call,phase,status,{error=null,usage=null,outputHash=null}={}){this.db.prepare('UPDATE attention_attempts SET status=?,error=?,usage_json=?,output_hash=?,finished_at=? WHERE decision_id=? AND phase=? AND status=\'running\'').run(status,error,usage?JSON.stringify(usage):null,outputHash,this.time(),call,phase);}
  checkpoint(id,value){this.db.prepare('INSERT INTO attention_checkpoints VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(id,JSON.stringify(value),this.time());}
  readCheckpoint(id){return json(this.db.prepare('SELECT value_json FROM attention_checkpoints WHERE task_id=?').get(id)?.value_json);}
  terminal(id){return terminal.has(this.get(id)?.status);}
}
