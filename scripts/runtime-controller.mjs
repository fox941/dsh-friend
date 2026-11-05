import {defaults,findings,restartPlan,recordAttempt,AlertTracker} from './runtime-core.mjs';
// All IO is injected so fault tests cannot touch a real account, model or runtime.
export class RuntimeController{
  constructor({state,io,now=Date.now,config={}}){this.state=state;this.io=io;this.now=now;this.config={...defaults,...config};this.alerts=new AlertTracker();this.firstSeen={};this.launch=null;this.events=[];}
  async persist(){await this.io.save(this.state);}
  async tick(){
    const now=this.now();let snapshot;
    if(!this.state.desiredRunning)snapshot={state:'stopped'};
    else{
      try{snapshot=await this.io.probe();}catch{snapshot={state:'inspection_failed',message:'运行状态读取失败，暂不恢复，请检查数据与权限'};}
      // A cold SDK import can temporarily block the newly spawned Host's JS control pipe.
      // Wait only for our recorded child, within the existing startup grace; never relaunch it.
      if(snapshot.state==='host_unresponsive'&&this.launch&&this.launch.pid===snapshot.pid&&now-this.launch.at<this.config.startupGraceMs)snapshot={...snapshot,state:'starting',message:'本次受控启动仍在加载，暂等控制通道；保留原进程'};
      if(snapshot.state==='running'){
        if(snapshot.health?.available&&snapshot.health.identity!==this.state.identity)snapshot={state:'identity_conflict',message:'运行中的身份与原实例不同，停止自动恢复并保留现场'};
        else if(snapshot.health?.available){this.launch=null;if(!this.state.hasRun){this.state.hasRun=true;await this.persist();}}
      }
      if(['absent','dead'].includes(snapshot.state)){
        if(this.launch&&this.io.alive(this.launch.pid))snapshot=now-this.launch.at>this.config.startupGraceMs?{state:'host_unresponsive',message:'新进程启动超过预期，尚无控制通道；保留现场，请检查日志'}:{state:'starting',message:'已启动进程，等待控制通道与插件就绪'};
        else{
          this.launch=null;
          const plan=restartPlan(this.state,now,this.config);this.state.attempts=plan.attempts;
          if(!plan.allowed)snapshot={state:plan.reason,message:plan.reason==='restart_limit'?'十五分钟内已尝试三次恢复，等待人工检查或运行 Recover':'等待恢复冷却，原任务与发送回执保持不变'};
          else{
            try{
              await this.io.preflight(this.state.identity);
              this.state=recordAttempt(this.state,now,this.config);await this.persist();
              this.launch=await this.io.launch();snapshot={state:'starting',message:'已发起受控启动，沿用原身份和检查点'};
              this.events.push({at:now,code:'host_started',kind:'action',message:'受控启动已发起'});
              if(this.state.hasRun)for(const event of this.alerts.update([{code:'host_recovering',message:'项目进程已退出，已发起受控恢复；原数据保持不变'}])){this.events.push({at:now,...event});await this.io.notify(event).catch(()=>{});}
            }catch{snapshot={state:'recovery_blocked',message:'启动前检查或启动失败；可能存在维护锁、端口占用、数据缺失或身份变化，请检查后运行 Recover'};this.state.nextAttemptAt=now+this.config.backoffMs.at(-1);await this.persist();}
          }
        }
      }
    }
    const disconnected=snapshot.state==='running'&&snapshot.health?.qq?.enabled&&(!snapshot.health.qq.connected||!snapshot.health.qq.accountVerified);
    if(disconnected)this.firstSeen.qq??=now;else delete this.firstSeen.qq;
    const items=findings(snapshot,{now,firstSeen:this.firstSeen,config:this.config}).filter(r=>!['starting','backoff'].includes(r.code));
    const transient=['starting','backoff'].includes(snapshot.state);
    if(snapshot.state==='stopped')this.alerts.active.clear();
    for(const event of transient||snapshot.state==='stopped'?[]:this.alerts.update(items)){
      this.events.push({at:now,...event});await this.io.notify(event).catch(()=>{});
    }
    this.events=this.events.slice(-100);
    const status={schema:'ai-friend/runtime-status/1',checkedAt:new Date(now).toISOString(),desiredRunning:this.state.desiredRunning,identity:this.state.identity,recovery:{attempts:this.state.attempts??[],nextAttemptAt:this.state.nextAttemptAt??0,maxRestarts:this.config.maxRestarts,windowMs:this.config.restartWindowMs},...snapshot,findings:items,events:this.events};
    await this.io.status(status);return status;
  }
  async command(action){
    if(action==='stop'){
      this.state.desiredRunning=false;await this.persist();
      try{await this.io.stop(this.launch);}finally{await this.tick();}
      return {stopped:true};
    }
    if(action==='restart'){
      // Persist intent before graceful stop, preventing automatic recovery during maintenance.
      this.state.desiredRunning=false;await this.persist();await this.io.stop(this.launch);
    }
    if(!['start','restart','recover'].includes(action))throw Error('Unknown runtime action');
    this.state.desiredRunning=true;
    if(action!=='start'){this.state.attempts=[];this.state.nextAttemptAt=0;}
    await this.persist();return this.tick();
  }
}
