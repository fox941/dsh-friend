import {randomUUID} from 'node:crypto';
import {hash,noSecret,text} from './validation.js';
import {runtimeVersion} from './apply-runtime.js';
import {scopedFamily,temporaryChange} from './profile-social-source.js';
import {sceneChange} from './profile-change-source.js';
const keys=(v,allowed)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw Error('画像更正提案含未定义字段');};
export function normalizeChanges(value,frame){
 keys(value,['changes','reason']);const reason=text(value.reason,'提案依据',700);if(!Array.isArray(value.changes)||value.changes.length>2)throw Error('每轮至多更正两个明确偏好');
 const candidates=new Map(frame.candidates.map(c=>[c.id,c])),seen=new Set(),changes=value.changes.map(c=>{
  keys(c,['action','targetIds','quote','statement','reason']);if(!['replace','retract'].includes(c.action)||!Array.isArray(c.targetIds)||!c.targetIds.length||c.targetIds.length>8)throw Error('更正动作或目标数量不正确');
  if(frame.source.transport==='qq-social'?temporaryChange(frame.source.text):sceneChange(frame.source.text))throw Error('本入口不把局部或临时请求扩大为通用画像更正');
  const quote=text(c.quote,'本轮逐字原话',1500);if(!frame.source.text.includes(quote))throw Error('更正必须逐字引用真实主用户本轮原话');
  const targets=c.targetIds.map(id=>{const t=candidates.get(id);if(!t||seen.has(id)||(frame.source.mode==='scene'?t.rule.scope==='scene'&&t.origin.scene!==frame.source.scene:t.rule.scope!=='person'))throw Error('更正目标不在已核验的同一主用户通用画像中');seen.add(id);const oldAt=Date.parse(t.sourceAt??t.at),newAt=Date.parse(frame.source.occurredAt);if(!Number.isFinite(oldAt)||!Number.isFinite(newAt)||oldAt>=newAt)throw Error('旧消息不能覆盖更晚或同刻的画像');return t;});
  if(targets.some(t=>t.rule.kind!==targets[0].rule.kind))throw Error('同一变化不能合并不同类型的画像');
  if(c.action==='retract'&&c.statement!=null)throw Error('撤回不携带新事实');
  const statement=c.action==='replace'?text(c.statement,'更正后的完整事实',700):null;
  const out={id:randomUUID(),action:c.action,targets,quote,statement,reason:text(c.reason,'更正依据',700),...frame.source.transport==='qq-social'?{scope:frame.source.mode}:{}};noSecret(JSON.stringify(out));return out;
 });return {changes,reason};
}
export const historicalNative=content=>'【历史画像原件：已由主用户后续更正或撤回，不再作为当前偏好；以下保留过去原文。】\n'+content;
export function currentNative(change,source){if(source.transport==='qq-social')return `主用户画像${change.action==='replace'?'更正':'撤回'}原件（内部审计；生效以回执为准）\n来源：${source.key}\n时间：${source.occurredAt}\n范围：${change.scope==='scene'?'仅原场景 '+source.scene:'同一人物；保持原来源公开边界'}\n${change.action==='replace'?'新事实：'+change.statement:'本范围旧约定已撤回'}\n原话：${change.quote}\n旧目标与私密原因仅在受保护的应用记录中保存，不在本原件复制。`;return `主用户画像${change.action==='replace'?'更正':'撤回'}原件（已审核本人自述；是否已全部生效以应用回执为准）\n来源：${source.channel} 私聊 ${source.key}\n时间：${source.occurredAt}\n${change.action==='replace'?'新事实：'+change.statement:'已撤回：'+change.targets.map(t=>t.content).join('；')}\n原话：${change.quote}\n适用：同一人物；本条来源保持私密，不授予公开使用许可。`;}
/** The independent reviewer can veto; every write is compiled by the Host. */
export async function prepareProfilePlan(adapter,store,proposal,source,signal){
 const app=adapter.applications,runtime=(await app.backend.runtime.snapshot(signal)).entries,operations=[],changes=proposal.changes.map(c=>{if(source.transport!=='qq-social'||source.mode!=='scene')return {...c,families:store.familiesFor(c.targets)};const local=c.targets.filter(t=>t.rule.scope==='scene'),overlays=[...new Set(c.targets.flatMap(t=>t.rule.scope==='person'?[t.family]:t.overlayFor??[]))],families=[...new Set([...store.familiesFor(local),...overlays.map(f=>scopedFamily(source.scene,f))])],family=local[0]?.family??families[0];return {...c,scope:'scene',family,families,overlayFor:overlays};}),families=[...new Set(changes.flatMap(c=>c.families))],before=store.before(families),nativeSeen=new Set(),runtimeSeen=new Set(),storeId=app.backend.correction.selectStore(undefined,true);
 if(changes.flatMap(c=>c.families).length!==families.length)throw Error('同一画像族不能被两项不同变化重复覆盖');
 const evidence=change=>[{sourceId:source.key,quote:change.quote}];
 for(const c of changes){
  operations.push({kind:'native_add',target:'event',storeId,content:currentNative(c,source),profileVersion:c.id,evidence:evidence(c),proposalIndex:0,becauseRefs:[],reason:c.reason});
  for(const t of c.targets)if(t.nativeRef&&!(c.scope==='scene'&&t.rule.scope==='person')){
   const n=t.nativeRef,key=n.storeId+':'+n.recordId;if(nativeSeen.has(key))continue;nativeSeen.add(key);const row=await app.backend.correction.client.showReadOnly(n.storeId,n.recordId,signal);if(!row||hash(row.content)!==n.contentHash)throw Error('长期旧原件已变化，未按旧提案覆盖');
   const content=historicalNative(row.content);if(content.length>3000)throw Error('旧原文过长，未截断后更正');
   operations.push({kind:'native_correct',reference:{id:'native:'+key,kind:'native',storeId:n.storeId,recordId:n.recordId,text:row.content,createdAt:row.created_at},content,evidence:evidence(c),proposalIndex:0,becauseRefs:[],reason:c.reason});
  }
  const refs=[];
  for(const t of c.targets)if(t.runtimeRef&&c.scope!=='scene'){const matching=runtime.filter(r=>r.target==='user'&&r.content===t.runtimeRef);if(matching.length!==1)throw Error('常驻旧记录已改变');refs.push(matching[0]);}
  for(const r of before.summaries.filter(r=>c.families.includes(r.family)&&r.row?.status==='managed')){
   const rows=runtime.filter(e=>e.target==='user'&&e.content===r.row.content);if(rows.length!==1||runtimeVersion(rows[0])!==r.row.runtime_version)throw Error('对应常驻摘要已被后续改写，保留新值并暂缓更正');refs.push(rows[0]);
  }
  let replaced=false;
  for(const r of refs){const version=runtimeVersion(r);if(runtimeSeen.has(version))continue;runtimeSeen.add(version);const replace=c.action==='replace'&&!replaced;replaced||=replace;
   operations.push({kind:replace?'runtime_replace':'runtime_remove',reference:{id:'runtime:user:'+hash(r.content),kind:'runtime',target:'user',text:r.content,createdAt:r.created_at,updatedAt:r.updated_at,importance:r.importance},...replace?{content:'关于主用户：'+c.statement,projectionFor:c.id}:{},evidence:evidence(c),proposalIndex:0,becauseRefs:[],reason:c.reason});
  }
 }
 if(operations.length+1>8)throw Error('完整更正超过单批预算，未只改其中部分副本');
 const transition={kind:'profile_transition',jobId:null,source,changes,before,evidence:changes.flatMap(evidence),proposalIndex:0,becauseRefs:[],reason:proposal.reason};operations.push(transition);return {operations,changes,before};
}
export function validateProfileAudit(value,frame){
 keys(value,['approve','reason']);if(typeof value.approve!=='boolean')throw Error('更正审核须返回明确否决或同意');const reason=text(value.reason,'独立审核依据',900);
 const operations=value.approve?frame.compiled.operations.map(o=>({...o,reason:o.reason??reason})):[];return {decisions:[{proposalIndex:0,verdict:value.approve?'apply':'noop',timing:'current',reason,operations}]};
}
