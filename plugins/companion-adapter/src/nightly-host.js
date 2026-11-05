import {eligibleHeader} from './preview-sessions.js';
import {reviewPreview,repairPreview} from './preview-reviewer.js';
import {reviewApplication} from './apply-reviewer.js';
export function attachNightlyHost(ctx,adapter){
  const nightly=adapter.nightly;
  ctx.inject(['sessionPersistence','llm','agentDefaultModel','jobs','agents'],bound=>{
    const service=name=>bound.get?.(name)??bound[name];
    const agents=service('agents'),jobs=service('jobs'),llm=service('llm'),model=service('agentDefaultModel');
    // The public registry admits unowned Host work only while a Host controller
    // is attached. Agent-local tool-jobs controllers do not cover this scope.
    bound.effect(()=>jobs.attachController('ai-friend:nightly'),'ai-friend: nightly job controls');
    nightly.bind({
      persistence:service('sessionPersistence'),
      socialMaintenance:(runId,signal)=>adapter.platforms?.socialMemory?.maintain(runId,signal),
      foregroundBusy:()=>adapter.attention?.enabled()?false:Boolean(adapter.activities?.active)||agents.list().some(agent=>eligibleHeader(agent.session?.header,nightly.preview.workspace)&&(agent.status==='running'||agent.inbox?.nextTurn?.length||agent.inbox?.nextStep?.length)),
      startJob:spec=>jobs.start({kind:'friend-maintenance',label:'增量记忆整理',outputLimitBytes:2048,...spec}),
      repairPreview:(request,signal,onProgress)=>{
        const route=model.currentSelection();if(request.route&&(request.route.provider!==route.provider||request.route.model!==route.model))throw Object.assign(Error('预演模型路由已变化，未发起旧路由纠正'),{code:'PREVIEW_ROUTE_CHANGED'});
        return repairPreview(llm,undefined,request,signal,{route,maxTokens:nightly.preview.config.maxTokens,onProgress});
      },
      review:(role,snapshot,signal,onProgress)=>{
        const route=model.currentSelection();
        return role==='preview'?reviewPreview(llm,undefined,snapshot,signal,{route,maxTokens:nightly.preview.config.maxTokens,onProgress}):reviewApplication(llm,undefined,snapshot,signal,{route,maxTokens:nightly.applications.config.backgroundMaxTokens,onProgress});
      },
    });
    bound.on('session/event',(session,event)=>{
      if(eligibleHeader(session.header,nightly.preview.workspace)&&['turn/start','user/message','turn/end'].includes(event.type))nightly.foreground();
    },{global:true});
    bound.effect(()=>{
      const tick=()=>nightly.drive().catch(error=>{nightly.lastDriveError=String(error?.message??error).slice(0,250);});
      const timer=setInterval(tick,nightly.config.tickSeconds*1000);timer.unref?.();
      return async()=>{clearInterval(timer);await nightly.close();};
    },'ai-friend: durable nightly memory coordinator');
  });
}
