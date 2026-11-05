import {viewText as clean} from './view-text.js';
// Only this exact legacy combination came from a normal tool finish. It says
// nothing about tool execution, later expression, or delivery to a person.
export const diagnosticStatusSql="CASE WHEN status='failed' AND error_kind='tool-calls' THEN 'handoff' ELSE status END";
export function diagnosticCallState(row){
 const legacyCorrected=row.status==='failed'&&row.error_kind==='tool-calls',status=legacyCorrected?'handoff':row.status;
 const label={handoff:'已交给工具处理',completed:'模型流正常结束',running:'模型流进行中',limited:'输出达到上限',failed:'模型流失败',cancelled:'调用已取消',interrupted:'调用被中断',incomplete:'模型流未完整消费'}[status]??'未分类模型记录';
 return {status:clean(status,40),label,rawStatus:clean(row.status,40),rawErrorKind:row.error_kind===null?null:clean(row.error_kind,80),kind:legacyCorrected||row.error_kind==null?null:clean(row.error_kind,80),legacyCorrected,notice:legacyCorrected?'旧版误归为失败；此处仅校正交接分类，原记录未改写，工具结果另看实际回执':status==='handoff'?'只证明模型请求工具，不证明工具成功、记忆改变或消息送达':null};
}
export function readDiagnosticCalls(db,{since=0,limit=12,anomalies=false}={}){
 return db.prepare(`SELECT id,stage,status,started_at,finished_at,error_kind FROM diagnostic_model_calls WHERE started_at>=? ${anomalies?`AND (${diagnosticStatusSql}) NOT IN ('completed','handoff','running','started')`:''} ORDER BY started_at DESC,rowid DESC LIMIT ?`).all(since,limit).map(({id,stage,started_at,finished_at,...row})=>({id,stage:clean(stage,40),startedAt:started_at,finishedAt:finished_at,...diagnosticCallState(row)}));
}
export function diagnosticStreamOutcome({errorKind,aborted,drained,finish,finishCount,afterFinish,toolBlocks}){
 if(errorKind==='cancelled'||aborted||finish==='aborted')return {status:'cancelled',errorKind:'cancelled'};
 if(errorKind)return {status:'failed',errorKind};
 if(!drained)return {status:'incomplete',errorKind:'consumer_stopped'};
 if(!finishCount)return {status:'incomplete',errorKind:'missing_finish'};
 if(finishCount!==1||afterFinish)return {status:'failed',errorKind:'stream_protocol'};
 if(finish==='stop')return {status:'completed',errorKind:null};
 if(finish==='tool-calls')return toolBlocks?{status:'handoff',errorKind:null}:{status:'incomplete',errorKind:'missing_tool_call'};
 return {status:finish==='max-tokens'?'limited':'failed',errorKind:finish??'unknown'};
}
