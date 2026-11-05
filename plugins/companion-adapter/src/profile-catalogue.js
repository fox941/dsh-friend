import {profileRule,normalizeProfile} from '@ai-friend/qq-bridge/person-policy';
import {socialOriginal,socialScope,socialSourceHash} from '@ai-friend/qq-bridge/social-memory-store';
import {hash,noSecret} from './validation.js';
import {runtimeVersion} from './apply-runtime.js';

const retired=reason=>({status:'retired',reason});
const unavailable=()=>({status:'unavailable',reason:'来源暂未核实，保留已有摘要'});
/** Local identifiers are canonical references, never inferred from display names. */
export class ProfileCatalogue{
 constructor(adapter){this.a=adapter;}
 has(table){return Boolean(this.a.journal.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));}
 ids(){const a=this.a,db=a.journal.db,ids=[];
  if(a.qq?.binding&&this.has('qq_social_notes'))for(const r of db.prepare("SELECT id FROM qq_social_notes WHERE account=? AND subject=? AND status='active' AND kind IN ('preference','interest') ORDER BY rowid DESC LIMIT 200").all(a.qq.binding.bot_qq,a.qq.binding.owner_qq))ids.push('qq:'+r.id);
  if(this.has('bili_social_memory_index'))for(const r of db.prepare("SELECT i.turn_id FROM bili_social_memory_index i JOIN bili_social_turns t ON t.id=i.turn_id WHERE json_extract(t.decision_json,'$.memory.profile') IS NOT NULL ORDER BY i.rowid DESC LIMIT 100").all())ids.push('bili:'+r.turn_id);
  if(this.has('apply_steps'))for(const r of db.prepare("SELECT s.id FROM apply_steps s JOIN apply_runs r ON r.id=s.run_id WHERE s.status='applied' AND json_extract(r.approval_json,'$.kind')='conversation' AND json_extract(r.frame_json,'$.proposals['||json_extract(s.operation_json,'$.proposalIndex')||'].request.profile') IS NOT NULL ORDER BY s.rowid DESC LIMIT 100").all())ids.push('owner:'+r.id);
  for(const v of a.profileChanges?.store.currentVersions()??[])if(v.action==='replace')ids.push('change:'+v.id);
  return [...new Set(ids)];
 }
 item(id,{family=id,content,quote,source,rule,origin,at,version,alreadyCore=false,sourceAt=at,sourceKey=null,nativeRef=null,runtimeRef=null}){
  const out={status:'active',id,family,content,evidenceQuote:quote,sourceText:source,rule,origin,at,alreadyCore,sourceAt,sourceKey,nativeRef,runtimeRef};
  out.fingerprint=hash(JSON.stringify([id,family,content,quote,source,rule,origin,version]));noSecret(JSON.stringify(out));return out;
 }
 async resolve(id,signal,{strict=false,includeHistorical=false}={}){
  signal?.throwIfAborted();try{
   if(typeof id!=='string'||id.length>200)return retired('未知来源');
   let item;
   if(id.startsWith('change:'))item=await this.changed(id,signal,strict);
   else if(id.startsWith('runtime:'))item=await this.runtime(id,signal);
   else if(id.startsWith('qq:'))item=await this.qq(id,signal,strict);
   else if(id.startsWith('bili:'))item=await this.bili(id,signal,strict);
   else if(id.startsWith('owner:'))item=await this.owner(id,signal);
   else return retired('未知来源');
   if(!includeHistorical&&item.status==='active'&&this.a.profileChanges?.store.inactive(item))return retired('已被主用户较新的更正或撤回替代，原始历史保留');return item;
  }catch{signal?.throwIfAborted();return unavailable();}
 }
 async qq(id,signal,strict){
  const a=this.a,m=a.platforms?.socialMemory,q=a.qq?.binding;if(!m||!q)return unavailable();
  const n=m.store.note(id.slice(3));if(!n)return retired('原条目已移除');
  if(n.account!==q.bot_qq||n.subject!==q.owner_qq)return retired('不属于当前已绑定主用户');
  if(n.status!=='active')return retired('原条目已更正、关闭或撤回');
  const e=m.readEvent(n.event_id);if(!e||!m.live(e,{processed:true}))return retired('原始事件不再有效');
  const source=socialOriginal(e),job=m.store.job(n.event_id),p=job?.proposals[n.proposal_index],review=job?.review_json?JSON.parse(job.review_json):null;
  if(!source||job?.status!=='completed'||job.source_hash!==socialSourceHash(e)||!review?.approved?.includes(n.proposal_index)||!p||p.content!==n.content||p.evidenceQuote!==n.evidence||!source.includes(n.evidence))return retired('原审核或原话不匹配');
  const rule=profileRule({profile:p.profile,source,quote:n.evidence,kind:n.kind});if(!rule)return retired('没有画像类型');
  let root=n,seen=new Set([n.id]);while(root.previous_id){if(seen.size>64||seen.has(root.previous_id))return unavailable();seen.add(root.previous_id);const old=m.store.note(root.previous_id);if(!old||old.account!==n.account||old.subject!==n.subject||old.thread_key!==n.thread_key)return unavailable();root=old;}
  if(strict&&!await m.validateSource(e,signal,new Map()))return retired('已确认来源内容或可见范围改变');
  const s=socialScope(e),origin={platform:'qq',scene:rule.scope==='scene'&&e.kind==='qzone_comment'?e.thread_key:s.thread,audience:e.kind==='friend'?'private':e.kind==='group'?'group':e.raw.postVisibility===1?'public':e.raw.postVisibility===4?'friends':'self'};
  return this.item(id,{family:'qq:'+root.id,content:n.content,quote:n.evidence,source,rule,origin,at:n.created_at,sourceAt:e.created_at,sourceKey:'qq-social:'+e.id,version:[n.content_hash,job.proposals_hash,n.event_id,e.raw_hash]});
 }
 async bili(id,signal,strict){
  const a=this.a,b=a.bilibiliSocial;if(!b||!this.has('bili_social_memory_index'))return unavailable();
  const n=a.journal.db.prepare('SELECT * FROM bili_social_memory_index WHERE turn_id=?').get(id.slice(5));if(!n)return retired('原长期索引已移除');
  const turn=b.store.turn(n.turn_id),events=turn&&b.store.events(turn),last=events?.at(-1),d=turn?.decision?.memory;
  if(!last||last.sender!==b.config.ownerUid||String(last.payload.account)!==String(b.inbox.store.control().account_id))return retired('不属于当前已绑定主用户');
  if(events.some(e=>['withdrawn','cancelled'].includes(e.status)))return retired('原事件已撤回');
  b.store.source(turn.id);if(!d?.profile)return retired('未经类型审核的经历');
  const source=events.find(e=>e.sender===b.config.ownerUid&&e.payload.text.includes(d.evidenceQuote));if(!source)return retired('原话不匹配');
  const app=a.applications.store.get(n.application_id),rule=normalizeProfile(d.profile,source.payload.text,d.evidenceQuote);
  if(!app||a.protection?.withdrawnReport(app.reportId)||JSON.stringify(app.frame.profile)!==JSON.stringify(rule))return retired('原应用已撤回或元数据不匹配');
  if(strict){const row=await b.native.showReadOnly(n.store_id,n.native_id,signal);if(!row||hash(row.content)!==n.content_hash)return retired('原长期记录已更正或删除');}
  return this.item(id,{content:d.statement,quote:d.evidenceQuote,source:source.payload.text,rule,origin:{platform:'bilibili',scene:'bilibili:'+turn.thread_key,audience:turn.thread_key.startsWith('private:')?'private':'public'},at:n.created_at,sourceAt:source.occurred_at?new Date(source.occurred_at*1000).toISOString():n.created_at,sourceKey:'bili:'+source.id,nativeRef:{storeId:n.store_id,recordId:n.native_id,contentHash:n.content_hash},version:[n.application_id,n.content_hash,n.native_id]});
 }
 async owner(id,signal){
  const a=this.a;if(!a.applications)return unavailable();const r=a.journal.db.prepare('SELECT run_id FROM apply_steps WHERE id=?').get(id.slice(6));if(!r)return retired('原应用条目不存在');
  const run=a.applications.store.get(r.run_id),step=a.applications.store.steps(r.run_id).find(s=>s.id===id.slice(6)),op=step?.operation,p=run?.frame?.proposals?.find(p=>p.index===op?.proposalIndex)?.request,s=run?.frame?.sources?.find(s=>s.kind==='user_message'),q=a.qq?.binding;
  if(run?.approval?.kind!=='conversation'||step?.status!=='applied'||!p?.profile||!['user','long_term'].includes(p.target)||!s||s.principal!=='main-user'||!['qq','dsh-direct'].includes(s.channel))return retired('不是已审核的主用户画像');
  if(s.channel==='qq'&&(!q||s.qq?.botQQ!==q.bot_qq||s.qq?.senderQQ!==q.owner_qq))return retired('主用户绑定已变化');
  if(a.protection?.withdrawnReport(run.reportId)||!await a.applications.backend.current(step,signal))return retired('原事实已更正或撤回');
  const rule=normalizeProfile(p.profile,s.text,p.evidenceQuote);
  return this.item(id,{content:op.content,quote:p.evidenceQuote,source:s.text,rule,origin:{platform:s.channel,scene:s.channel==='qq'?'qq-private:'+q.bot_qq+':'+q.owner_qq:'owner-private',audience:'private'},at:s.occurredAt,sourceKey:'qq:'+s.messageId,nativeRef:p.target==='long_term'?{storeId:op.storeId??step.receipt.storeId,recordId:step.receipt.currentId??step.receipt.nativeId,contentHash:hash(op.content)}:null,runtimeRef:p.target==='user'?op.content:null,version:[run.id,step.id,step.receipt],alreadyCore:p.target==='user'});
 }
 async runtime(id,signal){const rows=(await this.a.applications.backend.runtime.snapshot(signal)).entries.filter(r=>r.target==='user'&&hash(r.content)===id.slice(8));if(rows.length!==1)return retired('常驻旧条目已变化或不唯一');const r=rows[0],rule=profileRule({source:r.content,quote:r.content,kind:'user'});return this.item(id,{content:r.content,quote:r.content,source:r.content,rule,origin:{platform:'owner',scene:'owner-private',audience:'private'},at:r.updated_at,version:runtimeVersion(r),alreadyCore:true,runtimeRef:r.content});}
 async changed(id,signal,strict){const changes=this.a.profileChanges,v=changes?.store.version(id.slice(7));if(!v||changes.store.head(v.item.family)!==v.id)return retired('这条更正已被后续版本替代或撤销');const source=changes.store.job(v.job_id)?.source;if(!source)return retired('更正来源缺失');await changes.verifySource(source,signal);if(strict){const n=await this.a.client.showReadOnly(v.native.storeId,v.native.nativeId,signal);if(!n||hash(n.content)!==v.native.contentHash)return retired('更正后的长期原件已经变化');}return v.item;}
}
