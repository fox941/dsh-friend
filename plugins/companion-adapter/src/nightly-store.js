import crypto from 'node:crypto';
import {nightlyRequestKey} from './nightly-protocol.js';
const dayMs=86400000,offset=8*3600000;
export const shanghaiDay=time=>new Date(time+offset).toISOString().slice(0,10);
export function dailyWindow(time,clock='02:00'){
  const [hours,minutes]=clock.split(':').map(Number),today=Math.floor((time+offset)/dayMs)*dayMs-offset+(hours*60+minutes)*60000;
  return {last:time>=today?today:today-dayMs,next:time>=today?today+dayMs:today};
}
const decode=value=>value==null?null:JSON.parse(value);
export class NightlyStore{
  constructor(journal,config,now=()=>new Date()){
    Object.assign(this,{journal,db:journal.db,config,now});
    journal.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS nightly_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);INSERT OR IGNORE INTO nightly_schema VALUES(1,1);`);
      if(this.db.prepare('SELECT version FROM nightly_schema WHERE id=1').get().version!==1)throw new Error('不支持的夜间整理数据版本');
      this.db.exec(`CREATE TABLE IF NOT EXISTS nightly_control(id INTEGER PRIMARY KEY CHECK(id=1),enabled_override INTEGER,revision INTEGER NOT NULL,schedule_key TEXT NOT NULL,next_due INTEGER NOT NULL,reason TEXT,installed_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS nightly_runs(id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,trigger TEXT NOT NULL,scheduled_for INTEGER,missed_days INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retries INTEGER NOT NULL DEFAULT 0,not_before INTEGER NOT NULL DEFAULT 0,authorization_json TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS nightly_runs_status ON nightly_runs(status,not_before);
        CREATE TABLE IF NOT EXISTS nightly_batches(run_id TEXT NOT NULL,position INTEGER NOT NULL,status TEXT NOT NULL,report_id TEXT,application_id TEXT,result_json TEXT,error TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(run_id,position));
        CREATE TABLE IF NOT EXISTS nightly_budget(day TEXT PRIMARY KEY,started_calls INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS nightly_calls(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,error TEXT,at TEXT NOT NULL);`);
      const at=this.time(),key=`Asia/Shanghai@${config.time}`;
      this.db.prepare('INSERT OR IGNORE INTO nightly_control VALUES(1,NULL,0,?,?,NULL,?,?)').run(key,dailyWindow(this.ms(),config.time).next,at,at);
      const current=this.control();if(current.schedule_key!==key)this.db.prepare('UPDATE nightly_control SET schedule_key=?,next_due=?,revision=revision+1,updated_at=? WHERE id=1').run(key,dailyWindow(this.ms(),config.time).next,at);
      this.db.prepare("UPDATE nightly_runs SET status='interrupted',error='上次整理中断，按持久检查点核对后继续',updated_at=? WHERE status='running'").run(at);
      this.db.prepare("UPDATE nightly_calls SET status='interrupted',error='上次模型调用中断，调用额度仍保留' WHERE status='started'").run();
    });
  }
  ms(){return this.now().getTime();}
  time(){return this.now().toISOString();}
  control(){return this.db.prepare('SELECT * FROM nightly_control WHERE id=1').get();}
  enabled(){return this.config.enabled&&this.control().enabled_override!==0;}
  calls(){return this.db.prepare('SELECT started_calls FROM nightly_budget WHERE day=?').get(shanghaiDay(this.ms()))?.started_calls??0;}
  get(id){const row=this.db.prepare('SELECT * FROM nightly_runs WHERE id=?').get(id);return row&&{...row,authorization:decode(row.authorization_json)};}
  recent(limit=5){return this.db.prepare('SELECT id,trigger,scheduled_for,missed_days,status,attempts,retries,error,created_at,updated_at FROM nightly_runs ORDER BY rowid DESC LIMIT ?').all(limit);}
  queue(key,trigger,authorization,scheduledFor=null,missedDays=0){
    const old=this.db.prepare('SELECT id FROM nightly_runs WHERE request_key=?').get(key);if(old)return this.get(old.id);
    const id=crypto.randomUUID(),at=this.time();this.db.prepare("INSERT INTO nightly_runs(id,request_key,trigger,scheduled_for,missed_days,status,authorization_json,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?)").run(id,key,trigger,scheduledFor,missedDays,JSON.stringify(authorization),at,at);return this.get(id);
  }
  due(){
    if(!this.enabled()||this.control().next_due>this.ms())return null;
    return this.journal.transaction(()=>{
      const prior=this.control();if(prior.next_due>this.ms())return null;
      const window=dailyWindow(this.ms(),this.config.time),existing=this.db.prepare("SELECT id FROM nightly_runs WHERE trigger='scheduled' AND status IN ('queued','yielded','interrupted','retry_wait','budget_exhausted','running') ORDER BY rowid LIMIT 1").get();
      // A pending increment already covers unconsumed source cursors. Advance
      // the calendar without creating a second automatic writer for those sources.
      const row=existing?this.get(existing.id):this.queue(`scheduled:${window.last}`,'scheduled',{kind:'nightly-policy',policy:'nightly-v1',schedule:prior.schedule_key,authorizedAt:prior.installed_at},window.last,Math.max(0,Math.floor((window.last-prior.next_due)/dayMs)));
      this.db.prepare('UPDATE nightly_control SET next_due=?,updated_at=? WHERE id=1').run(window.next,this.time());return row;
    });
  }
  pending(){
    const rows=this.db.prepare("SELECT id FROM nightly_runs WHERE status IN ('queued','yielded','interrupted','retry_wait','budget_exhausted') AND not_before<=? ORDER BY rowid").all(this.ms());
    return rows.map(row=>this.get(row.id)).find(row=>row.trigger==='manual'||this.enabled())??null;
  }
  claim(id){const result=this.db.prepare("UPDATE nightly_runs SET status='running',attempts=attempts+1,error=NULL,updated_at=? WHERE id=? AND status IN ('queued','yielded','interrupted','retry_wait','budget_exhausted') AND not_before<=? AND (trigger='manual' OR ?=1)").run(this.time(),id,this.ms(),this.enabled()?1:0);return result.changes?this.get(id):null;}
  state(id,status,error=null,notBefore=0){this.db.prepare('UPDATE nightly_runs SET status=?,error=?,not_before=?,updated_at=? WHERE id=?').run(status,error,notBefore,this.time(),id);}
  retry(id,error){const row=this.get(id);this.db.prepare('UPDATE nightly_runs SET retries=retries+1 WHERE id=?').run(id);this.state(id,row.retries<this.config.retryLimit?'retry_wait':'failed',error,this.ms()+this.config.retryDelaySeconds*1000);}
  setEnabled(enabled,reason){this.db.prepare('UPDATE nightly_control SET enabled_override=?,revision=revision+1,reason=?,updated_at=? WHERE id=1').run(enabled?1:0,reason,this.time());}
  cancelQueued(reason){this.db.prepare("UPDATE nightly_runs SET status='cancelled',error=?,updated_at=? WHERE status IN ('queued','yielded','interrupted','retry_wait','budget_exhausted')").run(reason,this.time());}
  retryExplicit(id,authorization){const row=this.get(id);if(row?.authorization?.action==='retry'&&nightlyRequestKey(row.authorization)===nightlyRequestKey(authorization))return {...row,repeated:true};if(!row||!['failed','needs_attention','cancelled','budget_exhausted','interrupted','retry_wait'].includes(row.status))throw new Error('该任务没有需要明确重试的检查点');this.db.prepare("UPDATE nightly_runs SET status='queued',trigger='manual',retries=0,not_before=0,authorization_json=?,error=NULL,updated_at=? WHERE id=?").run(JSON.stringify(authorization),this.time(),id);return this.get(id);}
  batches(id){return this.db.prepare('SELECT * FROM nightly_batches WHERE run_id=? ORDER BY position').all(id).map(row=>({...row,result:decode(row.result_json)}));}
  batch(id,position,status,{reportId,applicationId,result,error}={}){if(result){const prior=this.batches(id).find(b=>b.position===position)?.result?.socialMaintenance;if(prior&&!result.socialMaintenance)result={...result,socialMaintenance:prior};}this.db.prepare('INSERT INTO nightly_batches VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id,position) DO UPDATE SET status=excluded.status,report_id=COALESCE(excluded.report_id,report_id),application_id=COALESCE(excluded.application_id,application_id),result_json=COALESCE(excluded.result_json,result_json),error=excluded.error,updated_at=excluded.updated_at').run(id,position,status,reportId??null,applicationId??null,result==null?null:JSON.stringify(result),error??null,this.time());}
  beginCall(id,role){return this.journal.transaction(()=>{if(this.calls()>=this.config.dailyCallLimit){const error=new Error('今日夜间整理模型额度已用完');error.code='NIGHTLY_BUDGET';throw error;}const callId=crypto.randomUUID();this.db.prepare('INSERT INTO nightly_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET started_calls=started_calls+1').run(shanghaiDay(this.ms()));this.db.prepare("INSERT INTO nightly_calls VALUES(?,?,?,'started',NULL,NULL,?)").run(callId,id,role,this.time());return callId;});}
  endCall(id,result,error=null,diagnostics=null){const metadata=result||diagnostics?{usage:result?.usage??null,provider:result?.provider??null,model:result?.model??null,...diagnostics?{diagnostics}:{}}:null;this.db.prepare('UPDATE nightly_calls SET status=?,result_json=?,error=? WHERE id=?').run(error?'failed':'completed',metadata?JSON.stringify(metadata):null,error,id);}
  nextBudgetDay(){return (Math.floor((this.ms()+offset)/dayMs)+1)*dayMs-offset;}
}
