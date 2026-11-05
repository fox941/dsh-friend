export function armActivityTimer(controller,active){
  active.remaining??=controller.config.timeoutMs;active.startedAt=Date.now();
  active.timer=setTimeout(()=>active.stop.abort(new Error('活动执行时间预算已用完')),Math.max(1,active.remaining));active.timer.unref?.();
}
export async function activityCheckpoint(controller,active,signal,phase){
  if(!controller.attention?.enabled()||!active.id)return;
  signal.throwIfAborted();active.phase=phase;
  const attention=controller.attention,run=controller.store.get(active.id);
  if(!active.attentionId){const intent=attention.offer({key:'activity:'+active.id,kind:'browse',scope:'internal',summary:'正在进行的B站阅读：'+(run.request.query??run.request.video?.bvid??run.decision?.query??'当前内容'),payload:{runId:active.id}});active.attentionId=intent.id;attention.store.patch(intent.id,'running');}
  const intent=attention.store.get(active.attentionId);attention.store.updatePayload(intent.id,{...intent.payload,runId:active.id});
  attention.store.checkpoint('activity:'+active.id,{phase,target:active.target??null,observationId:run.observation_id,updatedAt:new Date().toISOString()});
  if(!active.pauseRequested)return;
  active.paused=true;active.remaining=Math.max(1,(active.remaining??controller.config.timeoutMs)-(Date.now()-(active.startedAt??Date.now())));clearTimeout(active.timer);
  controller.store.update(active.id,'paused');attention.store.patch(active.attentionId,'paused');active.pauseAck?.();
  await new Promise((resolve,reject)=>{
    const done=()=>{signal.removeEventListener('abort',abort);active.resume=null;resolve();};
    const abort=()=>{signal.removeEventListener('abort',abort);active.resume=null;reject(signal.reason);};
    active.resume=done;if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
  signal.throwIfAborted();active.paused=false;active.pauseRequested=false;controller.store.update(active.id,'running');attention.store.patch(active.attentionId,'running');armActivityTimer(controller,active);
}
export async function pauseActivity(controller,signal){
  const active=controller.active;if(!active||active.paused)return;
  active.pauseRequested=true;
  const ack=new Promise(resolve=>{active.pauseAck=resolve;});
  await Promise.race([ack,active.promise,...signal?[new Promise((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})]:[]]);
}
export function resumeActivity(controller){const active=controller.active;if(!active)return;active.pauseRequested=false;active.resume?.();}
