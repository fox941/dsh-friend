import {ownerMessage,userEvidence} from './evidence.js';
import {reviewApplication} from './apply-reviewer.js';
import {uuid} from './validation.js';
function turnStart(agent){for(let seq=agent.session.seq-1;seq>=Math.max(0,agent.session.seq-1000);seq--){if(agent.session.eventAt(seq)?.type==='turn/start')return seq;}throw new Error('本轮应用请求边界不可核对');}
const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
export function attachApplications(ctx,adapter){
  const app=adapter.applications;if(!app)return;
  ctx.systemPrompt.section({name:'ai-friend:memory-application',order:10330,interpolate:false,text:'friend_memory_apply 仅在主用户明确要求应用某份已完成的预演报告时调用。先用预演报告查询核对 id 和提案，requestQuote 逐字引用本轮应用请求；未指定范围时处理该报告全部提案。它会重新核对来源、旧值、时效和条件，审核后执行有限步骤；不是照搬报告。待定、冲突、未来生效项可能保留，不应绕过应用审核自行调用其他写入工具。预演回合仍只读，应用在之后独立的请求中执行。completed 表示所选项已核对完成，partial/cancelled/interrupted 有待处理步骤，historical 表示过去完成但当前目标已变；不能一概说全部已保存。状态复核只标为待核对，不设置新人格、不增加独立支持数。应用工具执行后本回合只允许查询和报告。通过 friend_memory_apply_read 查询原话、步骤、历史与当前核对；重复应用同一报告和相同序号优先核对原回执，不重新提交旧值。'});
  ctx.tools.register({name:'friend_memory_apply',description:'按主用户明确请求应用指定记忆整理报告，重新审核并逐步验证更正、补充或工作事项转存；保留原始依据和历史，失败可按原回执重试。仅支持现有 Runtime/Native，相关自我状态只进入待复核。',parameters:{type:'object',properties:{reportId:{type:'string',description:'已经查看过的已完成预演报告 UUID。'},requestQuote:{type:'string',description:'逐字引用本轮主用户明确要求应用该报告的原话。'},proposalIndexes:{type:'array',minItems:1,maxItems:8,items:{type:'integer',minimum:0},description:'可选，只处理明确选择的提案序号；省略时处理全部。'}},required:['reportId','requestQuote']},output,timeoutMs:180000,
    async execute(args,exec){
      const approval=userEvidence(exec.agent,args.requestQuote);approval.turnStart=turnStart(exec.agent);adapter.preview.protectTurn(exec.agent,approval.turnStart);
      return app.run(args,approval,ctx.get?.('sessionPersistence')??ctx.sessionPersistence,(frame,signal)=>reviewApplication(ctx.get?.('llm')??ctx.llm,exec.agent,frame,signal,{maxTokens:app.config.maxTokens}),exec.signal);
    }
  });
  ctx.tools.register({name:'friend_memory_apply_read',description:'查询提案应用回执、原始引用、已完成及待处理步骤，并核对目标是否仍为当前值；历史完成不代表可以重放旧值。不发起应用模型审核。',parameters:{type:'object',properties:{applicationId:{type:'string',description:'应用 UUID；省略时读取最近一次。'}}},output,timeoutMs:60000,
    async execute(args,exec){ownerMessage(exec.agent);exec.signal?.throwIfAborted();if(args.applicationId)uuid(args.applicationId);return {...await app.read(args.applicationId,exec.signal),applicationStatus:app.status()};}
  });
  ctx.systemPrompt.context({name:'ai-friend:pending-memory-application',order:175,required:true,interpolate:false,text:({scope})=>{
    try{ownerMessage(scope);}catch{return '';}
    const pending=app.store.recent().filter(row=>['partial','cancelled','interrupted','applying'].includes(row.status));
    return pending.length?`存在尚未完全核对的记忆应用。不要把整组提案当成全部完成；需要相关事实时查询应用回执，暂停相关自我认识。以下只是执行状态，不是新增经历：\n${JSON.stringify(pending)}`:'';
  }});
}
