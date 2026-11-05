import crypto from 'node:crypto';
const decode=value=>value==null?null:JSON.parse(value);
export class PreviewStore{
  constructor(journal,now=()=>new Date(),namespace='manual'){
    if(!['manual','nightly'].includes(namespace))throw new Error('未知预演进度范围');
    this.namespace=namespace;this.cursorTable=namespace==='nightly'?'nightly_preview_cursors':'preview_cursors';
    this.journal=journal;this.db=journal.db;this.now=now;
    journal.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS preview_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
        INSERT OR IGNORE INTO preview_schema VALUES(1,1);`);
      if(this.db.prepare('SELECT version FROM preview_schema WHERE id=1').get().version!==1)throw new Error('不支持的预演数据版本');
      this.db.exec(`CREATE TABLE IF NOT EXISTS preview_cursors(session_id TEXT PRIMARY KEY,next_seq INTEGER NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preview_runs(id TEXT PRIMARY KEY,batch_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,snapshot_json TEXT NOT NULL,result_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preview_attempts(run_id TEXT NOT NULL,attempt INTEGER NOT NULL,status TEXT NOT NULL,result_json TEXT,error TEXT,at TEXT NOT NULL,PRIMARY KEY(run_id,attempt));
        CREATE TABLE IF NOT EXISTS preview_budget(day TEXT PRIMARY KEY,started_calls INTEGER NOT NULL);`);
      if(namespace==='nightly')this.db.exec('CREATE TABLE IF NOT EXISTS nightly_preview_cursors(session_id TEXT PRIMARY KEY,next_seq INTEGER NOT NULL,updated_at TEXT NOT NULL)');
      if(namespace==='manual')this.db.prepare("UPDATE preview_runs SET status='interrupted',error='上次预演被中断，游标未提交；可明确重试',updated_at=? WHERE status='running'").run(this.time());
      if(namespace==='manual')this.db.prepare("UPDATE preview_attempts SET status='interrupted',error='上次预演被中断' WHERE status='running'").run();
    });
  }
  time(){return this.now().toISOString();}
  day(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(this.now());}
  budget(){return this.db.prepare('SELECT started_calls FROM preview_budget WHERE day=?').get(this.day())?.started_calls??0;}
  cursors(){return Object.fromEntries(this.db.prepare(`SELECT * FROM ${this.cursorTable}`).all().map(row=>[row.session_id,{nextSeq:row.next_seq,updatedAt:row.updated_at}]));}
  touch(ranges){
    if(this.namespace!=='nightly')throw new Error('仅后台扫描允许轮转空会话');
    this.journal.transaction(()=>{for(const range of ranges){
      const prior=this.db.prepare('SELECT next_seq FROM nightly_preview_cursors WHERE session_id=?').get(range.sessionId);
      this.db.prepare('INSERT INTO nightly_preview_cursors VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET updated_at=excluded.updated_at').run(range.sessionId,prior?.next_seq??range.from,this.time());
    }});
  }
  get(id){const row=this.db.prepare('SELECT * FROM preview_runs WHERE id=?').get(id);return row&&this.decode(row);}
  byKey(key){const row=this.db.prepare('SELECT * FROM preview_runs WHERE batch_key=?').get(key);return row&&this.decode(row);}
  decode(row){return {id:row.id,status:row.status,attempts:row.attempts,snapshot:decode(row.snapshot_json),result:decode(row.result_json),error:row.error,createdAt:row.created_at,updatedAt:row.updated_at};}
  list(limit=5){return this.db.prepare('SELECT id,status,attempts,created_at,updated_at,error FROM preview_runs ORDER BY rowid DESC LIMIT ?').all(limit);}
  attempts(id,includeUnvalidated=false){return this.db.prepare('SELECT attempt,status,result_json,error,at FROM preview_attempts WHERE run_id=? ORDER BY attempt DESC LIMIT 5').all(id).map(({result_json,...r})=>{const value=decode(result_json);return {...r,diagnostics:value?.diagnostics??null,reviewPhases:(value?.reviewPhases??[]).map(p=>includeUnvalidated?p:(({unvalidatedDecision,...metadata})=>metadata)(p))};});}
  reviewPhase(id,phase){
    if(!['initial','repair'].includes(phase.phase))throw Error('未知预演审核阶段');
    const row=this.get(id);if(row?.status!=='running')throw Error('预演阶段已关闭');
    const prior=decode(this.db.prepare('SELECT result_json FROM preview_attempts WHERE run_id=? AND attempt=?').get(id,row.attempts).result_json)??{};
    const phases=(prior.reviewPhases??[]).filter(p=>p.phase!==phase.phase);phases.push(phase);
    this.db.prepare('UPDATE preview_attempts SET result_json=? WHERE run_id=? AND attempt=?').run(JSON.stringify({...prior,reviewPhases:phases}),id,row.attempts);
  }
  reserveRepair(id,limit){return this.journal.transaction(()=>{
    const row=this.get(id);if(row?.status!=='running')throw Error('预演阶段已关闭');
    const prior=decode(this.db.prepare('SELECT result_json FROM preview_attempts WHERE run_id=? AND attempt=?').get(id,row.attempts).result_json)??{};
    if(prior.reviewPhases?.some(p=>p.phase==='repair'))throw Error('同一次预演最多一次结构纠正');
    if(this.budget()>=limit)throw Object.assign(Error('今日预演结构纠正额度已用完'),{code:'PREVIEW_BUDGET'});
    this.db.prepare('INSERT INTO preview_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET started_calls=started_calls+1').run(this.day());
    this.reviewPhase(id,{phase:'repair',status:'reserved',at:this.time()});
  });}
  begin(key,snapshot,limit,usesModel,checkpoint){
    return this.journal.transaction(()=>{
      const old=this.byKey(key);
      if(old&&['completed','empty'].includes(old.status)){checkpoint?.(old.id);return {replayed:true,row:old};}
      if(old?.status==='running')throw new Error('同一批预演正在执行');
      if(usesModel&&this.budget()>=limit)throw new Error('今日记忆预演模型额度已用完');
      const id=old?.id??crypto.randomUUID(),at=this.time();
      if(old)this.db.prepare("UPDATE preview_runs SET status='running',attempts=attempts+1,snapshot_json=?,result_json=NULL,error=NULL,updated_at=? WHERE id=?").run(JSON.stringify(snapshot),at,id);
      else this.db.prepare("INSERT INTO preview_runs VALUES(?,?,'running',1,?,NULL,NULL,?,?)").run(id,key,JSON.stringify(snapshot),at,at);
      const row=this.get(id);
      this.db.prepare("INSERT INTO preview_attempts VALUES(?,?,'running',NULL,NULL,?)").run(id,row.attempts,at);
      if(usesModel)this.db.prepare('INSERT INTO preview_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET started_calls=started_calls+1').run(this.day());
      checkpoint?.(id);
      return {row};
    });
  }
  finish(id,status,result,error=null,diagnostics=null){
    return this.journal.transaction(()=>{
      const row=this.get(id);if(row?.status!=='running')throw new Error('预演记录已结束或不存在');
      if(status==='completed'||status==='empty'){
        for(const range of row.snapshot.sources.ranges){
          const current=this.db.prepare(`SELECT next_seq FROM ${this.cursorTable} WHERE session_id=?`).get(range.sessionId)?.next_seq??0;
          if(current!==range.from)throw new Error('预演进度发生并发变化，旧报告不能推进游标');
        }
        for(const range of row.snapshot.sources.ranges)if(range.nextSeq>range.from)this.db.prepare(`INSERT INTO ${this.cursorTable} VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET next_seq=excluded.next_seq,updated_at=excluded.updated_at`).run(range.sessionId,range.nextSeq,this.time());
      }
      const previous=decode(this.db.prepare('SELECT result_json FROM preview_attempts WHERE run_id=? AND attempt=?').get(id,row.attempts).result_json);
      const value=result==null?null:JSON.stringify({...result,...diagnostics?{diagnostics}:{}}),attemptData=result?{...result,...diagnostics?{diagnostics}:{}}:diagnostics?{diagnostics}:{};
      if(previous?.reviewPhases)attemptData.reviewPhases=previous.reviewPhases;
      const attemptValue=Object.keys(attemptData).length?JSON.stringify(attemptData):null;
      this.db.prepare('UPDATE preview_runs SET status=?,result_json=?,error=?,updated_at=? WHERE id=?').run(status,value,error,this.time(),id);
      this.db.prepare('UPDATE preview_attempts SET status=?,result_json=?,error=? WHERE run_id=? AND attempt=?').run(status,attemptValue,error,id,row.attempts);
      return this.get(id);
    });
  }
}
