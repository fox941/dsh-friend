import {randomUUID} from 'node:crypto';
import {text,noSecret} from './validation.js';
const terminal=new Set(['delivered','delivered_after_cancel','silent','superseded','cancelled','expired','superseded_partial','cancelled_partial','expired_partial','interrupted','unknown']);
const words=event=>(event?.data?.message?.content??[]).filter(row=>row.type==='text'&&typeof row.text==='string').map(row=>row.text).join('\n');
export class QQReplies{
  constructor(journal,{now=()=>new Date(),maxDeferSeconds=300,deferTtlSeconds=60}={}){
    Object.assign(this,{journal,db:journal.db,now,maxDeferSeconds,deferTtlSeconds});
    this.db.exec(`CREATE TABLE IF NOT EXISTS qq_reply_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);INSERT OR IGNORE INTO qq_reply_schema VALUES(1,1);
      CREATE TABLE IF NOT EXISTS qq_reply_plans(inbox_id TEXT PRIMARY KEY,action TEXT NOT NULL,category TEXT NOT NULL,reason TEXT NOT NULL,delay_seconds INTEGER NOT NULL,status TEXT NOT NULL,due_at INTEGER,expires_at INTEGER,source_seq INTEGER,source_turn INTEGER,final_seq INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS qq_reply_due ON qq_reply_plans(status,due_at);
      CREATE TABLE IF NOT EXISTS qq_reply_events(id INTEGER PRIMARY KEY AUTOINCREMENT,inbox_id TEXT NOT NULL,previous_status TEXT,status TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL);`);
    if(this.db.prepare('SELECT version FROM qq_reply_schema').get().version!==1)throw new Error('不支持的QQ回应数据版本');
    for(const row of this.db.prepare("SELECT inbox_id FROM qq_reply_plans WHERE status IN ('planned','scheduled','ready') AND EXISTS(SELECT 1 FROM qq_outbox WHERE qq_outbox.inbox_id=qq_reply_plans.inbox_id AND status='unknown')").all())this.outcome(row.inbox_id);
  }
  time(){return this.now().toISOString();}
  plan(id){return this.db.prepare('SELECT * FROM qq_reply_plans WHERE inbox_id=?').get(id)??null;}
  row(id){return this.db.prepare('SELECT rowid AS admission_order,* FROM qq_inbox WHERE id=?').get(id);}
  newer(row){return Boolean(this.db.prepare('SELECT 1 FROM qq_inbox WHERE binding_id=? AND rowid>? LIMIT 1').get(row.binding_id,row.admission_order));}
  audit(id,before,status,reason){this.db.prepare('INSERT INTO qq_reply_events(inbox_id,previous_status,status,reason,at) VALUES(?,?,?,?,?)').run(id,before??null,status,reason,this.time());}
  transition(id,status,reason){const old=this.plan(id);if(!old||old.status===status)return;this.db.prepare('UPDATE qq_reply_plans SET status=?,updated_at=? WHERE inbox_id=?').run(status,this.time(),id);this.audit(id,old.status,status,reason);}
  validate(args){
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['action','category','reason','delaySeconds'].includes(key)))throw new Error('回应意图包含未知字段');
    const {action,category}=args;
    if(!['reply','silent','defer'].includes(action)||!['question','task','ack','closing','other'].includes(category))throw new Error('回应意图或消息类型无效');
    const reason=text(args.reason,'回应判断理由',500);noSecret(reason);
    const delay=action==='defer'?(args.delaySeconds??60):0;
    if(action!=='defer'&&args.delaySeconds!==undefined||action==='defer'&&(!Number.isSafeInteger(delay)||delay<5||delay>this.maxDeferSeconds))throw new Error('延后需在5–300秒内，其他意图不接受延后参数');
    return {action,category,reason,delay};
  }
  propose(id,args){const value=this.validate(args);return this.journal.transaction(()=>{
    const row=this.row(id);if(!row||row.status!=='processing')throw new Error('只能为当前正在处理的原始QQ消息设置意图');
    const old=this.plan(id);if(old&&terminal.has(old.status))return {status:old.status,applied:false,summary:'该回应已结束或被后续消息取代，未恢复旧意图'};
    if(old&&old.action===value.action&&old.category===value.category&&old.reason===value.reason&&old.delay_seconds===value.delay)return {status:'planned',applied:true,replayed:true,...value};
    if(this.db.prepare("SELECT count(*) n FROM qq_reply_events WHERE inbox_id=? AND status='planned'").get(id).n>=3)throw new Error('同一消息最多三次回应意图设置');
    const at=this.time();this.db.prepare(`INSERT INTO qq_reply_plans VALUES(?,?,?,?,?,'planned',NULL,NULL,?,?,NULL,?,?) ON CONFLICT(inbox_id) DO UPDATE SET action=excluded.action,category=excluded.category,reason=excluded.reason,delay_seconds=excluded.delay_seconds,status='planned',updated_at=excluded.updated_at`).run(id,value.action,value.category,value.reason,value.delay,row.event_seq,row.turn,at,at);
    this.audit(id,old?.status,'planned',value.reason);
    if(value.action==='defer'&&this.newer(row)){this.transition(id,'superseded','已有更新的主用户消息，未安排旧答复');return {status:'superseded',applied:false};}
    return {status:'planned',applied:true,action:value.action,category:value.category,reason:value.reason,delaySeconds:value.delay,summary:value.action==='silent'?'本轮不发送QQ文字；沉默会正常留痕':value.action==='defer'?'本轮最终正文将持久排队，后续新消息可取代尚未发送的旧答复':'本轮按正常最终文字回复'};
  });}
  finish(id,{turnTime,finalSeq,parts}){return this.journal.transaction(()=>{
    const row=this.row(id);if(!row)return null;
    let plan=this.plan(id);const at=this.time();
    if(!plan){this.db.prepare("INSERT INTO qq_reply_plans VALUES(?,'reply','other','未提出其他意图，按默认正常回复',0,'planned',NULL,NULL,?,?,NULL,?,?)").run(id,row.event_seq,row.turn,at,at);this.audit(id,null,'planned','默认正常回复');plan=this.plan(id);}
    this.db.prepare('UPDATE qq_reply_plans SET final_seq=? WHERE inbox_id=?').run(finalSeq??null,id);
    const inboxState=status=>this.db.prepare('UPDATE qq_inbox SET status=?,updated_at=? WHERE id=?').run(status,at,id);
    if(terminal.has(plan.status)){inboxState(plan.status);return {status:plan.status};}
    if(plan.action==='silent'){this.transition(id,'silent','本轮选择保持沉默，不出站');inboxState('silent');return {status:'silent'};}
    if(!parts.length)throw new Error('没有可发送的最终正文，未将缺失回答当作沉默');
    if(plan.action==='defer'&&this.newer(row)){this.transition(id,'superseded','完成前已有更新消息，未发送过时答复');inboxState('superseded');return {status:'superseded'};}
    const due=plan.action==='defer'?new Date(turnTime).valueOf()+plan.delay_seconds*1000:null,expires=due===null?null:due+this.deferTtlSeconds*1000;
    if(due!==null&&!Number.isFinite(due))throw new Error('回应截止时间无法核验');
    this.db.prepare('UPDATE qq_reply_plans SET due_at=?,expires_at=? WHERE inbox_id=?').run(due,expires,id);
    if(expires!==null&&this.now().valueOf()>expires){this.transition(id,'expired','恢复时已超过待发有效期，未发送旧草稿');inboxState('expired');return {status:'expired'};}
    parts.forEach((body,part)=>{noSecret(body);this.db.prepare("INSERT OR IGNORE INTO qq_outbox VALUES(?,?,?,?,'pending',NULL,NULL,?,?)").run(randomUUID(),id,part,body,at,at);});
    this.transition(id,plan.action==='defer'?'scheduled':'ready',plan.action==='defer'?'最终正文已保存，等待到期并检查新消息':'最终正文已保存，准备发送');inboxState(plan.action==='defer'?'deferred':'completed');return {status:plan.action==='defer'?'scheduled':'ready',dueAt:due};
  });}
  cancel(bindingId,reason,{beforeId,all=false,status='cancelled'}={}){return this.journal.transaction(()=>{
    const before=beforeId?this.row(beforeId):null;
    const plans=this.db.prepare("SELECT p.*,i.binding_id,i.rowid AS admission_order FROM qq_reply_plans p JOIN qq_inbox i ON i.id=p.inbox_id WHERE i.binding_id=? AND p.status IN ('planned','scheduled','ready')").all(bindingId);let count=0;
    for(const plan of plans){if(!all&&plan.action!=='defer'||before&&plan.admission_order>=before.admission_order)continue;
      const started=this.db.prepare("SELECT 1 FROM qq_outbox WHERE inbox_id=? AND status IN ('sending','sent','unknown') LIMIT 1").get(plan.inbox_id),next=started?status+'_partial':status;
      this.db.prepare("UPDATE qq_outbox SET status=?,error=?,updated_at=? WHERE inbox_id=? AND status='pending'").run(status,reason,this.time(),plan.inbox_id);this.transition(plan.inbox_id,next,reason);
      this.db.prepare("UPDATE qq_inbox SET status=?,error=?,updated_at=? WHERE id=? AND status IN ('deferred','completed')").run(next,reason,this.time(),plan.inbox_id);count++;
    }return count;
  });}
  settle(){const expired=this.db.prepare("SELECT p.inbox_id,i.binding_id FROM qq_reply_plans p JOIN qq_inbox i ON i.id=p.inbox_id WHERE p.status='scheduled' AND p.expires_at<?").all(this.now().valueOf());
    for(const {inbox_id:id} of expired)this.journal.transaction(()=>{this.db.prepare("UPDATE qq_outbox SET status='expired',error='待发答复已过期',updated_at=? WHERE inbox_id=? AND status='pending'").run(this.time(),id);const partial=this.db.prepare("SELECT 1 FROM qq_outbox WHERE inbox_id=? AND status IN ('sending','sent','unknown') LIMIT 1").get(id);this.transition(id,partial?'expired_partial':'expired','待发有效期已过，未自动补发');this.db.prepare("UPDATE qq_inbox SET status=?,updated_at=? WHERE id=? AND status='deferred'").run(partial?'expired_partial':'expired',this.time(),id);});
  }
  outbox(){this.settle();return this.db.prepare(`SELECT o.*,i.binding_id FROM qq_outbox o JOIN qq_inbox i ON i.id=o.inbox_id LEFT JOIN qq_reply_plans p ON p.inbox_id=i.id WHERE o.status='pending' AND (p.inbox_id IS NULL OR p.status IN ('ready','scheduled') AND (p.due_at IS NULL OR p.due_at<=?)) AND NOT EXISTS(SELECT 1 FROM qq_outbox earlier WHERE earlier.inbox_id=o.inbox_id AND earlier.part<o.part AND earlier.status!='sent') ORDER BY o.rowid LIMIT 100`).all(this.now().valueOf());}
  outcome(id){const plan=this.plan(id);if(!plan)return {delivered:false};const rows=this.db.prepare('SELECT status FROM qq_outbox WHERE inbox_id=? ORDER BY part').all(id);
    if(rows.length&&rows.every(row=>row.status==='sent')){const late=!['ready','scheduled','delivered'].includes(plan.status);this.transition(id,late?'delivered_after_cancel':'delivered',late?'发送请求已发出后收到取消/取代请求，实际发送回执已确认':'全部分段发送回执已确认');return {delivered:true};}
    if(rows.some(row=>row.status==='unknown'))this.transition(id,'unknown','发送结果不明，未自动重发');return {delivered:false};
  }
  assistantDelivered(event,header){const binding=this.db.prepare('SELECT id FROM qq_bindings WHERE session_id=?').get(header.id);if(!binding)return null;
    const plan=this.db.prepare('SELECT i.id FROM qq_inbox i LEFT JOIN qq_reply_plans p ON p.inbox_id=i.id WHERE i.session_id=? AND (p.final_seq=? OR p.inbox_id IS NULL AND i.turn=?) ORDER BY i.rowid DESC LIMIT 1').get(header.id,event.seq,event.data?.turn??null);if(!plan)return false;
    const rows=this.db.prepare('SELECT body,status FROM qq_outbox WHERE inbox_id=? ORDER BY part').all(plan.id);return Boolean(rows.length&&rows.every(row=>row.status==='sent')&&rows.map(row=>row.body).join('')===words(event));
  }
  publicationPending(event,header){const row=this.db.prepare('SELECT i.id,i.status,p.status AS plan_status FROM qq_inbox i LEFT JOIN qq_reply_plans p ON p.inbox_id=i.id WHERE i.session_id=? AND i.turn=? ORDER BY i.rowid DESC LIMIT 1').get(header.id,event.data?.turn??null);if(!row)return false;if(row.plan_status&&terminal.has(row.plan_status))return false;const parts=this.db.prepare('SELECT status FROM qq_outbox WHERE inbox_id=?').all(row.id);return !parts.some(part=>part.status==='unknown')&&(['planned','ready','scheduled'].includes(row.plan_status)||parts.some(part=>['pending','sending'].includes(part.status)));}
  summary(){return {policy:'普通回复直接生成正文；可明确选择沉默或5–300秒延后；新消息取代未发送的旧延后答复',recent:this.db.prepare('SELECT inbox_id,action,category,reason,status,due_at,expires_at,created_at,updated_at FROM qq_reply_plans ORDER BY rowid DESC LIMIT 5').all(),counts:Object.fromEntries(this.db.prepare('SELECT status,count(*) n FROM qq_reply_plans GROUP BY status').all().map(row=>[row.status,row.n]))};}
}
