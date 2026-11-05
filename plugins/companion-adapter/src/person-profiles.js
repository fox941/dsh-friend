import {normalizeProfile,profileRule,PROFILE_GUIDANCE} from '@ai-friend/qq-bridge/person-policy';
import {socialOriginal,socialScope} from '@ai-friend/qq-bridge/social-memory-store';
import {spacePrincipal} from '@ai-friend/qq-bridge/qzone-inbox';
import {socialPrincipal} from '@ai-friend/qq-bridge/social-principal';
import {conversationSource} from './conversation-memory.js';
import {eligibleHeader} from './preview-sessions.js';
import {hash,noSecret} from './validation.js';
const empty=()=>({schema:'ai-friend/person-profile/1',items:[],boundary:PROFILE_GUIDANCE});
/** A bounded read-through view. Original memory, corrections, undo and retention remain authoritative. */
export class PersonProfiles{
 constructor(adapter){this.adapter=adapter;}
 person(platform,id){const a=this.adapter,owner=platform==='qq'?a.qq?.binding?.owner_qq:a.bilibiliSocial?.config?.ownerUid;return id&&String(id)===String(owner)?'main-user:'+a.growth.read().identityId:platform+':'+id;}
 normalize(...args){return normalizeProfile(...args);}
 async forPrompt(agent,signal){
  const header=agent?.session?.header,a=this.adapter;
  if(!eligibleHeader(header,a.workspace)||agent.id!==header.id)return empty();
  const binding=a.qq?.binding,isQQ=binding?.session_id===agent.id&&binding.active!==false&&binding.active!==0;
  if(!isQQ&&/^(?:friend-qq-|friend-bili-|social:)/.test(agent.id))return empty();
  // Prompt assembly precedes admission of this turn's actual user message.
  // Authorize the read-only destination, never manufacture a source for a memory write.
  if(!isQQ){for(let i=agent.session.seq-1;i>=Math.max(0,agent.session.seq-160);i--){const e=agent.session.eventAt(i);if(e?.type==='user/message'&&e.data?.source?.kind==='user'){if(e.data.source.principal!=null)return empty();break;}}}
  return this.safeContext({person:'main-user:'+a.growth.read().identityId,platform:isQQ?'qq':'owner',id:isQQ?binding.owner_qq:null,scene:isQQ?'qq-private:'+binding.bot_qq+':'+binding.owner_qq:'owner-private',audience:'private',query:''},signal);
 }
 async safeContext(dest,parentSignal){try{return await this.context(dest,AbortSignal.any([parentSignal??new AbortController().signal,AbortSignal.timeout(12000)]));}catch{parentSignal?.throwIfAborted();return {...empty(),unavailable:true};}}
 async forQQ(event,signal){const a=this.adapter,q=a.qq,p=event.kind==='qzone_comment'?spacePrincipal(q,event):socialPrincipal(q,event);if(!p.verified)return empty();const scope=socialScope(event);return this.safeContext({person:this.person('qq',event.sender),platform:'qq',id:event.sender,scene:event.kind==='qzone_comment'?event.thread_key:scope.thread,legacyScene:scope.thread,audience:event.kind==='friend'?'private':event.kind==='group'?'group':event.raw.postVisibility===1?'public':event.raw.postVisibility===4?'friends':'self',query:event.body},signal);}
 async forOwner(agent,signal){const input=conversationSource(agent,this.adapter.workspace);return this.safeContext({person:'main-user:'+this.adapter.growth.read().identityId,platform:'owner',id:null,scene:input.source.channel==='qq'?'qq-private:'+this.adapter.qq.binding.bot_qq+':'+this.adapter.qq.binding.owner_qq:'owner-private',audience:'private',query:input.source.text},signal);}
 async forBilibili(turnId,signal){const a=this.adapter,s=a.bilibiliSocial,t=s?.store.turn(turnId);if(!t)return empty();const events=s.store.events(t),last=events.at(-1),account=s.inbox.store.control().account_id;if(!last||!account||String(last.payload.account)!==String(account)||events.some(e=>!e||e.status==='withdrawn'))return empty();return this.safeContext({person:this.person('bilibili',last.sender),platform:'bilibili',id:last.sender,scene:'bilibili:'+t.thread_key,audience:t.thread_key.startsWith('private:')?'private':'public',query:last.payload.text},signal);}
 allows(rule,origin,dest){
  if(rule.scope==='scene'&&origin.scene!==dest.scene)return false;
  if(origin.scene===dest.scene||rule.scope==='person'&&origin.scene===dest.legacyScene)return true;
  if(rule.scope!=='person')return false;
  if(rule.disclosure==='public'||origin.audience==='public')return true;
  return dest.audience==='private';
 }
 async context(dest,signal){
  const result=empty(),a=this.adapter,main=dest.person==='main-user:'+a.growth.read().identityId;
  if(!a.policy().enabled||!a.personProfiles||!['private','public','group','friends','self'].includes(dest.audience))return result;
  result.personId=dest.person;result.identityLinked=main;
  const candidates=[],typedContents=new Set(),sourceCache=new Map([['allow-historical',true]]);
  const memory=a.platforms?.socialMemory,q=a.qq?.binding,peer=main?q?.owner_qq:dest.platform==='qq'?dest.id:null;
  if(memory&&q&&peer){
   const rows=memory.store.db.prepare("SELECT id FROM qq_social_notes WHERE account=? AND subject=? AND status='active' AND kind IN ('preference','interest') ORDER BY rowid DESC LIMIT 48").all(q.bot_qq,peer);
   for(const row of rows){signal?.throwIfAborted();try{
    const n=memory.store.note(row.id),e=memory.readEvent(n.event_id);if(!memory.live(e,{processed:true})||e.sender!==peer)continue;
    const source=socialOriginal(e),job=memory.store.job(n.event_id),proposal=job?.proposals[n.proposal_index];
    if(!source||!proposal||!['completed'].includes(job.status)||!source.includes(n.evidence))continue;
    const rule=profileRule({profile:proposal.profile,source,quote:n.evidence,kind:n.kind}),scope=socialScope(e),origin={platform:'qq',scene:rule.scope==='scene'&&e.kind==='qzone_comment'?e.thread_key:scope.thread,audience:e.kind==='friend'?'private':e.kind==='group'?'group':e.raw.postVisibility===1?'public':e.raw.postVisibility===4?'friends':'self'};
    if(!rule||!this.allows(rule,origin,dest)||!await memory.validateSource(e,signal,sourceCache))continue;
    candidates.push({id:'qq-profile:'+n.id,kind:rule.kind,content:n.content,evidenceQuote:n.evidence,scope:rule.scope,origin,at:n.created_at,sourceVerification:sourceCache.get('source-status:'+e.id)??'ledger-current',readOnly:true});
   }catch{signal?.throwIfAborted();}}
  }
  const bs=a.bilibiliSocial,bpeer=main?bs?.config.ownerUid:dest.platform==='bilibili'?dest.id:null;
  if(bs&&bpeer&&a.journal.db.prepare("SELECT 1 FROM sqlite_master WHERE name='bili_social_memory_index'").get()){
   const rows=a.journal.db.prepare("SELECT i.* FROM bili_social_memory_index i JOIN bili_social_turns t ON t.id=i.turn_id WHERE json_extract(t.decision_json,'$.memory.profile') IS NOT NULL ORDER BY i.rowid DESC LIMIT 16").all();
   for(const n of rows){signal?.throwIfAborted();try{
    const turn=bs.store.turn(n.turn_id),events=bs.store.events(turn),last=events.at(-1),d=turn.decision?.memory;
    if(!last||last.sender!==bpeer||String(last.payload.account)!==String(bs.inbox.store.control().account_id)||!d?.profile)continue;
    const source=events.find(e=>e.sender===bpeer&&e.payload.text.includes(d.evidenceQuote));if(!source)continue;
    // Do not reconstruct a public fact from an unsent draft, withdrawn source, or stale Native index.
    bs.store.source(turn.id);
    const rule=normalizeProfile(d.profile,source.payload.text,d.evidenceQuote),origin={platform:'bilibili',scene:'bilibili:'+turn.thread_key,audience:turn.thread_key.startsWith('private:')?'private':'public'};
    if(!this.allows(rule,origin,dest))continue;
    const current=await bs.native.showReadOnly(n.store_id,n.native_id,signal);if(!current||hash(current.content)!==n.content_hash)continue;
    const app=a.applications.store.get(n.application_id);if(!app||a.protection?.withdrawnReport(app.reportId)||JSON.stringify(app.frame.profile)!==JSON.stringify(rule))continue;
    candidates.push({id:'bilibili-profile:'+turn.id,kind:rule.kind,content:d.statement,evidenceQuote:d.evidenceQuote,scope:rule.scope,origin,at:n.created_at,sourceVerification:'memory-current',readOnly:true});
   }catch{signal?.throwIfAborted();}}
  }
  // Private owner material is never read into a public frame merely because the account is bound.
  if(main){
   const db=a.journal.db,has=db.prepare("SELECT 1 FROM sqlite_master WHERE name='apply_steps'").get();
   if(has){const rows=db.prepare("SELECT s.id,s.run_id,s.position FROM apply_steps s JOIN apply_runs r ON r.id=s.run_id WHERE s.status='applied' AND json_extract(r.approval_json,'$.kind')='conversation' AND json_extract(s.operation_json,'$.kind') IN ('runtime_add','runtime_replace','native_add','native_correct') AND json_extract(r.frame_json,'$.proposals['||json_extract(s.operation_json,'$.proposalIndex')||'].request.profile') IS NOT NULL ORDER BY s.rowid DESC LIMIT 24").all();
    for(const row of rows){signal?.throwIfAborted();try{
     const run=a.applications.store.get(row.run_id),step=a.applications.store.steps(row.run_id).find(s=>s.id===row.id),op=step.operation,r=run.frame.proposals.find(p=>p.index===op.proposalIndex)?.request,source=run.frame.sources.find(s=>s.kind==='user_message');
     if(!r?.profile||!source||!['user','long_term'].includes(r.target)||source.principal!=='main-user'||!['dsh-direct','qq'].includes(source.channel))continue;
     typedContents.add(op.content);
     if(source.channel==='qq'&&(!q||source.qq?.botQQ!==q.bot_qq||source.qq?.senderQQ!==q.owner_qq))continue;
     const rule=normalizeProfile(r.profile,source.text,r.evidenceQuote),origin={platform:source.channel,scene:source.channel==='qq'&&q?'qq-private:'+q.bot_qq+':'+q.owner_qq:'owner-private',audience:'private'};
     if(!this.allows(rule,origin,dest)||a.protection?.withdrawnReport(run.reportId)||!await a.applications.backend.current(step,signal))continue;
     candidates.push({id:'owner-profile:'+step.id,kind:rule.kind,content:op.content,evidenceQuote:r.evidenceQuote,scope:rule.scope,origin,at:run.updatedAt,sourceVerification:'memory-current',readOnly:true});
    }catch{signal?.throwIfAborted();}}
   }
   if(dest.audience==='private'&&a.memoryReader){try{const read=await a.memoryReader.read([],signal);for(const n of read.items.filter(n=>n.kind==='runtime'&&n.target==='user')){
    if(typedContents.has(n.text)||candidates.some(c=>c.content===n.text)||a.profileSummary?.rows().some(r=>r.status==='managed'&&r.content===n.text)||a.profileChanges?.blocked('runtime:'+hash(n.text)))continue;
    const rule=profileRule({source:n.text,quote:n.text,kind:'user'}),origin={platform:'owner',scene:'owner-private',audience:'private'};
    if(rule.scope==='person'&&this.allows(rule,origin,dest))candidates.push({id:'owner-profile:'+n.id,kind:rule.kind,content:n.text,scope:rule.scope,origin,at:n.updatedAt??n.createdAt,sourceVerification:'memory-current',readOnly:true});
   }}catch{signal?.throwIfAborted();result.partial=true;}}
  }
  if(main&&a.profileChanges){
   const key=id=>id.startsWith('qq-profile:')?'qq:'+id.slice(11):id.startsWith('bilibili-profile:')?'bili:'+id.slice(17):id.startsWith('owner-profile:runtime:')?'runtime:'+id.split(':').at(-1):id.startsWith('owner-profile:')?'owner:'+id.slice(14):id;
   for(let i=candidates.length-1;i>=0;i--)if(a.profileChanges.blocked(key(candidates[i].id),dest))candidates.splice(i,1);
   candidates.push(...await a.profileChanges.context(dest,signal));
   const publicResults=a.profileNotices?.publications(dest)??[];if(publicResults.length)result.taskResults=publicResults;
   if(dest.audience==='private'){result.changes=a.profileChanges.notices();result.taskResults=a.profileNotices?.publications(dest)??[];}
  }
  candidates.sort((x,y)=>(x.scope==='scene'?0:1)-(y.scope==='scene'?0:1)||String(y.at??'').localeCompare(String(x.at??'')));
  let chars=0;const seen=new Set();for(const c of candidates){try{noSecret(JSON.stringify(c));}catch{continue;}const key=hash(c.content);if(seen.has(key))continue;let item=c;if(dest.audience!=='private'&&c.origin.scene!==dest.scene){item={...c,origin:{platform:c.origin.platform,audience:c.origin.audience}};if(c.origin.audience!=='public')delete item.evidenceQuote;}const size=JSON.stringify(item).length;if(result.items.length>=12||chars+size>6000){result.partial=true;continue;}seen.add(key);chars+=size;result.items.push(item);}
  result.coverage='bounded-source-view';return result;
 }
}
