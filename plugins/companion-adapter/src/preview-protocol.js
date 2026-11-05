import * as z from 'zod';
import {noSecret} from './validation.js';
export const previewProtocolVersion='1';
export const previewActions=['keep','duplicate','supplement','temporal_change','conflict','leave_hot','review_self','defer'];
const words=max=>z.string().min(1).max(max).regex(/\S/,'需要非空白文字');
const id=z.string().min(1);
export const previewSchema=z.object({summary:words(1200),proposals:z.array(z.object({action:z.enum(previewActions),summary:words(500),reason:words(900),evidence:z.array(z.object({sourceId:id,quote:words(1500)}).strict()).min(1).max(4),referenceIds:z.array(id).max(6),effectiveTime:words(160).optional(),conditions:words(400).optional()}).strict()).max(8)}).strict();
export const previewJsonSchema=()=>z.toJSONSchema(previewSchema,{io:'input'});
const type=value=>value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value;
const at=(value,path)=>path.reduce((v,k)=>v?.[k],value);
export function validatePreviewShape(value){
 const parsed=previewSchema.safeParse(value);if(parsed.success)return parsed.data;
 const wrongTypes=new Set(parsed.error.issues.filter(i=>i.code==='invalid_type').map(i=>JSON.stringify(i.path)));
 const issues=parsed.error.issues.filter(issue=>!['too_big','too_small'].includes(issue.code)||!wrongTypes.has(JSON.stringify(issue.path))).slice(0,16).map(issue=>{
  const path=issue.path.join('.'),current=at(value,issue.path),expected=issue.expected;
  const message=issue.code==='invalid_type'?`应为${['array','string','object'].includes(expected)?expected:'指定类型'}`:issue.code==='invalid_value'?'必须选择一个有效action枚举值':issue.code==='too_small'?'长度或数量不足':issue.code==='too_big'?'长度或数量超过上限':issue.code==='unrecognized_keys'?'含协议之外的字段':'字段格式不合规';
  return {path,code:issue.code,message,receivedType:type(current),...Array.isArray(current)||typeof current==='string'?{receivedLength:current.length}:{},...Number.isFinite(issue.minimum)?{minimum:issue.minimum}:{},...Number.isFinite(issue.maximum)?{maximum:issue.maximum}:{}};
 });
 throw Object.assign(new Error('预演结构无效：'+issues.slice(0,3).map(i=>(i.path||'$')+' '+i.message).join('；')),{code:'PREVIEW_SCHEMA_INVALID',repairable:true,issues});
}
export function previewGroundingError(path,message){return Object.assign(new Error(message),{code:'PREVIEW_GROUNDING_INVALID',repairable:false,issues:[{path,code:'grounding',message}]});}
export function safePreviewDraft(value){
 try{const raw=JSON.stringify(value);if(!raw||raw.length>18000)return {omission:'unvalidated_output_too_large_or_unavailable'};noSecret(raw);return {unvalidatedDecision:JSON.parse(raw)};}catch{return {omission:'sensitive_or_non_json_unvalidated_output'};}
}
const rows=v=>Array.isArray(v)?v:v&&typeof v==='object'?[v]:null;
const pairs=p=>(rows(p?.evidence)??[]).filter(e=>e&&typeof e.sourceId==='string'&&typeof e.quote==='string').map(e=>({sourceId:e.sourceId,quote:e.quote.trim()}));
const refs=p=>(Array.isArray(p?.referenceIds)?p.referenceIds:typeof p?.referenceIds==='string'?[p.referenceIds]:[]).filter(x=>typeof x==='string');
export function previewRepairEligibility(value,error,snapshot){
 if(error?.code!=='PREVIEW_SCHEMA_INVALID')return {allowed:false,reason:'not_a_shape_error'};
 if(!value||typeof value!=='object'||Array.isArray(value))return {allowed:false,reason:'unrecognizable_root'};
 if(error.issues?.some(i=>i.code==='too_big'))return {allowed:false,reason:'would_drop_or_shorten_content'};
 if(!safePreviewDraft(value).unvalidatedDecision)return {allowed:false,reason:'unsafe_or_oversized_draft'};
 const proposals=rows(value.proposals);if(!proposals||proposals.length>8)return {allowed:false,reason:'unrecognizable_proposals'};
 const sources=new Map(snapshot.sources.sources.map(s=>[s.id,s])),memories=new Set(snapshot.memories.items.map(m=>m.id));
 for(const p of proposals){
  if(!p||typeof p!=='object'||Array.isArray(p)||typeof p.summary!=='string'||!p.summary.trim())return {allowed:false,reason:'unrecognizable_proposal_meaning'};
  if(typeof p.reason==='string'&&!p.reason.trim())return {allowed:false,reason:'would_replace_empty_text'};
  const evidence=pairs(p);if(evidence.some(e=>!e.quote||!sources.get(e.sourceId)?.text.includes(e.quote)))return {allowed:false,reason:'existing_evidence_not_grounded'};
  if(evidence.length&&!evidence.some(e=>sources.get(e.sourceId).kind==='user_message'))return {allowed:false,reason:'existing_evidence_is_assistant_only'};
  if(refs(p).some(r=>!memories.has(r)))return {allowed:false,reason:'existing_reference_unknown'};
 }
 return {allowed:true,reason:'bounded_shape_correction'};
}
export function assertPreviewRepairScope(previous,next){
 const prior=rows(previous.proposals);if(!prior||prior.length!==next.proposals.length)throw previewGroundingError('proposals','结构纠正不得丢弃、增加或合并原提案');
 const same=(a,b)=>typeof a!=='string'||a.trim()===b?.trim();
 if(!same(previous.summary,next.summary))throw previewGroundingError('summary','结构纠正改变了原预演总结');
 prior.forEach((p,i)=>{
  const n=next.proposals[i];for(const key of ['summary','reason','effectiveTime','conditions'])if(!same(p?.[key],n[key]))throw previewGroundingError(`proposals.${i}.${key}`,'结构纠正改变了原提案文字');
  if(previewActions.includes(p?.action)&&p.action!==n.action)throw previewGroundingError(`proposals.${i}.action`,'结构纠正改变了原有有效动作');
  for(const e of pairs(p))if(!n.evidence.some(x=>x.sourceId===e.sourceId&&x.quote===e.quote))throw previewGroundingError(`proposals.${i}.evidence`,'结构纠正不得删除或改写原引文');
  const r=[...new Set(refs(p))].sort();if(r.length&&JSON.stringify(r)!==JSON.stringify([...new Set(n.referenceIds)].sort()))throw previewGroundingError(`proposals.${i}.referenceIds`,'结构纠正改变了已有旧条目引用');
 });
}
