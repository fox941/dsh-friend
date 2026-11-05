import {ownerMessage} from './evidence.js';
function protect(adapter,agent){for(let seq=agent.session.seq-1;seq>=Math.max(0,agent.session.seq-1000);seq--)if(agent.session.eventAt(seq)?.type==='turn/start'){adapter.preview.protectTurn(agent,seq);return;}throw new Error('无法核验变更查询回合边界');}
export function attachProtection(ctx,adapter){
  if(!adapter.protection)return;
  const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
  ctx.systemPrompt.section({name:'ai-friend:protection',order:10350,interpolate:false,text:'friend_memory_changes 查询整理应用的旧值、新值、原话依据、受影响自我状态和真实回执，可按需生成本地 HTML。历史旧值不能当现行事实；查看和反复总结不增加经历或支持。checkUndo 检查能否在停机后撤销，会扫描相关长期库；默认只查看。ready_offline 只是预检通过，执行时仍须停机并重新核验。当前没有聊天中自动覆盖数据库的撤销工具，不能绕过检查用记忆写入工具模拟撤销。后续自我变化或长期库任何变化会保守阻止撤销。原始聊天保留，旧批次没有前置快照时不承诺可撤销。备份失败 backup_blocked 代表本批停止写入，不要另用其他工具代写。'});
  ctx.tools.register({name:'friend_memory_changes',description:'查询一个整理应用批次的变更对比、原话、自我影响、快照与撤销条件；可导出可展开查看的静态 HTML，不调用审核模型。',parameters:{type:'object',properties:{applicationId:{type:'string',description:'应用批次 UUID，省略读取最近一次。'},includeSources:{type:'boolean',description:'需要核对原始交流时展开正文。'},checkUndo:{type:'boolean',description:'核验停机撤销条件，会读取相关长期库。'},html:{type:'boolean',description:'生成本地静态变更报告，含历史与当前状态标注。'}}},output,timeoutMs:60000,async execute(args,exec){ownerMessage(exec.agent);exec.signal?.throwIfAborted();protect(adapter,exec.agent);return adapter.protection.changes(args.applicationId,args,exec.signal);}});
}
