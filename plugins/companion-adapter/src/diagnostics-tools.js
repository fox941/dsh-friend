import {randomUUID} from 'node:crypto';import {noSecret} from './validation.js';
const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=256;
export function initializeToolDiagnostics(db,now){
 db.exec(`CREATE TABLE IF NOT EXISTS diagnostic_tool_calls(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,call_id TEXT NOT NULL,call_seq INTEGER,result_seq INTEGER,tool_name TEXT,model_call_id TEXT,status TEXT NOT NULL,started_at INTEGER,finished_at INTEGER,error_kind TEXT,UNIQUE(session_id,call_seq),UNIQUE(session_id,result_seq));
 CREATE INDEX IF NOT EXISTS diagnostic_tools_time ON diagnostic_tool_calls(coalesce(finished_at,started_at));
 CREATE INDEX IF NOT EXISTS diagnostic_tools_call ON diagnostic_tool_calls(session_id,call_id,call_seq);`);
 db.prepare("UPDATE diagnostic_tool_calls SET status='interrupted',finished_at=?,error_kind='process_restart' WHERE status='running'").run(now);
}
/** Metadata from original session events only. Arguments and output never enter diagnostics. */
export function captureToolEvent(db,sessionId,event,modelCallId=null){
 if(!identifier(sessionId)||!Number.isSafeInteger(event?.seq)||event.seq<0||!Number.isFinite(event.time))return;
 if(event.type==='tool/call'){
  const {callId,name}=event.data??{};if(!identifier(callId)||!identifier(name))return;noSecret(JSON.stringify([sessionId,callId,name]));
  db.prepare("INSERT OR IGNORE INTO diagnostic_tool_calls(id,session_id,call_id,call_seq,tool_name,model_call_id,status,started_at) VALUES(?,?,?,?,?,?,'running',?)").run(randomUUID(),sessionId,callId,event.seq,name,modelCallId,event.time);return;
 }
 if(event.type!=='tool/result')return;
 const m=event.data?.message,callId=m?.toolCallId??m?.callId;if(!identifier(callId)||m.toolCallId&&m.callId&&m.toolCallId!==m.callId)return;noSecret(JSON.stringify([sessionId,callId]));
 if(db.prepare('SELECT 1 FROM diagnostic_tool_calls WHERE session_id=? AND result_seq=?').get(sessionId,event.seq))return;
 const row=db.prepare('SELECT id,result_seq FROM diagnostic_tool_calls WHERE session_id=? AND call_id=? AND call_seq<? ORDER BY call_seq DESC LIMIT 1').get(sessionId,callId,event.seq),status=m.isError===true?'failed':'completed',error=m.isError===true?'tool_error':null;
 // A second result cannot replace an already recorded result for that call.
 if(row){if(row.result_seq===null)db.prepare('UPDATE diagnostic_tool_calls SET result_seq=?,status=?,finished_at=?,error_kind=? WHERE id=? AND result_seq IS NULL').run(event.seq,status,event.time,error,row.id);return;}
 db.prepare('INSERT INTO diagnostic_tool_calls(id,session_id,call_id,result_seq,status,finished_at,error_kind) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),sessionId,callId,event.seq,status,event.time,error);
}
export function readToolDiagnostics(db,{since=0,limit=12}={}){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='diagnostic_tool_calls'").get())return {available:false,counts:[],recent:[],notice:'没有工具回执诊断记录，不能推断历史工具结果'};
 const counts=db.prepare('SELECT status,count(*) count FROM diagnostic_tool_calls WHERE coalesce(finished_at,started_at)>=? GROUP BY status').all(since),recent=db.prepare('SELECT id,session_id sessionId,call_id callId,model_call_id modelCallId,tool_name toolName,status,call_seq callSeq,result_seq resultSeq,started_at startedAt,finished_at finishedAt,error_kind kind FROM diagnostic_tool_calls WHERE coalesce(finished_at,started_at)>=? ORDER BY coalesce(finished_at,started_at) DESC,rowid DESC LIMIT ?').all(since,limit).map(r=>({...r,label:{running:'等待工具回执',completed:'工具返回非错误结果',failed:'工具返回错误',interrupted:'工具执行被中断'}[r.status]??'未分类工具记录',source:r.callSeq===null?'result_only':r.resultSeq===null?'call_only':'call_and_result',notice:r.callSeq===null?'只观察到结果事件，尚未关联原调用名称或模型交接':'工具返回结果不证明平台送达、业务修改成功或整轮对话完成'}));
 return {available:true,counts,recent,notice:'只记录启用后的原会话工具事件；历史未回填，截断、取消与工具错误分别看待。不保存工具参数或输出正文。'};
}
