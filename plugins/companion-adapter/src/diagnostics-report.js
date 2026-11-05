import {learningForbidden} from './attention-affect.js';
import {diagnosticStatusSql,readDiagnosticCalls} from './diagnostics-state.js';
import {readToolDiagnostics} from './diagnostics-tools.js';
const has=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const percentile=(values,q)=>values.length?values[Math.min(values.length-1,Math.ceil(values.length*q)-1)]:null;
const active="('pending','waiting','paused','selected','admitting','waking','running')";
/** Pure SELECT queries: viewing a report never changes state or calls a model. */
export function readDiagnostics(db,{hours=24,limit=40,intentId=null,now=Date.now()}={}){
  if(!Number.isInteger(hours)||hours<1||hours>720||!Number.isInteger(limit)||limit<1||limit>100||intentId!==null&&(typeof intentId!=='string'||!/^[\w:-]{1,180}$/.test(intentId)))throw new Error('诊断查询范围无效');
  if(!has(db,'diagnostic_meta'))return {status:'not_initialized',notice:'当前实例尚未开始采集诊断，历史数据不会被补造'};
  const since=now-hours*3600000,meta=db.prepare('SELECT * FROM diagnostic_meta').get(),findings=[];
  const costs=db.prepare(`SELECT stage,count(*) calls,sum(status='running') running,sum((${diagnosticStatusSql}) IN ('failed','cancelled','interrupted','incomplete')) unsuccessful,sum((${diagnosticStatusSql})='failed') failures,sum((${diagnosticStatusSql})='handoff') handoffs,sum(status='failed' AND error_kind='tool-calls') legacyHandoffs,sum(status='completed') completed,sum(status='limited') limited,sum(status='cancelled') cancelled,sum(status='interrupted') interrupted,sum(status='incomplete') incomplete,count(total_tokens) usageSamples,sum(input_tokens) inputTokens,sum(cache_read_tokens) cacheReadTokens,sum(cache_write_tokens) cacheWriteTokens,sum(output_tokens) outputTokens,sum(reasoning_tokens) reasoningTokensDetail,sum(total_tokens) totalTokens FROM diagnostic_model_calls WHERE started_at>=? GROUP BY stage ORDER BY calls DESC`).all(since);
  for(const row of costs){const times=db.prepare('SELECT duration_ms FROM diagnostic_model_calls WHERE started_at>=? AND stage=? AND duration_ms IS NOT NULL ORDER BY started_at DESC LIMIT 5000').all(since,row.stage).map(x=>x.duration_ms).sort((a,b)=>a-b);row.latency={samples:times.length,p50Ms:percentile(times,.5),p95Ms:percentile(times,.95)};}
  const duplicates=db.prepare("SELECT stage,fingerprint,count(*) calls,min(started_at) firstAt,max(started_at) lastAt FROM diagnostic_model_calls WHERE started_at>=? AND fingerprint IS NOT NULL GROUP BY stage,fingerprint HAVING count(*)>=3 ORDER BY calls DESC LIMIT 10").all(since);
  for(const row of duplicates)findings.push({code:'identical_request_repeated',stage:row.stage,count:row.calls,meaning:'相同请求多次出现，可能是合理重试或反复处理，需结合结果判断'});
  let behaviour={available:false};
  if(has(db,'attention_intents')){
    const counts=db.prepare('SELECT status,count(*) count FROM attention_intents GROUP BY status').all();
    const unfinished=db.prepare(`SELECT id,kind,scope,status,wake_json,created_at,updated_at FROM attention_intents WHERE status IN ${active} ORDER BY created_at LIMIT 100`).all().map(({wake_json,...r})=>({...r,wake:wake_json?JSON.parse(wake_json):null,ageHours:Math.max(0,(now-Date.parse(r.created_at))/3600000)}));
    for(const row of unfinished){
      if(row.status==='waiting'&&row.wake?.kind==='time'&&row.wake.at<now-3600000)findings.push({code:'reconsideration_time_passed',intentId:row.id,meaning:'重评时间已过去，检查后续选择；不是要求自动补发回复'});
      else if(['pending','selected','admitting','waking','running'].includes(row.status)&&now-Date.parse(row.updated_at)>6*3600000)findings.push({code:'unfinished_without_recent_progress',intentId:row.id,meaning:'六小时未见进展，需要检查；等待本身不等于故障'});
    }
    const deferrals=db.prepare("SELECT intent_id intentId,count(*) count FROM diagnostic_intent_events WHERE at>=? AND to_state='waiting' GROUP BY intent_id HAVING count(*)>=5 ORDER BY count(*) DESC LIMIT 10").all(since);
    for(const row of deferrals)findings.push({code:'repeated_deferral',...row,meaning:'多次暂缓，需要观察是否有合理等待条件，不自动提高聊天优先级'});
    const history=db.prepare(`SELECT intent_id intentId,kind,from_state previous,to_state status,wake_kind wakeKind,wake_at wakeAt,reason,at FROM diagnostic_intent_events WHERE at>=? ${intentId?'AND intent_id=?':''} ORDER BY id DESC LIMIT ?`).all(since,...intentId?[intentId]:[],limit);
    behaviour={available:true,counts,unfinished,history,unfinishedSampleLimit:100,silenceMeaning:'dismissed是自主不回应，不能单凭此状态判为故障'};
  }
  let emotions={available:false};
  if(has(db,'emotion_versions')&&has(db,'growth_events')){
    const samples=db.prepare('SELECT v.*,e.content,e.origin_json FROM emotion_versions v JOIN (SELECT e.*,o.origin_json FROM growth_events e LEFT JOIN growth_event_origins o ON o.event_id=e.id) e ON e.id=v.source_id WHERE v.created_at>=? ORDER BY v.rowid DESC LIMIT 1000').all(new Date(since).toISOString());
    let noSaveCandidates=0,quoteMismatches=0,reappraisals=0;
    for(const row of samples){
      const record=JSON.parse(row.record_json);
      if(learningForbidden(row.content)){noSaveCandidates++;findings.push({code:'no_save_source_needs_review',versionId:row.id,meaning:'来源含禁止学习或只读措辞；引述与语境需人工核对，不自动删除'});}
      if(!row.content.includes(record.causeQuote)){quoteMismatches++;findings.push({code:'emotion_quote_not_in_source',versionId:row.id,meaning:'情绪引文与原件不匹配，需要核对'});}
      const batch=record.batchId&&has(db,'emotion_review_attempts')?db.prepare('SELECT request_json FROM emotion_review_attempts WHERE batch_id=? ORDER BY id DESC LIMIT 1').get(record.batchId):null;
      if(batch&&JSON.parse(batch.request_json).assessment?.kind==='reappraisal'){
        reappraisals++;const old=db.prepare('SELECT record_json FROM emotion_versions WHERE id=?').get(row.previous_id);
        if(old){const p=JSON.parse(old.record_json),rank={low:0,medium:1,high:2};if(record.anchorAt!==p.anchorAt||record.intensity>p.intensity+1e-9||rank[record.confidence]>rank[p.confidence])findings.push({code:'reappraisal_strengthening_needs_review',versionId:row.id,meaning:'纯反思出现强化或刷新锚点，需要核对'});}
      }
    }
    const missing=db.prepare('SELECT count(*) count FROM emotion_versions v LEFT JOIN growth_events e ON e.id=v.source_id WHERE v.created_at>=? AND e.id IS NULL').get(new Date(since).toISOString()).count;
    if(missing)findings.push({code:'emotion_original_missing',count:missing,meaning:'情绪历史缺少对应原件，需核对'});
    emotions={available:true,samples:samples.length,sampleLimit:1000,noSaveCandidates,quoteMismatches,reappraisals,missingOriginals:missing,semanticQuality:'这里只检查可核验的一致性和风险线索，不能自动断定是否误读、感受是否自然'};
  }
  return {status:'read',asOf:new Date(now).toISOString(),window:{hours,since:new Date(since).toISOString(),collectionStartedAt:new Date(meta.started_at).toISOString(),historicalCoveragePartial:meta.started_at>since||meta.pruned_before!==null&&since<=meta.pruned_before,retentionDays:meta.retention_days,maxRowsPerDiagnosticTable:meta.max_rows},costs,modelCalls:readDiagnosticCalls(db,{since,limit}),tools:readToolDiagnostics(db,{since,limit}),behaviour,emotions,findings:findings.slice(0,100),scope:'只读诊断，不改变人格、记忆、优先级或任务状态；耗时为本机观察的流消费时间，tokens不等同于账单金额。usage缺失保留未知；推理tokens已包含在输出中，不再加总。handoff只表示模型交给工具处理，工具结果另看原回执；completed仅指模型流正常结束，不表示提案已通过或已对外发送。legacyCorrected是对旧tool-calls误分类的只读解释，不改历史、不推定旧工具成功；采集前的调用和状态变化不回填。'};
}
