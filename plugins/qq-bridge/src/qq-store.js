import {randomUUID} from 'node:crypto';
import {hash} from './validation.js';
import {QQ_SOURCE} from './source-identity.js';
const decode=row=>row?{...row,omissions:JSON.parse(row.omissions_json??'[]')}:null;
export class QQStore{
  constructor(journal,now=()=>new Date()){
    Object.assign(this,{journal,db:journal.db,now});
    journal.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS qq_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);INSERT OR IGNORE INTO qq_schema VALUES(1,1);
        CREATE TABLE IF NOT EXISTS qq_bindings(id TEXT PRIMARY KEY,owner_qq TEXT NOT NULL,bot_qq TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE,active INTEGER NOT NULL,at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS qq_inbox(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,platform_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL,body TEXT NOT NULL,body_hash TEXT NOT NULL,platform_time REAL,omissions_json TEXT NOT NULL,status TEXT NOT NULL,event_seq INTEGER,turn INTEGER,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(binding_id,platform_id));
        CREATE INDEX IF NOT EXISTS qq_inbox_pending ON qq_inbox(status);
        CREATE TABLE IF NOT EXISTS qq_outbox(id TEXT PRIMARY KEY,inbox_id TEXT NOT NULL,part INTEGER NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,platform_id TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(inbox_id,part));
        CREATE INDEX IF NOT EXISTS qq_outbox_pending ON qq_outbox(status);
        CREATE TABLE IF NOT EXISTS qq_budget(day TEXT PRIMARY KEY,accepted INTEGER NOT NULL);`);
      if(this.db.prepare('SELECT version FROM qq_schema').get().version!==1)throw new Error('不支持的QQ数据版本');
      this.db.prepare("UPDATE qq_outbox SET status='unknown',error='上次发送在回执确认前中断，未自动重发',updated_at=? WHERE status='sending'").run(this.time());
    });
  }
  time(){return this.now().toISOString();}
  day(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(this.now());}
  binding(id){return id?this.db.prepare('SELECT * FROM qq_bindings WHERE id=?').get(id):this.db.prepare('SELECT * FROM qq_bindings WHERE active=1').get();}
  bind(config){
    if(!config.configured)return null;
    return this.journal.transaction(()=>{
      const active=this.binding(),existing=this.binding(config.bindingId);
      if(active&&(active.id!==config.bindingId||active.owner_qq!==config.ownerQQ||active.bot_qq!==config.botQQ))throw new Error('QQ绑定发生变化；不能自动把现有角色交给另一账号');
      if(existing&&(existing.owner_qq!==config.ownerQQ||existing.bot_qq!==config.botQQ))throw new Error('QQ绑定标识与账号不匹配');
      const sessionId=`friend-qq-${hash(config.bindingId+':'+config.botQQ+':'+config.ownerQQ).slice(0,24)}`;
      this.db.prepare('INSERT OR IGNORE INTO qq_bindings VALUES(?,?,?,?,1,?)').run(config.bindingId,config.ownerQQ,config.botQQ,sessionId,this.time());return this.binding(config.bindingId);
    });
  }
  get(id){return decode(this.db.prepare('SELECT * FROM qq_inbox WHERE id=?').get(id));}
  byPlatform(bindingId,id){return decode(this.db.prepare('SELECT * FROM qq_inbox WHERE binding_id=? AND platform_id=?').get(bindingId,id));}
  accept(binding,message,limits,onAccepted){
    return this.journal.transaction(()=>{
      const old=this.byPlatform(binding.id,message.platformId);if(old)return {duplicate:true,row:old};
      const stop=message.body.trim()==='/stop';
      if(!stop&&this.db.prepare("SELECT count(*) n FROM qq_inbox WHERE status IN ('received','dispatching','queued','processing','attention_waiting')").get().n>=limits.maxPending)throw new Error('QQ待处理队列已满');
      if(!stop&&(this.db.prepare('SELECT accepted FROM qq_budget WHERE day=?').get(this.day())?.accepted??0)>=limits.dailyMessages)throw new Error('QQ今日对话额度已用完');
      if(!stop&&this.db.prepare('SELECT count(*) n FROM qq_inbox WHERE created_at>?').get(new Date(this.now().getTime()-60000).toISOString()).n>=limits.perMinute)throw new Error('QQ消息过于密集，暂缓接收');
      const id=randomUUID(),messageId=randomUUID(),at=this.time();
      this.db.prepare("INSERT INTO qq_inbox VALUES(?,?,?,?,?,?,?,?,?,'received',NULL,NULL,NULL,?,?)").run(id,binding.id,message.platformId,messageId,binding.session_id,message.body,hash(message.body),message.platformTime??null,JSON.stringify(message.omissions),at,at);
      if(!stop)this.db.prepare('INSERT INTO qq_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET accepted=accepted+1').run(this.day());const row=this.get(id);onAccepted?.(row);return {duplicate:false,row};
    });
  }
  archive(binding,message,onAccepted){return this.journal.transaction(()=>{const old=this.byPlatform(binding.id,message.platformId);if(old)return {duplicate:true,row:old};const id=randomUUID(),at=this.time();this.db.prepare("INSERT INTO qq_inbox VALUES(?,?,?,?,?,?,?,?,?,'recovered_history',NULL,NULL,NULL,?,?)").run(id,binding.id,message.platformId,randomUUID(),binding.session_id,message.body,hash(message.body),message.platformTime,JSON.stringify(message.omissions),at,at);const row=this.get(id);onAccepted?.(row);return {duplicate:false,row};});}
  recovery(row){if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_meta'").get())return null;const raw=this.db.prepare('SELECT value FROM platform_meta WHERE key=?').get('qq-recovered-owner:'+row.id);if(!raw)return null;const p=JSON.parse(raw.value);return p.platformId===row.platform_id&&p.bodyHash===row.body_hash&&p.bindingId===row.binding_id?p:null;}
  source(row){const binding=this.binding(row.binding_id);return {kind:'user',principal:{kind:QQ_SOURCE,inboxId:row.id,bindingId:binding.id,botQQ:binding.bot_qq,senderQQ:binding.owner_qq,platformMessageId:row.platform_id}};}
  trusted(event,header){
    const source=event.data?.source?.principal,row=this.get(source?.inboxId);if(!row||event.data.source.kind!=='user')return null;
    const binding=this.binding(row.binding_id),body=(event.data.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
    if(!binding||!Array.isArray(event.data.content)||event.data.content.length!==1||event.data.content[0].type!=='text')return null;
    const expected=this.source(row).principal;
    if(!binding?.active||header.id!==row.session_id||event.data.id!==row.message_id||body!==row.body||hash(body)!==row.body_hash||Object.keys(source).length!==Object.keys(expected).length||Object.keys(expected).some(key=>source[key]!==expected[key]))return null;
    return {channel:'qq',principal:'main-user',qq:{bindingId:binding.id,botQQ:binding.bot_qq,senderQQ:binding.owner_qq,platformMessageId:row.platform_id,inboxId:row.id,omittedKinds:row.omissions,...this.recovery(row)?{recovery:this.recovery(row)}:{}}};
  }
  state(id,status,error=null){this.db.prepare('UPDATE qq_inbox SET status=?,error=?,updated_at=? WHERE id=?').run(status,error,this.time(),id);}
  queued(id){this.db.prepare("UPDATE qq_inbox SET status='queued',updated_at=? WHERE id=? AND status IN ('received','dispatching')").run(this.time(),id);}
  claim(id,seq,turn){this.db.prepare("UPDATE qq_inbox SET status='processing',event_seq=?,turn=?,updated_at=? WHERE id=? AND status IN ('received','dispatching','queued','processing')").run(seq,turn,this.time(),id);}
  pending(){return this.db.prepare("SELECT * FROM qq_inbox WHERE status IN ('received','dispatching','queued','processing') ORDER BY rowid LIMIT 100").all().map(decode);}
  prepareReply(inboxId,parts){
    return this.journal.transaction(()=>{
      const row=this.get(inboxId);if(!row||['replied','cancelled'].includes(row.status))return;
      parts.forEach((body,part)=>this.db.prepare("INSERT OR IGNORE INTO qq_outbox VALUES(?,?,?,?,'pending',NULL,NULL,?,?)").run(randomUUID(),inboxId,part,body,this.time(),this.time()));
      this.state(inboxId,'completed');
    });
  }
  outbox(){return this.db.prepare("SELECT o.*,i.binding_id FROM qq_outbox o JOIN qq_inbox i ON i.id=o.inbox_id WHERE o.status='pending' AND NOT EXISTS(SELECT 1 FROM qq_outbox p WHERE p.inbox_id=o.inbox_id AND p.part<o.part AND p.status!='sent') ORDER BY o.rowid LIMIT 100").all();}
  sendState(id,status,{platformId=null,error=null}={}){this.db.prepare('UPDATE qq_outbox SET status=?,platform_id=COALESCE(?,platform_id),error=?,updated_at=? WHERE id=?').run(status,platformId,error,this.time(),id);if(status==='sent')this.db.prepare("UPDATE qq_inbox SET status='replied',updated_at=? WHERE id=(SELECT inbox_id FROM qq_outbox WHERE id=?) AND NOT EXISTS(SELECT 1 FROM qq_outbox WHERE inbox_id=(SELECT inbox_id FROM qq_outbox WHERE id=?) AND status!='sent')").run(this.time(),id,id);}
  summary(){const counts=table=>Object.fromEntries(this.db.prepare(`SELECT status,count(*) n FROM ${table} GROUP BY status`).all().map(x=>[x.status,x.n]));return {inbox:counts('qq_inbox'),outbox:counts('qq_outbox'),acceptedToday:this.db.prepare('SELECT accepted FROM qq_budget WHERE day=?').get(this.day())?.accepted??0};}
}
