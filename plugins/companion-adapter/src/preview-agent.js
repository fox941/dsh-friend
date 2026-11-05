import {ownerMessage,userEvidence} from './evidence.js';
import {reviewPreview,repairPreview} from './preview-reviewer.js';
import {UUID} from './validation.js';
function turnStart(agent){for(let seq=agent.session.seq-1;seq>=Math.max(0,agent.session.seq-1000);seq--){const event=agent.session.eventAt(seq);if(event?.type==='turn/start')return event.seq;}throw new Error('当前回合边界不可核对');}
const readOnly=new Set(['friend_memory_preview','friend_memory_preview_read','friend_memory_apply_read','friend_memory_read','friend_qq_status','friend_activity_status','friend_activity_read','friend_nightly_read','friend_memory_changes','friend_capabilities','friend_state_read','friend_state_history','friend_emotion_read','friend_emotion_history','friend_memory_history','mnemon_recall','mnemon_related','mnemon_document_search','mnemon_memory_bodies','run_code']);
const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
export function attachPreview(ctx,adapter){
  if(!adapter.preview)return;
  if(typeof ctx.tools.guard!=='function')throw new Error('预演要求 DSH 的公开工具写入拦截接口');
  ctx.tools.guard(exec=>{
    if(!exec.agent)return;
    let current;try{current=turnStart(exec.agent);}catch{if(adapter.preview.isProtectedTurn(exec.agent)&&!readOnly.has(exec.name))return '预演回合边界暂不可核对，只允许查询。';return;}
    if(exec.name==='friend_memory_preview')adapter.preview.protectTurn(exec.agent,current);
    if(adapter.preview.isProtectedTurn(exec.agent,current)&&!readOnly.has(exec.name))return '本回合执行记忆整理预演，只允许查询和报告；不能随后提交记忆或人格修改。';
  });
  ctx.systemPrompt.section({name:'ai-friend:memory-preview',order:10320,interpolate:false,text:'friend_memory_preview 只在主用户明确要求预演/试运行记忆整理时调用，不是每轮聊天都运行。它读取已完成的原始交流与相关旧资料，保存有来源的建议报告，不更新 Mnemon 或自我状态。requestQuote 逐字引用本轮请求；scope=current 默认只处理当前会话，companion 分批处理本实例陪伴会话。查询可给至多两个简短相关主题，不用为了填参数列全库。执行预演的回合只允许读取和报告，后续不能用其他工具应用提案；没有独立用户更正时也不应把预演建议保存成事实。completed 仅表示报告完成，stale/failed/cancelled 不表示已提交，no_new_events 不代表记忆库为空。正常回答只简述发现、待定和未修改；用户要求依据时可用 friend_memory_preview_read 查询报告及原始引用。'});
  ctx.tools.register({name:'friend_memory_preview',description:'按主用户明确请求预演整理已完成交流，核对新经历与相关旧记忆，保存带逐字引用的建议报告；不修改记忆、人格、兴趣或情绪。当前请求回合不作为新经历。',parameters:{type:'object',properties:{requestQuote:{type:'string',description:'逐字引用本轮主用户要求预演整理的原话。'},scope:{type:'string',enum:['current','companion'],description:'current 当前会话；companion 本实例直接陪伴会话，按进度分批。默认 current。'},queries:{type:'array',maxItems:2,items:{type:'string'},description:'可选的相关旧记忆主题，最多两条，每条160字符；不传时使用真实原话作为查询。'}},required:['requestQuote']},output,timeoutMs:180000,
    async execute(args,exec){
      userEvidence(exec.agent,args.requestQuote);const start=turnStart(exec.agent);adapter.preview.protectTurn(exec.agent,start);
      const llm=ctx.get?.('llm')??ctx.llm,options={maxTokens:adapter.preview.config.maxTokens};
      const reviewer=(snapshot,signal,onProgress)=>reviewPreview(llm,exec.agent,snapshot,signal,{...options,onProgress});
      reviewer.repair=(request,signal,onProgress)=>{
        const current=exec.agent.session?.requestHeader?.()?.config,route=current?.provider&&current?.model?current:exec.agent.options;
        if(request.route&&(request.route.provider!==route?.provider||request.route.model!==route?.model))throw Object.assign(Error('预演模型路由已变化，未发起旧路由纠正'),{code:'PREVIEW_ROUTE_CHANGED'});
        return repairPreview(llm,exec.agent,request,signal,{...options,route,onProgress});
      };
      return adapter.preview.run(args,{owner:true,sessionId:exec.agent.id,turnStart:start},ctx.get?.('sessionPersistence')??ctx.sessionPersistence,reviewer,exec.signal);
    }
  });
  ctx.tools.register({name:'friend_memory_preview_read',description:'查询已有记忆整理预演报告、原始引用和覆盖局限。报告仅为建议，不是新的真实经历或已应用的记忆修改。无需调用模型整理。',parameters:{type:'object',properties:{reportId:{type:'string',description:'已知报告 UUID；省略时读取最近一份。'},includeSources:{type:'boolean',description:'用户要求核对详细原始依据时设 true。'}}},output,
    async execute(args,exec){ownerMessage(exec.agent);exec.signal?.throwIfAborted();if(args.reportId&&!UUID.test(args.reportId))throw new Error('报告 ID 必须是完整 UUID');return {...adapter.preview.read(args.reportId,args.includeSources===true),previewStatus:adapter.preview.status()};}
  });
}
