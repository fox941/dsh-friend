// Technical health only. Attention queues and decisions never participate in recovery.
export const defaults=Object.freeze({pollMs:15000,startupGraceMs:90000,idleMs:180000,disconnectGraceMs:90000,restartWindowMs:900000,maxRestarts:3,backoffMs:[10000,30000,60000]});
export function findings(snapshot,{now=Date.now(),firstSeen={},config=defaults}={}){
  const result=[];
  const add=(code,message)=>result.push({code,message});
  if(snapshot.state!=='running'){
    if(snapshot.state!=='stopped')add(snapshot.state,snapshot.message??'运行状态需要检查');
    return result;
  }
  const h=snapshot.health;
  if(h?.isolation&&(!h.isolation.active||!h.isolation.valid))add('test_policy_invalid','测试实例的隔离保护未就绪；请停止测试并运行 Setup-Test');
  if(!h?.available){if(now-snapshot.startedAt>=config.startupGraceMs)add('plugin_unavailable','进程存在，但陪伴插件尚未就绪；保留进程，请检查日志');return result;}
  if(!h.memory?.configured||!h.memory.activeSpaces||h.memory.stores?.some(s=>!s.readable))add('memory_unavailable','记忆存储不可用或未激活；不会重建角色或覆盖数据');
  if(h.qq?.enabled&&(!h.qq.connected||!h.qq.accountVerified)&&now-(firstSeen.qq??now)>=config.disconnectGraceMs)add('qq_unavailable','QQ 未完成连接或账号核验；请检查 NapCat，可能需要重新扫码');
  if(h.qq?.enabled&&['suspect','degraded','api_unavailable','inspection_failed','wrong_account','login_required'].includes(h.qq.reliability?.classification))add('qq_sync_'+h.qq.reliability.classification,h.qq.reliability.classification==='login_required'?'QQ需要扫码登录；请打开现有NapCat登录页，项目和记忆保留':h.qq.reliability.classification==='wrong_account'?'QQ实际账号与绑定不符，未接管该账号':'QQ业务状态可疑或同步异常；请查看QQ状态和近期补收覆盖，不代表AI主动沉默');
  if(h.bilibili?.enabled&&(!h.bilibili.accountBound||h.bilibili.failures>=2))add('bilibili_unavailable','B站接收连续失败或账号未绑定；请检查网络及登录状态');
  if(h.models?.active?.some(s=>s.idleMs>=config.idleMs))add('model_idle','模型请求长时间没有新进展，可能正在等待服务；仅提示，不终止请求');
  if(h.models?.recentStreamFailures>=3)add('model_failures','近五分钟多次模型请求失败；请检查网络、接口与额度');
  return result;
}
export function restartPlan(state,now=Date.now(),config=defaults){
  const attempts=(state.attempts??[]).filter(at=>Number.isFinite(at)&&at>now-config.restartWindowMs);
  if(!state.desiredRunning)return {allowed:false,reason:'stopped',attempts};
  if(attempts.length>=config.maxRestarts)return {allowed:false,reason:'restart_limit',attempts};
  return {allowed:now>=(state.nextAttemptAt??0),reason:'backoff',attempts};
}
export function recordAttempt(state,now=Date.now(),config=defaults){
  const attempts=[...restartPlan(state,now,config).attempts,now];
  return {...state,attempts,nextAttemptAt:now+config.backoffMs[Math.min(attempts.length-1,config.backoffMs.length-1)]};
}
export class AlertTracker{
  constructor(){this.active=new Set();}
  update(items){const next=new Set(items.map(r=>r.code)),changes=[];for(const r of items)if(!this.active.has(r.code))changes.push({...r,kind:'fault'});for(const code of this.active)if(!next.has(code))changes.push({code,kind:'recovered',message:'状态已恢复：'+code});this.active=next;return changes;}
}
