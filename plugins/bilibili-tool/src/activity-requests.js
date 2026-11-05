import {randomUUID} from 'node:crypto';
import {hash,noSecret} from './util.js';
import {requiresAccountUploadLookup,accountUploadHelp} from './activity-config.js';

const terminal=new Set(['completed','failed','cancelled','dismissed']);
const decode=row=>row?{...row,source:JSON.parse(row.source_json),request:JSON.parse(row.request_json),result:row.result_json?JSON.parse(row.result_json):null}:null;

/** Durable owner-requested work. It owns no persona, memory bank or recipient override. */
export class ActivityRequests {
  constructor(adapter,{now=()=>new Date()}={}){
    Object.assign(this,{adapter,now});this.db=adapter.journal.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS activity_requests(
      id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,source_json TEXT NOT NULL,source_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,status TEXT NOT NULL,intent_id TEXT,run_id TEXT,result_json TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_requests_status ON activity_requests(status);`);
    this.db.prepare("UPDATE activity_requests SET status='queued',updated_at=? WHERE status='running'").run(this.time());
  }
  time(){return this.now().toISOString();}
  get qq(){const host=this.adapter.host;return host?host()?.qq:this.adapter.qq;}
  get proactive(){const host=this.adapter.host;return host?host()?.proactive:this.adapter.proactive;}
  get(id){return decode(this.db.prepare('SELECT * FROM activity_requests WHERE id=?').get(id));}
  valid(row){
    if(!row||hash(JSON.stringify(row.source))!==row.source_hash)return false;
    const q=this.qq,b=q?.binding?q.store.binding(q.binding.id):null,s=row.source,input=q?.store.get(s.inboxId);
    return Boolean(q&&b?.active&&b.id===q.binding?.id&&b.id===s.bindingId&&b.session_id===s.sessionId&&input&&input.binding_id===b.id&&input.message_id===s.messageId&&input.event_seq===s.seq&&input.body===s.body&&input.body.includes(s.quote));
  }
  submit(source,request){
    if(!this.adapter.attention.enabled())throw new Error('后台阅读需要已启用的统一注意力');
    noSecret(JSON.stringify({source,request}));
    const key=hash(source.sessionId+':'+source.messageId),old=decode(this.db.prepare('SELECT * FROM activity_requests WHERE event_key=?').get(key));
    if(old){if(JSON.stringify(old.request)!==JSON.stringify(request))throw new Error('这条原消息已有不同的后台阅读请求，请先查看或取消');return this.receipt(old,true);}
    if(this.db.prepare("SELECT count(*) n FROM activity_requests WHERE status IN ('queued','running')").get().n>=20)throw new Error('后台阅读待办已满，原消息和当前任务仍保留');
    const id=randomUUID(),at=this.time(),raw=JSON.stringify(source);
    const row={id,source,source_hash:hash(raw)};if(!this.valid(row))throw new Error('后台阅读只能绑定本轮已核验QQ主用户原话');
    this.db.prepare("INSERT INTO activity_requests VALUES(?,?,?,?,?,'queued',NULL,NULL,NULL,?,?)").run(id,key,raw,hash(raw),JSON.stringify(request),at,at);
    this.collect();return this.receipt(this.get(id));
  }
  receipt(row,replayed=false){return {status:row.status==='queued'||row.status==='running'?'queued':row.status,requestId:row.id,activityId:row.run_id,replayed,background:true,summary:'阅读请求已持久保存，尚不代表已观看或保存记忆。本轮无需等待视频工具；同一角色会重新选择何时继续，并可在完成后通过原QQ绑定答复。',result:row.result};}
  state(id,status,result){this.db.prepare('UPDATE activity_requests SET status=?,result_json=coalesce(?,result_json),updated_at=? WHERE id=?').run(status,result?JSON.stringify(result):null,this.time(),id);}
  collect(){
    for(const row of this.db.prepare("SELECT * FROM activity_requests WHERE status IN ('queued','running') ORDER BY rowid LIMIT 20").all().map(decode)){
      if(!this.valid(row)){const reading=row.run_id?this.adapter.activities.readings?.get(row.run_id):null;if(reading&&!['completed','completed_with_gaps','stopped','cancelled','failed'].includes(reading.status))this.adapter.activities.readings.control(reading.id,'cancel','原主用户账号绑定或原消息已变化');this.state(row.id,'cancelled',{reason:'原账号绑定或原消息核验变化'});continue;}
      const intent=row.intent_id?this.adapter.attention.store.get(row.intent_id):null;
      if(intent&&['dismissed','cancelled'].includes(intent.status)){this.state(row.id,intent.status);continue;}
      if(intent?.status==='completed'&&terminal.has(row.status))continue;
      if(!intent){const next=this.adapter.attention.offer({key:'requested-browse:'+row.id,kind:'browse',scope:'owner',summary:'主用户待办阅读：'+row.source.quote.slice(0,400),payload:{requestId:row.id}});this.db.prepare('UPDATE activity_requests SET intent_id=? WHERE id=?').run(next.id,row.id);}
      // A stopped worker may have an interrupted run. Resumption reuses its ID and write receipts.
      else if(row.status==='queued'&&['failed','completed'].includes(intent.status))this.adapter.attention.store.patch(intent.id,'pending',{reconcile:true,result:{reason:'核对后台请求检查点后继续'}});
    }
  }
  readiness(intent){
    const row=this.get(intent.payload.requestId);if(!row||terminal.has(row.status))return null;
    const a=this.adapter.activities,run=row.run_id?a.store.get(row.run_id):null;
    if(run)return null;
    const budget=a.store.budget();
    if(budget.manual>=a.config.manualDailyLimit){const tomorrow=Date.parse(a.store.day()+'T00:00:00+08:00')+86400000;return {waiting:true,wake:{kind:'time',at:tomorrow},reason:'手动浏览额度暂用完，保留请求到下一资源窗口重新考虑'};}
    const last=a.store.last('manual'),due=last?Date.parse(last.created_at)+a.config.manualCooldownSeconds*1000:0;
    return due>this.now().valueOf()?{waiting:true,wake:{kind:'time',at:due},reason:'短时浏览间隔保护，原请求继续保留'}:null;
  }
  async execute(intent,signal){
    let row=this.get(intent.payload.requestId);if(!row||!this.valid(row)||row.status==='cancelled')return {status:'cancelled'};
    if(terminal.has(row.status))return {...row.result,requestId:row.id};
    if(requiresAccountUploadLookup(row.request,row.source.quote)){const result={status:'needs_input',requestId:row.id,summary:accountUploadHelp};this.state(row.id,'failed',result);return result;}
    const a=this.adapter.activities;
    try{await a.verifyDiscoveryBinding(row.request);}catch(error){const result={status:'needs_input',requestId:row.id,summary:a.safe(error)};this.state(row.id,'failed',result);return result;}
    if(row.run_id){const reading=a.readings?.get(row.run_id);if(reading){const result=await a.readings.execute(reading.id,signal);if(result.pending){this.state(row.id,'queued',result);return result;}this.state(row.id,result.status==='failed'?'failed':result.status==='cancelled'?'cancelled':'completed',result);return {...result,requestId:row.id};}}
    if(a.active){if(a.active.backgroundRequestId===row.id){a.resumeForAttention();return a.active.promise;}return this.wait(intent,'已有浏览任务，完成后重新考虑');}
    const ready=this.readiness(intent);if(ready?.waiting)return this.wait(intent,ready.reason,ready.wake);
    if(!row.run_id){const old=this.db.prepare("SELECT id FROM activity_runs WHERE json_extract(request_json,'$.backgroundRequestId')=? ORDER BY rowid DESC LIMIT 1").get(row.id);if(old){this.db.prepare('UPDATE activity_requests SET run_id=? WHERE id=?').run(old.id,row.id);row=this.get(row.id);}}
    const resume=row.run_id?a.store.get(row.run_id):null;
    if(resume&&!['paused','interrupted'].includes(resume.status)){const result={...resume.result,status:resume.status,activityId:resume.id,requestId:row.id};this.state(row.id,['cancelled'].includes(resume.status)?'cancelled':'completed',result);return result;}
    this.state(row.id,'running');
    let promise;
    try{promise=a.run(resume?.request??row.request,'manual',signal,{resume,backgroundRequestId:row.id,onStarted:runId=>this.db.prepare('UPDATE activity_requests SET run_id=? WHERE id=?').run(runId,row.id)});}
    catch(error){const result={status:'failed',requestId:row.id,summary:a.safe(error)};this.state(row.id,'failed',result);return result;}
    if(a.active)a.active.attentionId=intent.id;
    const result=await promise;
    if(result.status==='busy'){this.state(row.id,'queued');return this.wait(intent,'记忆或浏览资源忙，原请求保留');}
    if(result.pending&&result.reading){this.state(row.id,'queued',result);return {...result,requestId:row.id};}
    if(result.status==='interrupted'){this.state(row.id,'queued',result);return {pending:true};}
    const status=result.status==='cancelled'?'cancelled':result.status==='failed'?'failed':'completed';
    this.state(row.id,status,result);return {...result,requestId:row.id};
  }
  wait(intent,reason,wake={kind:'time',at:this.now().valueOf()+30000}){this.adapter.attention.store.patch(intent.id,'waiting',{wake,result:{reason,waitSource:'resource'}});return {pending:true};}
  publicationSource(intent,run){
    const row=this.get(intent.payload.requestId??run?.request.backgroundRequestId);if(!row||row.intent_id!==intent.id||!this.valid(row)||!['completed','failed'].includes(row.status)||!row.result)return null;
    run=row.run_id?this.adapter.activities.store.get(row.run_id):null;
    const reading=row.run_id?this.adapter.activities.readings?.get(row.run_id):null;
    const result=row.result,observation=result.status==='needs_input'?null:aObservation(this.adapter,run),text=observation?.payload.text??String(result.summary??result.status);
    const value={key:'requested-reading:'+row.id,kind:'requested_video_result',requestedReply:true,requestId:row.id,requestQuote:row.source.quote,learningAllowed:row.request.learn!==false,title:observation?.payload.title??'先前请求的视频阅读结果',text:reading?this.adapter.activities.readings.publicationText(reading):text.slice(0,12000),...reading?{readingId:reading.id,evidenceObservationIds:reading.passes.map(p=>p.observationId)}:{},scope:reading?this.adapter.activities.readings.result(reading).scope:observation?.payload.scope??'未完成视频观察，不得声称已经看过',status:result.status,summary:result.summary??null,...observation?{url:observation.payload.url,observationId:observation.id}:{},originIntentId:intent.id};
    noSecret(JSON.stringify(value));return value;
  }
  cancelSession(sessionId){
    let n=0;
    for(const row of this.db.prepare("SELECT * FROM activity_requests WHERE status IN ('queued','running','completed','failed')").all().map(decode))if(row.source.sessionId===sessionId){
      const item=this.proactive?.store.bySource('requested-reading:'+row.id);if(item&&['sent','unknown','sending'].includes(item.status))continue;
      const reading=row.run_id?this.adapter.activities.readings?.get(row.run_id):null;if(reading&&!['completed','completed_with_gaps','stopped','cancelled','failed'].includes(reading.status))this.adapter.activities.readings.control(reading.id,'cancel','主用户取消后台阅读');this.state(row.id,'cancelled',{reason:'主用户取消后台阅读及尚未发送结果'});if(row.intent_id&&!this.adapter.attention.store.terminal(row.intent_id))this.adapter.attention.store.patch(row.intent_id,'cancelled');
      if(item&&['candidate','prepared'].includes(item.status)){this.proactive.store.discard(item.id,'主用户取消后台阅读结果');this.proactive.store.state(item.id,'cancelled');if(item.intent_id&&!this.adapter.attention.store.terminal(item.intent_id))this.adapter.attention.store.patch(item.intent_id,'cancelled');}
      if(this.adapter.activities.active?.backgroundRequestId===row.id)this.adapter.activities.active.stop.abort(new Error('主用户取消后台阅读'));n++;
    }
    return n;
  }
  read(id){const row=this.get(id);if(!row)return {status:'not_found'};return this.receipt(row);}
  status(){return {counts:Object.fromEntries(this.db.prepare('SELECT status,count(*) n FROM activity_requests GROUP BY status').all().map(r=>[r.status,r.n])),recent:this.db.prepare('SELECT id,status,run_id,intent_id,created_at,updated_at FROM activity_requests ORDER BY rowid DESC LIMIT 10').all(),scope:'已核验主用户的后台阅读；结果另有原QQ出站回执，完成阅读不等于已经发送'};}
}
function aObservation(adapter,run){return run?.observation_id?adapter.activities.store.observation(run.observation_id):null;}
