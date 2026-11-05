import crypto from 'node:crypto';
const json=value=>value==null?null:JSON.parse(value);
export class ApplyStore{
  constructor(journal,now=()=>new Date()){
    this.journal=journal;this.db=journal.db;this.now=now;
    journal.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS apply_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
        INSERT OR IGNORE INTO apply_schema VALUES(1,1);`);
      if(this.db.prepare('SELECT version FROM apply_schema WHERE id=1').get().version!==1)throw new Error('不支持的提案应用数据版本');
      this.db.exec(`CREATE TABLE IF NOT EXISTS apply_runs(id TEXT PRIMARY KEY,report_id TEXT NOT NULL,selection_key TEXT NOT NULL UNIQUE,selection_json TEXT NOT NULL,approval_json TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,frame_json TEXT,plan_json TEXT,model_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS apply_steps(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,position INTEGER NOT NULL,operation_json TEXT NOT NULL,status TEXT NOT NULL,receipt_json TEXT,error TEXT,updated_at TEXT NOT NULL,UNIQUE(run_id,position));
        CREATE TABLE IF NOT EXISTS apply_attempts(run_id TEXT NOT NULL,attempt INTEGER NOT NULL,status TEXT NOT NULL,frame_json TEXT NOT NULL,result_json TEXT,error TEXT,at TEXT NOT NULL,PRIMARY KEY(run_id,attempt));
        CREATE TABLE IF NOT EXISTS apply_budget(day TEXT PRIMARY KEY,started_calls INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS apply_conversation_budget(day TEXT PRIMARY KEY,started_calls INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS apply_links(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,step_id TEXT NOT NULL,memory_ref TEXT NOT NULL,state_before TEXT NOT NULL,state_after TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS apply_runs_report ON apply_runs(report_id);
        CREATE INDEX IF NOT EXISTS apply_runs_status ON apply_runs(status);`);
      this.db.exec("CREATE INDEX IF NOT EXISTS apply_steps_retired_text ON apply_steps(json_extract(operation_json,'$.reference.text')) WHERE status='applied'");
      this.db.prepare("UPDATE apply_runs SET status='interrupted',error='上次应用被中断；保留原计划与回执，明确重试时先核对已发生的写入',updated_at=? WHERE status IN ('reviewing','applying')").run(this.time());
      this.db.prepare("UPDATE apply_attempts SET status='interrupted',error='审核被中断，未自动再次请求模型' WHERE status='reviewing'").run();
    });
  }
  time(){return this.now().toISOString();}
  day(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(this.now());}
  calls(kind='application'){const table=kind==='conversation'?'apply_conversation_budget':'apply_budget';return this.db.prepare(`SELECT started_calls FROM ${table} WHERE day=?`).get(this.day())?.started_calls??0;}
  reserveCall(limit){return this.journal.transaction(()=>{if(this.calls()>=limit)throw Error('今日共享记忆审核额度已用完');this.db.prepare('INSERT INTO apply_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET started_calls=started_calls+1').run(this.day());});}
  decode(row){return row&&{id:row.id,reportId:row.report_id,selectionKey:row.selection_key,selection:json(row.selection_json),approval:json(row.approval_json),status:row.status,attempts:row.attempts,frame:json(row.frame_json),plan:json(row.plan_json),model:json(row.model_json),error:row.error,createdAt:row.created_at,updatedAt:row.updated_at};}
  get(id){return this.decode(this.db.prepare('SELECT * FROM apply_runs WHERE id=?').get(id));}
  bySelection(key){return this.decode(this.db.prepare('SELECT * FROM apply_runs WHERE selection_key=?').get(key));}
  forReport(id){return this.db.prepare('SELECT id,status,selection_json,error,created_at FROM apply_runs WHERE report_id=? ORDER BY rowid').all(id).map(row=>({...row,selection:json(row.selection_json)}));}
  attempts(id){return this.db.prepare('SELECT attempt,status,result_json,error,at FROM apply_attempts WHERE run_id=? ORDER BY attempt DESC LIMIT 5').all(id).map(({result_json,...r})=>({...r,diagnostics:json(result_json)?.diagnostics??null}));}
  recent(limit=5){return this.db.prepare('SELECT id,report_id,status,error,updated_at FROM apply_runs ORDER BY rowid DESC LIMIT ?').all(limit);}
  retirements(content){
    const hasUndo=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='protection_undos'").get();
    const rows=this.db.prepare(`SELECT s.operation_json,json_extract(r.frame_json,'$.sources') sources_json FROM apply_steps s JOIN apply_runs r ON r.id=s.run_id WHERE s.status='applied' AND json_extract(s.operation_json,'$.reference.text')=? AND json_extract(s.operation_json,'$.kind') IN ('runtime_replace','native_correct','runtime_remove','native_forget') ${hasUndo?"AND NOT EXISTS(SELECT 1 FROM protection_undos u WHERE u.application_id=r.id AND u.status='completed')":''}`).all(content);
    return rows.map(row=>{const operation=json(row.operation_json),sources=json(row.sources_json)??[];return {kind:operation.kind,reference:operation.reference.id,sources:sources.filter(source=>['user_message','person_profile','profile_change_source'].includes(source.kind)&&operation.evidence.some(item=>item.sourceId===source.id))};});
  }
  steps(id){return this.db.prepare('SELECT * FROM apply_steps WHERE run_id=? ORDER BY position').all(id).map(row=>({id:row.id,position:row.position,operation:json(row.operation_json),status:row.status,receipt:json(row.receipt_json),error:row.error}));}
  begin({reportId,key,selection,approval,frame,limit,modelRequired,budgetKind='application'}){
    return this.journal.transaction(()=>{
      let row=this.bySelection(key);
      if(row?.plan)return {existing:true,row};
      if(row?.status==='reviewing')throw new Error('同一组提案正在应用审核中');
      if(modelRequired&&this.calls(budgetKind)>=limit)throw new Error(budgetKind==='conversation'?'今日日常记忆写入审核额度已用完':'今日提案应用审核额度已用完');
      const id=row?.id??crypto.randomUUID(),at=this.time();
      if(row)this.db.prepare("UPDATE apply_runs SET status='reviewing',approval_json=?,frame_json=?,attempts=attempts+1,error=NULL,updated_at=? WHERE id=?").run(JSON.stringify(approval),JSON.stringify(frame),at,id);
      else this.db.prepare("INSERT INTO apply_runs VALUES(?,?,?,?,?,'reviewing',1,?,NULL,NULL,NULL,?,?)").run(id,reportId,key,JSON.stringify(selection),JSON.stringify(approval),JSON.stringify(frame),at,at);
      row=this.get(id);this.db.prepare("INSERT INTO apply_attempts VALUES(?,?,'reviewing',?,NULL,NULL,?)").run(id,row.attempts,JSON.stringify(frame),at);
      if(modelRequired){const table=budgetKind==='conversation'?'apply_conversation_budget':'apply_budget';this.db.prepare(`INSERT INTO ${table} VALUES(?,1) ON CONFLICT(day) DO UPDATE SET started_calls=started_calls+1`).run(this.day());}
      return {row};
    });
  }
  prepare(id,plan,model,operations){
    return this.journal.transaction(()=>{
      const row=this.get(id);if(row?.status!=='reviewing'||row.plan)throw new Error('应用审核记录已变化');
      const at=this.time();this.db.prepare("UPDATE apply_runs SET status='prepared',plan_json=?,model_json=?,error=NULL,updated_at=? WHERE id=?").run(JSON.stringify(plan),JSON.stringify(model),at,id);
      this.db.prepare("UPDATE apply_attempts SET status='prepared',result_json=? WHERE run_id=? AND attempt=?").run(JSON.stringify(model),id,row.attempts);
      operations.forEach((operation,position)=>this.db.prepare("INSERT INTO apply_steps VALUES(?,?,?,?,'prepared',NULL,NULL,?)").run(crypto.randomUUID(),id,position,JSON.stringify(operation),at));
      return this.get(id);
    });
  }
  state(id,status,error=null){this.db.prepare('UPDATE apply_runs SET status=?,error=?,updated_at=? WHERE id=?').run(status,error,this.time(),id);}
  failReview(id,status,error,diagnostics=null){const row=this.get(id);this.journal.transaction(()=>{this.state(id,status,error);if(!row.plan)this.db.prepare('UPDATE apply_attempts SET status=?,error=?,result_json=COALESCE(?,result_json) WHERE run_id=? AND attempt=?').run(status,error,diagnostics?JSON.stringify({diagnostics}):null,id,row.attempts);});}
  step(id,status,receipt=null,error=null){this.db.prepare('UPDATE apply_steps SET status=?,receipt_json=COALESCE(?,receipt_json),error=?,updated_at=? WHERE id=?').run(status,receipt==null?null:JSON.stringify(receipt),error,this.time(),id);}
  link(runId,stepId,memoryRef,before,after,reason){this.db.prepare('INSERT INTO apply_links(run_id,step_id,memory_ref,state_before,state_after,reason,at) VALUES(?,?,?,?,?,?,?)').run(runId,stepId,memoryRef,before,after,reason,this.time());}
}
