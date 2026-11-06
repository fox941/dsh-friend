import {AsyncLocalStorage} from 'node:async_hooks';
const context=new AsyncLocalStorage();
export function diagnosticStage(label){
  if(label==='全局行为选择')return 'selection';
  if(label==='情绪评价')return 'emotion';
  if(label==='自主反思'||label==='自主工作')return 'reflection';
  if(label==='长期目标规划')return 'goal';
  if(label?.startsWith('主动QQ'))return 'proactive';
  if(label==='B站交流')return 'expression';
  if(label==='成长审核')return 'growth';
  if(label?.startsWith('活动'))return 'activity';
  return 'memory';
}
export function withDiagnosticContext(label,snapshot,fn){
  const candidates=snapshot?.candidates??[];
  const ids=[...candidates.map(x=>x.id),snapshot?.source?.origin?.intentId].filter(x=>typeof x==='string'&&/^[\w:.-]{1,180}$/.test(x)).slice(0,32);
  return context.run({stage:diagnosticStage(label),intentIds:ids},fn);
}
export const diagnosticContext=()=>context.getStore();
