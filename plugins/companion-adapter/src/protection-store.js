import crypto from 'node:crypto';
const decode=value=>value==null?null:JSON.parse(value);
export class ProtectionStore{
  constructor(journal,now=()=>new Date()){
    Object.assign(this,{journal,db:journal.db,now});
    journal.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS protection_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);INSERT OR IGNORE INTO protection_schema VALUES(1,1);`);
      if(this.db.prepare('SELECT version FROM protection_schema WHERE id=1').get().version!==1)throw new Error('不支持的记忆保护数据版本');
      this.db.exec(`CREATE TABLE IF NOT EXISTS protection_snapshots(id TEXT PRIMARY KEY,application_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,manifest_json TEXT,after_json TEXT,bytes INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS protection_undos(id TEXT PRIMARY KEY,application_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,approval_json TEXT NOT NULL,plan_json TEXT NOT NULL,receipt_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS protection_undo_steps(undo_id TEXT NOT NULL,position INTEGER NOT NULL,status TEXT NOT NULL,operation_json TEXT NOT NULL,receipt_json TEXT,error TEXT,PRIMARY KEY(undo_id,position));
        CREATE TABLE IF NOT EXISTS protection_corrections(correction_id TEXT PRIMARY KEY,undo_id TEXT NOT NULL);`);
      this.db.prepare("UPDATE protection_snapshots SET status='failed',error='快照创建被中断，尚未获得写入许可',updated_at=? WHERE status='building'").run(this.time());
      this.db.prepare("UPDATE protection_undos SET status='interrupted',error='上次撤销中断，必须按原步骤读回核验',updated_at=? WHERE status='running'").run(this.time());
    });
  }
  time(){return this.now().toISOString();}
  snapshot(id){const row=this.db.prepare('SELECT * FROM protection_snapshots WHERE application_id=?').get(id);return row&&{...row,manifest:decode(row.manifest_json),after:decode(row.after_json)};}
  begin(id){const row=this.snapshot(id);if(row)return row;const at=this.time(),snapshotId=crypto.randomUUID();this.db.prepare("INSERT INTO protection_snapshots(id,application_id,status,created_at,updated_at) VALUES(?,?,'building',?,?)").run(snapshotId,id,at,at);return this.snapshot(id);}
  ready(id,manifest,bytes){this.db.prepare("UPDATE protection_snapshots SET status='ready',manifest_json=?,bytes=?,error=NULL,updated_at=? WHERE application_id=?").run(JSON.stringify(manifest),bytes,this.time(),id);}
  seal(id,after){this.db.prepare("UPDATE protection_snapshots SET status='sealed',after_json=?,error=NULL,updated_at=? WHERE application_id=?").run(JSON.stringify(after),this.time(),id);}
  fail(id,message){this.db.prepare("UPDATE protection_snapshots SET status='failed',error=?,updated_at=? WHERE application_id=?").run(message,this.time(),id);}
  liveSnapshots(){return this.db.prepare("SELECT application_id,bytes,status FROM protection_snapshots WHERE status IN ('ready','sealed') ORDER BY rowid").all();}
  expire(id){this.db.prepare("UPDATE protection_snapshots SET status='expired',after_json=NULL,updated_at=? WHERE application_id=?").run(this.time(),id);}
  undo(id){const row=this.db.prepare('SELECT * FROM protection_undos WHERE application_id=?').get(id);return row&&{...row,approval:decode(row.approval_json),plan:decode(row.plan_json),receipt:decode(row.receipt_json)};}
  beginUndo(id,approval,operations){const old=this.undo(id);if(old)return old;const undoId=crypto.randomUUID(),at=this.time();this.journal.transaction(()=>{this.db.prepare("INSERT INTO protection_undos VALUES(?,?,'prepared',?,?,NULL,NULL,?,?)").run(undoId,id,JSON.stringify(approval),JSON.stringify(operations),at,at);operations.forEach((operation,position)=>this.db.prepare("INSERT INTO protection_undo_steps VALUES(?,?,'prepared',?,NULL,NULL)").run(undoId,position,JSON.stringify(operation)));});return this.undo(id);}
  undoSteps(id){return this.db.prepare('SELECT * FROM protection_undo_steps WHERE undo_id=? ORDER BY position').all(id).map(row=>({...row,operation:decode(row.operation_json),receipt:decode(row.receipt_json)}));}
  undoStep(id,position,status,receipt=null,error=null){this.db.prepare('UPDATE protection_undo_steps SET status=?,receipt_json=COALESCE(?,receipt_json),error=? WHERE undo_id=? AND position=?').run(status,receipt==null?null:JSON.stringify(receipt),error,id,position);}
  undoState(id,status,error=null,receipt=null){this.db.prepare('UPDATE protection_undos SET status=?,error=?,receipt_json=COALESCE(?,receipt_json),updated_at=? WHERE application_id=?').run(status,error,receipt==null?null:JSON.stringify(receipt),this.time(),id);}
}
