import {hash,noSecret} from './validation.js';
const safe=value=>{if(!value)return null;const v=String(value).slice(0,650);try{noSecret(v);return v;}catch{return '诊断含敏感信息，正文已省略';}};
export function nightlyDiagnosis(n,id){
 const run=id?n.store.get(id):null;if(!run)return null;
 const batches=n.store.batches(id),batch=batches.find(b=>b.status!=='completed')??batches.at(-1);
 const report=batch?.report_id?n.preview.store.get(batch.report_id):null;
 let application=batch?.application_id?n.applications.store.get(batch.application_id):null;
 if(!application&&report?.result?.decision?.proposals?.length){const selection=hash(JSON.stringify([report.id,report.result.decision.proposals.map((_p,i)=>i)]));application=n.applications.store.bySelection(selection);}
 const attempt=application?n.applications.store.attempts?.(application.id)?.[0]:null;
 const calls=n.journal.db.prepare('SELECT role,status,result_json,error FROM nightly_calls WHERE run_id=? ORDER BY rowid DESC LIMIT 3').all(id).map(row=>{let metadata=null;try{metadata=JSON.parse(row.result_json);}catch{}return {role:row.role,status:row.status,error:safe(row.error),diagnostics:metadata?.diagnostics??null};});
 const trace=attempt?.diagnostics??calls.find(c=>c.status!=='completed')?.diagnostics??null;
 const error=safe(application?.error??run.error??batch?.error),finished=run.status==='completed';
 let code=finished?'completed':run.status==='budget_exhausted'?'budget_exhausted':!error?'not_failed':trace?.finishKind==='max-tokens'?'model_output_limit':/超时|timeout/i.test(error)?'review_timeout':/空间|Native|记忆配置|存储/.test(error)?'storage_unavailable':/JSON|格式|原文|证据|提案|引用/.test(error)?'review_or_validation_failed':'review_failed';
 return {runId:id,status:run.status,stage:application?'application':report?'preview_saved':'preview',code,error,reportId:report?.id??null,applicationId:application?.id??null,applicationStatus:application?.status??null,reviewDiagnostics:trace,calls,
  automaticRetry:!finished&&['retry_wait','budget_exhausted','interrupted','yielded'].includes(run.status),
  hint:finished?'本任务已完成；不需要为了诊断重做整理。':code==='model_output_limit'?'模型以max-tokens结束；保留原报告与失败审核，不绕过审核写入。':code==='budget_exhausted'?'等待原额度恢复，保留检查点，不重复预演。':'这是保存的阶段回执，不证明提案正确或模型一定有错；按原报告和失败详情定位，不能跳过审核或重放已提交步骤。'};
}
