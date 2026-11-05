import {randomUUID} from 'node:crypto';import {biliId} from './activity-config.js';import {text,uuid,noSecret,hash} from './util.js';
const open=new Set(['pending','paused']);
export function browsingPlan(value){
 if(value==null)return null;if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['action','reason','questions'].includes(k))||!['keep','pause','finish','drop'].includes(value.action))throw Error('浏览后续意图格式异常');
 const questions=value.questions??[];if(!Array.isArray(questions)||questions.length>3)throw Error('未解疑问最多三项');const out={action:value.action,reason:text(value.reason,'浏览意图理由',400),questions:[...new Set(questions.map(q=>text(q,'待探索疑问',240)))]};noSecret(JSON.stringify(out));return out;
}
/** Operational intentions only. Observation originals and long-term memories stay in their original stores. */
export class BrowsingStore{
 constructor(activity){this.activity=activity;this.db=activity.db;this.journal=activity.journal;this.db.exec(`CREATE TABLE IF NOT EXISTS activity_browsing_items(id TEXT PRIMARY KEY,video_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,updated_at TEXT NOT NULL,content_hash TEXT NOT NULL);CREATE INDEX IF NOT EXISTS activity_browsing_open ON activity_browsing_items(status,updated_at);`);}
 time(){return this.activity.time();}
 revisionKey(){const row=this.db.prepare('SELECT count(*) n,coalesce(sum(revision),0) r FROM activity_browsing_items').get();return row.n+':'+row.r;}
 decode(row){if(!row)return null;const item=JSON.parse(row.value_json);if(item.id!==row.id||item.status!==row.status||item.revision!==row.revision||item.bvid+':'+item.page!==row.video_key||hash(row.value_json)!==row.content_hash)throw Error('浏览意图状态校验失败');return item;}
 get(id){uuid(id);return this.decode(this.db.prepare('SELECT * FROM activity_browsing_items WHERE id=?').get(id));}
 byTarget(target){return this.decode(this.db.prepare('SELECT * FROM activity_browsing_items WHERE video_key=?').get(target.bvid+':'+target.page));}
 list({all=false,limit=8}={}){return this.db.prepare(`SELECT * FROM activity_browsing_items ${all?'':"WHERE status IN ('pending','paused')"} ORDER BY CASE WHEN status='pending' THEN 0 WHEN json_extract(value_json,'$.hold')='owner' THEN 2 ELSE 1 END,updated_at DESC,rowid DESC LIMIT ?`).all(Math.max(1,Math.min(50,limit))).map(r=>this.decode(r));}
 save(item){item.updatedAt=this.time();const raw=JSON.stringify(item);noSecret(raw);this.db.prepare('INSERT INTO activity_browsing_items VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,revision=excluded.revision,value_json=excluded.value_json,updated_at=excluded.updated_at,content_hash=excluded.content_hash').run(item.id,item.bvid+':'+item.page,item.status,item.revision,raw,item.updatedAt,hash(raw));return item;}
 capacity(){if(this.db.prepare("SELECT count(*) n FROM activity_browsing_items WHERE status IN ('pending','paused')").get().n>=50)throw Error('待看/续看事项已达50项，请先结束不再关注的事项');}
 queue(video,reason,questions,source){const target=biliId(video),plan=browsingPlan({action:'keep',reason,questions});return this.journal.transaction(()=>{const old=this.byTarget(target);if(old)return {status:'already_exists',item:old};this.capacity();const item={id:randomUUID(),...target,revision:1,status:'pending',hold:null,title:null,reason:plan.reason,questions:plan.questions,source,observationId:null,lastRunId:null,createdAt:this.time()};noSecret(JSON.stringify(item));return {status:'queued',item:this.save(item)};});}
 change(id,revision,action,reason,source){uuid(id);if(!Number.isSafeInteger(revision)||revision<1||!['pause','resume','finish','drop'].includes(action))throw Error('浏览意图操作或版本无效');text(reason,'调整理由',400);return this.journal.transaction(()=>{const current=this.get(id);if(!current||current.revision!==revision)throw Error('浏览意图版本已变化，请重新读取');if(action==='resume'&&!open.has(current.status))this.capacity();const status={pause:'paused',resume:'pending',finish:'finished',drop:'dropped'}[action],item={...current,status,hold:action==='pause'?'owner':null,revision:revision+1,reason,source};noSecret(JSON.stringify(item));return {status:'changed',item:this.save(item)};});}
 select(id,revision){const item=this.get(id);if(!item||item.revision!==revision||!open.has(item.status)||item.hold==='owner')throw Error('续看事项已变化、结束或被主用户暂停');return item;}
 context(){return {items:this.list().map(({source,createdAt,updatedAt,lastRunId,...item})=>item),scope:'这些是暂定浏览意图与未解疑问，不是新经历或事实；finished仅表示停止关注，不表示看完整片。主用户暂停项不能自动恢复；可以选续看、另找内容、暂缓或休息。'};}
 deferCandidates(runId,candidates,proposals){return this.journal.transaction(()=>{
  const run=this.activity.get(runId);if(!run)throw Error('待看候选缺少实际目录读取任务');if(run.decision?.deferredReceipt)return run.decision.deferredReceipt;
  let receipt;if(run.request.learn===false)receipt={status:'disabled_by_request'};else{
   const selected=proposals??[];if(!Array.isArray(selected)||selected.length>2)throw Error('每次选片最多保留两项待看');
   const plans=selected.map(p=>{if(!p||typeof p!=='object'||Object.keys(p).some(k=>!['bvid','reason','questions'].includes(k)))throw Error('待看提案格式异常');const candidate=candidates.find(row=>row.bvid===p.bvid);if(!candidate)throw Error('待看项不在本次真实候选中');return {candidate,plan:browsingPlan({action:'keep',reason:p.reason,questions:p.questions})};});
   const items=[];for(const {candidate,plan}of plans){const target={bvid:candidate.bvid,page:1},old=this.byTarget(target);if(old){items.push({itemId:old.id,status:'already_exists'});continue;}if(this.db.prepare("SELECT count(*) n FROM activity_browsing_items WHERE status IN ('pending','paused')").get().n>=50){items.push({bvid:target.bvid,status:'capacity'});continue;}const item={id:randomUUID(),...target,revision:1,status:'pending',hold:null,title:text(candidate.title?.slice(0,500),'候选标题',500),reason:plan.reason,questions:plan.questions,source:{kind:'candidate_intention',runId,scope:'只来自本次目录元数据，尚未观看；不是经历或事实'},observationId:null,lastRunId:null,createdAt:this.time()};this.save(item);items.push({itemId:item.id,status:'queued'});}
   receipt={status:'processed',items};
  }
  this.activity.update(runId,'running',{decision:{...run.decision,deferredReceipt:receipt}});return receipt;
 });}
 previous(target,{cid}={}){const key=target.bvid+':'+target.page,rows=this.db.prepare("SELECT o.id observation_id FROM activity_observations o WHERE (o.canonical=? OR o.canonical LIKE ?) AND EXISTS(SELECT 1 FROM activity_runs r WHERE r.observation_id=o.id AND coalesce(json_extract(r.request_json,'$.learn'),1)!=0) ORDER BY o.rowid DESC LIMIT 12").all(key,key+':media:%'),seen=new Set(),out=[];for(const row of rows){if(seen.has(row.observation_id))continue;seen.add(row.observation_id);const obs=this.activity.observation(row.observation_id);if(!obs)continue;const p=obs.payload;if(p.bvid!==target.bvid||p.page!==target.page||cid!==undefined&&String(p.video?.cid)!==String(cid))continue;out.push({observationId:obs.id,title:p.title,scope:p.scope,excerpt:p.text.slice(0,1600),sourceUrl:p.url});if(out.length===3)break;}return out;}
 followup(runId,observationId,proposal,selected=null){return this.journal.transaction(()=>{
  const run=this.activity.get(runId);if(!run||run.observation_id!==observationId)throw Error('浏览意图缺少本次真实观察原件');if(run.decision?.browsingReceipt)return run.decision.browsingReceipt;
  let receipt;if(run.request.learn===false)receipt={status:'disabled_by_request'};else{
   const plan=browsingPlan(proposal),obs=this.activity.observation(observationId),target={bvid:obs.payload.bvid,page:obs.payload.page},current=this.byTarget(target);
   if(!plan)receipt={status:'no_change'};
   else if(selected?.absent&&current||selected?.id&&(!current||current.id!==selected.id||current.revision!==selected.revision)||current?.hold==='owner')receipt={status:'source_changed',reason:'浏览意图已有后续修改，未覆盖'};
   else if(current&&!open.has(current.status))receipt={status:'closed_preserved'};
   else if(!current&&['finish','drop'].includes(plan.action))receipt={status:'no_open_item'};
   else if(!current&&this.db.prepare("SELECT count(*) n FROM activity_browsing_items WHERE status IN ('pending','paused')").get().n>=50)receipt={status:'capacity',reason:'暂定浏览事项已满，未新增；观察及记忆审核照常继续'};
   else{const item={...current,id:current?.id??randomUUID(),...target,revision:(current?.revision??0)+1,status:{keep:'pending',pause:'paused',finish:'finished',drop:'dropped'}[plan.action],hold:null,title:obs.payload.title,reason:plan.reason,questions:plan.questions,observationId,source:{kind:'observed_intention',runId,observationId,scope:'角色基于观察形成的暂定意图；疑问不是事实'},lastRunId:runId,createdAt:current?.createdAt??this.time()};this.save(item);receipt={status:'applied',itemId:item.id,revision:item.revision,action:plan.action};}
  }
  this.activity.update(runId,'running',{decision:{...run.decision,browsingReceipt:receipt}});return receipt;
 });}
}
