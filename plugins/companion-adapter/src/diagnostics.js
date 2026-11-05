import {createHash,randomUUID} from 'node:crypto';
import {noSecret} from './validation.js';
import {readDiagnostics} from './diagnostics-report.js';
import {diagnosticStreamOutcome} from './diagnostics-state.js';
import {initializeToolDiagnostics,captureToolEvent} from './diagnostics-tools.js';
const stages=new Set(['selection','expression','emotion','reflection','growth','memory','activity','goal','proactive','session_other']);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
export function diagnosticUsage(usage){
  if(!usage||typeof usage!=='object')return null;
  const input=count(usage.inputTokens),output=count(usage.outputTokens),cacheRead=count(usage.cacheReadTokens),cacheWrite=count(usage.cacheWriteTokens),reasoning=count(usage.reasoningTokens);
  const total=count(usage.totalTokens)??(input!==null&&output!==null?input+output+(cacheRead??0)+(cacheWrite??0):null);
  return {input,output,cacheRead,cacheWrite,reasoning,total};
}
function fingerprint(options){
  try{
    let size=0;const value=JSON.stringify({provider:options.provider,model:options.model,system:options.system,messages:options.messages,tools:options.tools,maxTokens:options.maxTokens,temperature:options.temperature,reasoningEffort:options.reasoningEffort},(_key,value)=>{size+=typeof value==='string'?value.length:12;if(size>131072)throw new Error('too large');return value;});
    return createHash('sha256').update(value).digest('hex');
  }catch{return null;}
}
const safe=value=>{const result=String(value??'').slice(0,350);try{noSecret(result);return result;}catch{return '[敏感内容省略]';}};
export class Diagnostics {
  constructor({journal,now=()=>new Date(),monotonic=()=>performance.now(),config={}}){
    const retentionDays=config.retentionDays??30,maxRows=config.maxRows??20000;
    if(config.enabled!==undefined&&typeof config.enabled!=='boolean'||!Number.isInteger(retentionDays)||retentionDays<7||retentionDays>90||!Number.isInteger(maxRows)||maxRows<1000||maxRows>100000)throw new Error('诊断配置无效');
    Object.assign(this,{journal,db:journal.db,now,monotonic});this.enabled=config.enabled??true;this.retentionDays=retentionDays;this.maxRows=maxRows;this.errors=0;this.closed=false;this.activeStreams=new Map();this.toolLinks=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS diagnostic_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,started_at INTEGER NOT NULL,retention_days INTEGER NOT NULL,last_cleanup INTEGER NOT NULL,max_rows INTEGER NOT NULL,pruned_before INTEGER);
      CREATE TABLE IF NOT EXISTS diagnostic_model_calls(id TEXT PRIMARY KEY,stage TEXT NOT NULL,session_id TEXT,provider TEXT NOT NULL,model TEXT NOT NULL,intent_ids TEXT NOT NULL,fingerprint TEXT,status TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,duration_ms INTEGER,input_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,total_tokens INTEGER,error_kind TEXT);
      CREATE INDEX IF NOT EXISTS diagnostic_calls_time ON diagnostic_model_calls(started_at);
      CREATE INDEX IF NOT EXISTS diagnostic_calls_fingerprint ON diagnostic_model_calls(fingerprint,started_at);
      CREATE TABLE IF NOT EXISTS diagnostic_intent_events(id INTEGER PRIMARY KEY AUTOINCREMENT,intent_id TEXT NOT NULL,kind TEXT NOT NULL,from_state TEXT,to_state TEXT NOT NULL,wake_kind TEXT,wake_at INTEGER,reason TEXT,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS diagnostic_intent_time ON diagnostic_intent_events(intent_id,at);
      CREATE INDEX IF NOT EXISTS diagnostic_event_time ON diagnostic_intent_events(at);`);
    this.db.prepare('INSERT OR IGNORE INTO diagnostic_meta VALUES(1,1,?,?,0,?,NULL)').run(now().valueOf(),retentionDays,maxRows);
    if(this.db.prepare('SELECT version FROM diagnostic_meta').get().version!==1)throw new Error('诊断数据版本不支持');
    this.db.prepare('UPDATE diagnostic_meta SET retention_days=?,max_rows=? WHERE id=1').run(retentionDays,maxRows);
    this.db.prepare("UPDATE diagnostic_model_calls SET status='interrupted',finished_at=?,error_kind='process_restart' WHERE status='running'").run(now().valueOf());
    initializeToolDiagnostics(this.db,now().valueOf());
    this.cleanup();
  }
  attempt(fn){try{return fn();}catch{this.errors++;return null;}}
  transition(row,from,to,{wake=null,reason=null}={}){
    if(!this.enabled||this.closed)return;
    this.attempt(()=>this.db.prepare('INSERT INTO diagnostic_intent_events(intent_id,kind,from_state,to_state,wake_kind,wake_at,reason,at) VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.kind,from??null,to,wake?.kind??null,count(wake?.at),safe(reason),this.now().valueOf()));
  }
  sessionEvent(session,event){
    if(!this.enabled||this.closed)return;
    this.attempt(()=>{const sessionId=session.header.id,key=JSON.stringify([sessionId,event.data?.callId]),link=this.toolLinks.get(key),fresh=link&&link.name===event.data?.name&&this.now().valueOf()-link.at>=0&&this.now().valueOf()-link.at<=300000;captureToolEvent(this.db,sessionId,event,fresh?link.modelId:null);if(event.type==='tool/call')this.toolLinks.delete(key);});
  }
  observe(options,next,tag){
    if(!this.enabled||this.closed)return next();
    const self=this;
    return (async function*(){
      const id=randomUUID(),started=self.monotonic(),stage=stages.has(tag.stage)?tag.stage:'session_other';let usage=null,finish=null,errorKind=null,drained=false,finishCount=0,afterFinish=false,toolBlocks=0;self.activeStreams.set(id,{stage,startedAt:self.now().valueOf(),lastProgressAt:self.now().valueOf()});
      const saved=self.attempt(()=>self.db.prepare("INSERT INTO diagnostic_model_calls(id,stage,session_id,provider,model,intent_ids,fingerprint,status,started_at) VALUES(?,?,?,?,?,?,?,'running',?)").run(id,stage,typeof options.sessionId==='string'?safe(options.sessionId):null,safe(options.provider),safe(options.model),JSON.stringify(tag.intentIds??[]),fingerprint(options),self.now().valueOf()));
      try{
        for await(const chunk of next()){
          const live=self.activeStreams.get(id);if(live)live.lastProgressAt=self.now().valueOf();
          if(finishCount)afterFinish=true;
          if(chunk.type==='usage')usage=diagnosticUsage(chunk.usage);
          if(chunk.type==='block-end'&&chunk.block?.type==='tool-call'&&typeof chunk.block.id==='string'&&chunk.block.id&&typeof chunk.block.name==='string'&&chunk.block.name){toolBlocks++;if(saved&&typeof options.sessionId==='string'){const key=JSON.stringify([options.sessionId,chunk.block.id]);self.toolLinks.set(key,{modelId:id,name:chunk.block.name,at:self.now().valueOf()});while(self.toolLinks.size>256)self.toolLinks.delete(self.toolLinks.keys().next().value);}}
          if(chunk.type==='finish'){finish=chunk.reason?.kind??'unknown';finishCount++;}
          yield chunk;
        }
        drained=true;
      }catch(error){errorKind=options.signal?.aborted?'cancelled':'stream_error';throw error;}
      finally{
        self.activeStreams.delete(id);
        const outcome=diagnosticStreamOutcome({errorKind,aborted:options.signal?.aborted,drained,finish,finishCount,afterFinish,toolBlocks});
        if(saved)self.attempt(()=>self.db.prepare('UPDATE diagnostic_model_calls SET status=?,finished_at=?,duration_ms=?,input_tokens=?,cache_read_tokens=?,cache_write_tokens=?,output_tokens=?,reasoning_tokens=?,total_tokens=?,error_kind=? WHERE id=?').run(outcome.status,self.now().valueOf(),Math.max(0,Math.round(self.monotonic()-started)),usage?.input??null,usage?.cacheRead??null,usage?.cacheWrite??null,usage?.output??null,usage?.reasoning??null,usage?.total??null,outcome.errorKind===null?null:safe(outcome.errorKind),id));
      }
    })();
  }
  cleanup(){
    if(this.closed)return;
    return this.attempt(()=>{
      const now=this.now().valueOf(),meta=this.db.prepare('SELECT last_cleanup FROM diagnostic_meta').get();if(meta.last_cleanup&&now-meta.last_cleanup<86400000)return;
      this.journal.transaction(()=>{
        for(const table of ['diagnostic_model_calls','diagnostic_intent_events','diagnostic_tool_calls']){
          const time=table==='diagnostic_model_calls'?'started_at':table==='diagnostic_tool_calls'?'coalesce(finished_at,started_at)':'at';
          const pruned=this.db.prepare(`SELECT max(${time}) at FROM ${table} WHERE ${time}<? OR rowid IN (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT -1 OFFSET ?)`).get(now-this.retentionDays*86400000,this.maxRows).at;
          this.db.prepare(`DELETE FROM ${table} WHERE ${time}<?`).run(now-this.retentionDays*86400000);
          this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT -1 OFFSET ?)`).run(this.maxRows);
          if(pruned!==null)this.db.prepare('UPDATE diagnostic_meta SET pruned_before=max(coalesce(pruned_before,0),?) WHERE id=1').run(pruned);
        }
        this.db.prepare('UPDATE diagnostic_meta SET last_cleanup=? WHERE id=1').run(now);
      });
    });
  }
  read(options={}){return {...readDiagnostics(this.db,{...options,now:this.now().valueOf()}),collector:{enabled:this.enabled,writeErrors:this.errors}};}
  progress(){const now=this.now().valueOf();return {available:this.enabled&&!this.closed,active:[...this.activeStreams.values()].slice(0,8).map(r=>({...r,elapsedMs:Math.max(0,now-r.startedAt),idleMs:Math.max(0,now-r.lastProgressAt)})),partial:this.activeStreams.size>8,recentStreamFailures:this.enabled?this.db.prepare("SELECT count(*) n FROM diagnostic_model_calls WHERE started_at>=? AND error_kind='stream_error'").get(now-300000).n:0};}
  close(){this.closed=true;this.activeStreams.clear();this.toolLinks.clear();}
}
