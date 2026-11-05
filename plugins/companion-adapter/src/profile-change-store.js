import {randomUUID} from 'node:crypto';
import {hash,noSecret} from './validation.js';
import {runtimeVersion} from './apply-runtime.js';
const parse=value=>value==null?null:JSON.parse(value);
export const rowHash=row=>hash(JSON.stringify(row??null));
/** Current-assertion relations. Original platform events remain historical evidence. */
export class ProfileChangeStore{
 constructor(journal,now=()=>new Date()){
  Object.assign(this,{journal,db:journal.db,now});this.db.exec(`
   CREATE TABLE IF NOT EXISTS profile_change_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS profile_change_jobs(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,source_json TEXT NOT NULL,status TEXT NOT NULL,proposal_json TEXT,application_id TEXT,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS profile_change_versions(id TEXT PRIMARY KEY,application_id TEXT NOT NULL,job_id TEXT NOT NULL,action TEXT NOT NULL,item_json TEXT NOT NULL,native_json TEXT NOT NULL,targets_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS profile_change_heads(family TEXT PRIMARY KEY,version_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS profile_change_undos(application_id TEXT PRIMARY KEY,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS profile_change_versions_application ON profile_change_versions(application_id);
  `);
  for(const r of this.db.prepare("SELECT id,source_json FROM profile_change_jobs WHERE status IN ('proposing','auditing','prepared') AND application_id IS NULL").all()){
   const source=parse(r.source_json),run=this.has('apply_runs')?this.db.prepare('SELECT id,plan_json FROM apply_runs WHERE selection_key=?').get(hash('profile-change:'+source.hash)):null;
   this.state(r.id,run?.plan_json?'prepared':'interrupted',{applicationId:run?.id,reason:run?.plan_json?'从固定计划核对，不重放模型':'上次提案或审核被中断，不自动重放旧原话'});
  }
 }
 time(){return this.now().toISOString();}
 has(table){return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table));}
 bootstrap(){for(const [key,table]of [['qq-cutoff','qq_inbox'],['bili-cutoff','bili_inbox_events'],['qq-social-cutoff','platform_events']])if(this.has(table))this.db.prepare('INSERT OR IGNORE INTO profile_change_meta VALUES(?,?)').run(key,String(this.db.prepare(`SELECT coalesce(max(rowid),0) n FROM ${table}`).get().n));}
 cutoff(key){return Number(this.db.prepare('SELECT value FROM profile_change_meta WHERE key=?').get(key)?.value??0);}
 job(id){const r=this.db.prepare('SELECT * FROM profile_change_jobs WHERE id=? OR source_key=?').get(id,id);return r?{...r,source:parse(r.source_json),proposal:parse(r.proposal_json)}:null;}
 enqueue(source,status='pending',reason=''){const at=this.time();noSecret(JSON.stringify(source));this.db.prepare('INSERT OR IGNORE INTO profile_change_jobs VALUES(?,?,?, ?,NULL,NULL,?,?,?)').run(randomUUID(),source.key,JSON.stringify(source),status,reason,at,at);return this.job(source.key);}
 state(id,status,{proposal,applicationId,reason=''}={}){this.db.prepare('UPDATE profile_change_jobs SET status=?,proposal_json=coalesce(?,proposal_json),application_id=coalesce(?,application_id),reason=?,updated_at=? WHERE id=?').run(status,proposal?JSON.stringify(proposal):null,applicationId??null,reason,this.time(),id);}
 version(id){const r=this.db.prepare('SELECT * FROM profile_change_versions WHERE id=?').get(id);return r?{...r,item:parse(r.item_json),native:parse(r.native_json),targets:parse(r.targets_json)}:null;}
 head(family){return this.db.prepare('SELECT version_id FROM profile_change_heads WHERE family=?').get(family)?.version_id??null;}
 currentVersions(){return this.db.prepare('SELECT v.id FROM profile_change_versions v WHERE EXISTS(SELECT 1 FROM profile_change_heads h WHERE h.version_id=v.id) ORDER BY v.rowid').all().map(r=>this.version(r.id)).filter(v=>this.head(v.item.family)===v.id);}
 familiesFor(targets){const families=new Set(targets.map(t=>t.family));for(const t of targets)if(t.id.startsWith('change:'))for(const r of this.db.prepare('SELECT family FROM profile_change_heads WHERE version_id=?').all(t.id.slice(7)))families.add(r.family);return [...families].sort();}
 inactive(item){const head=this.head(item.family);return Boolean(head&&item.id!=='change:'+head);}
 familyForSource(id){if(id.startsWith('change:'))return this.version(id.slice(7))?.item.family??id;if(!id.startsWith('qq:')||!this.has('qq_social_notes'))return id;let key=id.slice(3),seen=new Set();while(!seen.has(key)&&seen.size<64){seen.add(key);const row=this.db.prepare('SELECT previous_id FROM qq_social_notes WHERE id=?').get(key);if(!row?.previous_id)return 'qq:'+key;key=row.previous_id;}return id;}
 nativeOwner(store,id){return this.db.prepare('SELECT id FROM profile_change_versions WHERE json_extract(native_json,\'$.storeId\')=? AND json_extract(native_json,\'$.nativeId\')=? ORDER BY rowid DESC LIMIT 1').get(store,id)?.id??null;}
 summary(family){return this.has('profile_summary_state')?this.db.prepare('SELECT * FROM profile_summary_state WHERE family=?').get(family)??null:null;}
 pending(){return this.db.prepare("SELECT id FROM profile_change_jobs WHERE status IN ('pending','prepared','partial','backup_blocked') ORDER BY rowid LIMIT 1").get()?.id??null;}
 recent(limit=8){return this.db.prepare("SELECT * FROM profile_change_jobs WHERE status NOT IN ('ignored') ORDER BY rowid DESC LIMIT ?").all(limit).map(r=>({id:r.id,status:r.status,applicationId:r.application_id,reason:r.reason,at:r.updated_at,...r.proposal_json?{changes:parse(r.proposal_json).changes?.map(c=>({action:c.action,statement:c.statement??null,reason:c.reason,old:c.targets.map(t=>t.content)}))}:{}}));}
 before(families){return {heads:families.map(family=>({family,version:this.head(family)})),summaries:families.map(family=>({family,row:this.summary(family)}))};}
 checkBefore(before){for(const r of before.heads)if(this.head(r.family)!==r.version)throw Error('画像已有更晚的更正，未覆盖');for(const r of before.summaries)if(rowHash(this.summary(r.family))!==rowHash(r.row))throw Error('常驻画像维护关联已有后续变化，未覆盖');}
 buildItem(change,source,native){const item={status:change.action==='retract'?'retracted':'active',id:'change:'+change.id,family:change.family??change.targets[0].family,content:change.action==='retract'?change.targets[0].content:change.statement,evidenceQuote:change.quote,sourceText:source.text,rule:{kind:change.targets[0].rule.kind,scope:change.scope??'person',disclosure:'source'},origin:{platform:source.channel,scene:source.scene,audience:source.audience??'private'},overlayFor:change.overlayFor??[],at:source.occurredAt,sourceAt:source.occurredAt,sourceKey:source.key,alreadyCore:false,nativeRef:{storeId:native.storeId,recordId:native.nativeId,contentHash:native.contentHash}};item.fingerprint=hash(JSON.stringify([item.id,item.content,item.rule,source.hash,native]));return item;}
 async apply(operation,run,applications,runtime,signal){
  const step=applications.steps(run.id).find(s=>s.operation.kind==='profile_transition');if(step?.receipt?.verified){if(!this.current(step.receipt))throw Error('画像更正已被后续版本替代');return step.receipt;}
  const snapshot=await runtime.snapshot(signal),steps=applications.steps(run.id),entries=operation.changes.map(c=>{const n=steps.find(s=>s.operation.profileVersion===c.id&&s.operation.kind==='native_add');if(!n||n.status!=='applied'||!n.receipt?.verified)throw Error('缺少已核验的新原话长期记录');return {change:c,native:{storeId:n.receipt.storeId,nativeId:n.receipt.nativeId,contentHash:hash(n.operation.content)}};});
  return this.journal.transaction(()=>{
   this.checkBefore(operation.before);const summariesBefore=operation.before.summaries,at=this.time();
   for(const {change,native}of entries){const item=this.buildItem(change,operation.source,native);this.db.prepare('INSERT INTO profile_change_versions VALUES(?,?,?,?,?,?,?,?)').run(change.id,run.id,operation.jobId,change.action,JSON.stringify(item),JSON.stringify(native),JSON.stringify(change.targets),at);
    for(const family of change.families)this.db.prepare('INSERT INTO profile_change_heads VALUES(?,?) ON CONFLICT(family) DO UPDATE SET version_id=excluded.version_id').run(family,change.id);
    const projection=steps.find(s=>s.operation.projectionFor===change.id&&s.operation.kind==='runtime_replace'),row=projection?snapshot.entries.find(r=>r.target==='user'&&r.content===projection.operation.content):null;
    if(projection&&(!row||projection.receipt?.entryVersion!==runtimeVersion(row)))throw Error('常驻新值后来已经改变，未接管或覆盖');
    for(const family of change.families){const existing=this.summary(family);if(existing)this.db.prepare("UPDATE profile_summary_state SET status='superseded',reason=?,updated_at=? WHERE family=?").run('已由主用户新的更正原话替代；原版本在更正记录中保留',at,family);}
    if(projection&&row&&projection.receipt?.entryVersion===runtimeVersion(row)&&projection.receipt.reconciled===false){this.db.prepare(`INSERT INTO profile_summary_state VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(family) DO UPDATE SET source_id=excluded.source_id,fingerprint=excluded.fingerprint,source_json=excluded.source_json,status=excluded.status,content=excluded.content,runtime_version=excluded.runtime_version,application_id=excluded.application_id,reason=excluded.reason,updated_at=excluded.updated_at`).run(item.family,item.id,item.fingerprint,JSON.stringify(item),'managed',row.content,runtimeVersion(row),run.id,'已按审核通过的更正同步常驻摘要',at);}
   }
   const touched=operation.before.heads.map(r=>r.family),receipt={verified:true,applicationId:run.id,versions:entries.map(e=>e.change.id),before:operation.before,afterHeads:touched.map(family=>({family,version:this.head(family)})),afterSummaries:summariesBefore.map(r=>({family:r.family,hash:rowHash(this.summary(r.family))}))};
   applications.step(step.id,'applied',receipt);this.state(operation.jobId,'completed',{applicationId:run.id,reason:'更正已审核并按当前版本提交，原始历史保留'});return receipt;
  });
 }
 current(receipt){return receipt.afterHeads.every(r=>this.head(r.family)===r.version)&&receipt.afterSummaries.every(r=>rowHash(this.summary(r.family))===r.hash);}
 undoCheck(receipt){const prior=this.db.prepare('SELECT receipt_json FROM profile_change_undos WHERE application_id=?').get(receipt.applicationId);return prior?this.current(parse(prior.receipt_json)):this.current(receipt);}
 async undo(receipt,runtime,signal){
  const prior=this.db.prepare('SELECT receipt_json FROM profile_change_undos WHERE application_id=?').get(receipt.applicationId);if(prior){if(!this.current(parse(prior.receipt_json)))throw Error('已恢复的画像又有新变化');return {verified:true,reconciled:true};}
  const entries=(await runtime.snapshot(signal)).entries;return this.journal.transaction(()=>{
   if(!this.current(receipt))throw Error('画像或摘要已有后续版本，未覆盖');
   for(const r of receipt.before.heads){if(r.version)this.db.prepare('UPDATE profile_change_heads SET version_id=? WHERE family=?').run(r.version,r.family);else this.db.prepare('DELETE FROM profile_change_heads WHERE family=?').run(r.family);}
   for(const r of receipt.before.summaries){if(!r.row){this.db.prepare('DELETE FROM profile_summary_state WHERE family=?').run(r.family);continue;}const row={...r.row},current=entries.filter(e=>e.target==='user'&&e.content===row.content);if(row.status==='managed'&&current.length===1)row.runtime_version=runtimeVersion(current[0]);this.db.prepare('INSERT OR REPLACE INTO profile_summary_state VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.family,row.source_id,row.fingerprint,row.source_json,row.status,row.content,row.runtime_version,row.application_id,row.reason,row.updated_at);}
   const restored={...receipt,afterHeads:receipt.before.heads.map(r=>({family:r.family,version:this.head(r.family)})),afterSummaries:receipt.before.summaries.map(r=>({family:r.family,hash:rowHash(this.summary(r.family))}))};this.db.prepare('INSERT INTO profile_change_undos VALUES(?,?,?)').run(receipt.applicationId,JSON.stringify(restored),this.time());this.db.prepare("UPDATE profile_change_jobs SET status='undone',reason='该更正批次已明确撤销，同一原话不会自动重放',updated_at=? WHERE application_id=?").run(this.time(),receipt.applicationId);return {verified:true};
  });
 }
}
