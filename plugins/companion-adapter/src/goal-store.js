import {randomUUID} from 'node:crypto';

export const closedGoals=new Set(['completed','abandoned']);
export const closedSteps=new Set(['completed','failed','cancelled']);
const decode=row=>row?JSON.parse(row.value_json):null;

/** The sole authoritative goal store. Task/session lists are not additional goal stores. */
export class GoalStore {
  constructor(journal,now=()=>new Date()) {
    Object.assign(this,{journal,db:journal.db,now});
    this.db.exec(`CREATE TABLE IF NOT EXISTS goal_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO goal_meta VALUES(1,1,0);
      CREATE TABLE IF NOT EXISTS companion_goals(id TEXT PRIMARY KEY,goal_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_goals_status ON companion_goals(status);
      CREATE TABLE IF NOT EXISTS goal_steps(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,status TEXT NOT NULL,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS goal_steps_parent ON goal_steps(goal_id,status);
      CREATE INDEX IF NOT EXISTS goal_steps_unfinished ON goal_steps(status) WHERE status NOT IN ('completed','failed','cancelled');
      CREATE TABLE IF NOT EXISTS goal_changes(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,reason TEXT NOT NULL,source_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS goal_operations(operation_key TEXT PRIMARY KEY,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
    if(this.db.prepare('SELECT schema_version FROM goal_meta WHERE id=1').get().schema_version!==1)throw new Error('不支持的长期目标数据版本');
  }
  time(){return this.now().toISOString();}
  revision(){return this.db.prepare('SELECT revision FROM goal_meta WHERE id=1').get().revision;}
  get(id){return decode(this.db.prepare('SELECT value_json FROM companion_goals WHERE id=?').get(id));}
  byKey(key){return decode(this.db.prepare('SELECT value_json FROM companion_goals WHERE goal_key=?').get(key));}
  list({all=false,limit=30}={}){return this.db.prepare(`SELECT value_json FROM companion_goals ${all?'':"WHERE status NOT IN ('completed','abandoned')"} ORDER BY updated_at DESC,rowid DESC LIMIT ?`).all(limit).map(decode);}
  step(id){return decode(this.db.prepare('SELECT value_json FROM goal_steps WHERE id=?').get(id));}
  steps(id){return this.db.prepare('SELECT value_json FROM goal_steps WHERE goal_id=? ORDER BY rowid').all(id).map(decode);}
  receipt(key){const row=this.db.prepare('SELECT receipt_json FROM goal_operations WHERE operation_key=?').get(key);return row?JSON.parse(row.receipt_json):null;}
  saveReceipt(key,value){this.db.prepare('INSERT INTO goal_operations VALUES(?,?,?)').run(key,JSON.stringify(value),this.time());}
  saveStep(step){this.db.prepare('INSERT INTO goal_steps VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value_json=excluded.value_json,updated_at=excluded.updated_at').run(step.id,step.goalId,step.status,JSON.stringify(step),this.time());}
  save(goal,action,reason,source,before=null){
    goal.revision=(before?.revision??0)+1;goal.updatedAt=this.time();
    this.db.prepare('INSERT INTO companion_goals VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,revision=excluded.revision,value_json=excluded.value_json,updated_at=excluded.updated_at').run(goal.id,goal.key,goal.status,goal.revision,JSON.stringify(goal),goal.updatedAt);
    this.db.prepare('INSERT INTO goal_changes VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),goal.id,goal.revision,action,before?JSON.stringify(before):null,JSON.stringify(goal),reason,JSON.stringify(source),this.time());
    this.db.prepare('UPDATE goal_meta SET revision=revision+1 WHERE id=1').run();return goal;
  }
  note(goal,action,reason,source){this.db.prepare('INSERT INTO goal_changes VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),goal.id,goal.revision,action,JSON.stringify(goal),JSON.stringify(goal),reason,JSON.stringify(source),this.time());}
  history(id,limit=20){return this.db.prepare('SELECT * FROM goal_changes WHERE goal_id=? ORDER BY rowid DESC LIMIT ?').all(id,limit).map(row=>({id:row.id,revision:row.revision,action:row.action,reason:row.reason,source:JSON.parse(row.source_json),before:row.before_json?JSON.parse(row.before_json):null,after:JSON.parse(row.after_json),at:row.created_at}));}
}
