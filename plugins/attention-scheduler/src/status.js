const parse=value=>value?JSON.parse(value):null;
const phase=(code,label,reason=null)=>({code,label,reason});

export function intentState(row){
 const result=row.result??parse(row.result_json),wake=row.wake??parse(row.wake_json),reason=result?.reason??row.error??result?.summary??null;
 if(row.status==='dismissed')return phase('not_selected','模型选择不处理',reason);
 if(row.status==='failed'||row.status==='completed'&&result?.status==='failed')return phase('processing_error','处理失败',reason);
 if(row.status==='waiting'){
  if(row.error)return phase('processing_error','处理失败，等待重新考虑',reason);
  if(result?.waitSource==='model')return phase('deferred','模型选择暂缓',reason);
  if(result?.waitSource==='resource'||result?.resource||['qq_ready','activity_policy','proactive_resume'].includes(wake?.kind))return phase('waiting_resource','等待资源',reason);
  return phase('waiting_condition','等待条件（历史原因可能未分类）',reason);
 }
 if(['running','admitting','waking','selected'].includes(row.status))return phase('executing','已选或执行中，以任务回执为准',reason);
 if(row.status==='paused')return phase('paused','任务已暂停',reason);
 if(row.status==='cancelled')return phase('cancelled','已取消',reason);
 if(row.status==='completed')return phase(result?.status==='silent'?'silent':'processed',result?.status==='silent'?'表达阶段选择沉默':'已处理，送达情况以渠道回执为准',reason);
 return phase('pending','待选择',reason);
}

export function readDecisionState(db,now=Date.now()){
 const meta=db.prepare('SELECT epoch,considered,retry_at FROM attention_meta WHERE id=1').get();
 const last=db.prepare('SELECT id,status,decision_json,error,usage_json,created_at FROM attention_decisions ORDER BY rowid DESC LIMIT 1').get(),decision=parse(last?.decision_json);
 const hasAttempts=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attention_attempts'").get());
 const attempts=last&&hasAttempts?db.prepare('SELECT phase,status,error,usage_json,started_at,finished_at FROM attention_attempts WHERE decision_id=? ORDER BY started_at,phase').all(last.id).map(({usage_json,...r})=>({...r,usage:parse(usage_json)})):[];
 const counts=Object.fromEntries(db.prepare('SELECT status,count(*) n FROM attention_intents GROUP BY status').all().map(r=>[r.status,r.n]));
 const recent=db.prepare('SELECT id,kind,status,wake_json,result_json,error,updated_at FROM attention_intents ORDER BY updated_at DESC,rowid DESC LIMIT 12').all().map(row=>({id:row.id,kind:row.kind,status:row.status,state:intentState(row),wake:parse(row.wake_json),updatedAt:row.updated_at}));
 let current;
 if(last?.status==='thinking')current=phase(attempts.some(a=>a.phase==='repair'&&a.status==='running')?'correcting':'deciding',attempts.some(a=>a.phase==='repair'&&a.status==='running')?'正在纠正决策格式':'正在作出决策');
 else if(meta.retry_at>now&&['failed','interrupted'].includes(last?.status))current={...phase('error_backoff',last.status==='failed'?'决策失败，等待重试':'决策中断，等待重新考虑',last.error),retryAt:new Date(meta.retry_at).toISOString()};
 else if(['running','admitting','waking','selected'].some(s=>counts[s]>0))current=phase('executing','有已选或正在执行的任务');
 else if(meta.epoch!==meta.considered&&counts.pending)current=phase('pending','有待重新选择的事项');
 else if(!counts.pending&&counts.waiting&&db.prepare("SELECT 1 FROM attention_intents WHERE status='waiting' AND json_valid(result_json) AND json_extract(result_json,'$.waitSource')='resource' LIMIT 1").get())current=phase('waiting_resources','有事项等待资源或执行能力','当前没有执行中的任务；具体资源限制与模型暂缓分别查看各事项记录。');
 else if(last?.status==='committed'&&decision?.action==='rest')current=phase('resting','模型选择暂时安静',decision.reason);
 else if(counts.waiting)current=phase('waiting','事项正在等待各自条件');
 else current=phase('idle','当前没有正在执行的任务');
 return {current,counts,recent,lastDecision:last?{id:last.id,status:last.status,action:decision?.action??null,reason:decision?.reason??null,error:last.error,usage:parse(last.usage_json),createdAt:last.created_at,attempts}:null,notice:'这里只展示短选择依据及运行事实，不展示模型内部推理。暂缓或安静不代表已回复；旧记录未分类时不推断为有意沉默。'};
}
