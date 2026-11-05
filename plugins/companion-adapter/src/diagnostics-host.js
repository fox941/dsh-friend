import {isAgentLoopRequest} from '@deepseek-ai/dsh-llm';
import {diagnosticContext} from './diagnostic-context.js';
import {eligibleHeader} from './preview-sessions.js';
export function attachDiagnosticsHost(ctx,adapter){
  const diagnostics=adapter.diagnostics;if(!diagnostics?.enabled)return;
  ctx.inject(['llm','agents'],bound=>{
    const agents=bound.get?.('agents')??bound.agents;
    bound.on('llm/stream',(options,next)=>{
      const tag=diagnosticContext(),agent=options.sessionId?agents.get(options.sessionId):null;
      if(!tag&&!eligibleHeader(agent?.session.header,adapter.workspace))return next();
      return diagnostics.observe(options,next,tag??{stage:isAgentLoopRequest(options)?'expression':'session_other',intentIds:[]});
    },{global:true});
    bound.on('session/event',(session,event)=>{if(eligibleHeader(session?.header,adapter.workspace)&&['tool/call','tool/result'].includes(event.type))diagnostics.sessionEvent(session,event);},{global:true});
    bound.effect(()=>{const timer=setInterval(()=>diagnostics.cleanup(),3600000);timer.unref?.();return ()=>clearInterval(timer);},'ai-friend: passive runtime diagnostics');
  });
}
