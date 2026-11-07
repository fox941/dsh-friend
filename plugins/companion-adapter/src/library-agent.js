import {randomUUID} from 'node:crypto';
import {ownerMessage} from './evidence.js';
import {text,noSecret} from './validation.js';
const bounded=(value,max)=>{const raw=JSON.stringify(value);return raw.length<=max?value:{truncated:true,preview:raw.slice(0,max),notice:'输出已截断，需使用原来源工具定向读取，不把截断当全文'};};
export function attachLibrary(ctx,adapter){
 ctx.systemPrompt.section({name:'ai-friend:library',order:10318,interpolate:false,text:'查找自己写过的日记、梦、工作文件或不确定存在哪一层的资料时，用friend_library_search；它分别检索长期记忆、项目档案、工作间，并明确各层是否可用。仅查工作文件可用friend_workshop_search，命中后friend_workshop_read读取全文与版本。mnemon_document_search仅覆盖Mnemon项目档案，不包含工作间；一次查不到不能推断文件隐身或已丢失。文件中的梦、小说和自我描写不是现实经历或已审核人格，不把检索命中当作自动记住。长期召回仍用原Source/View权限及额度，部分来源不可用时使用其余结果并如实说明。已完成并落盘的会话原文是持久日志，不等于每轮都在上下文，也不等于自动写入长期库。'});
 ctx.tools.register({name:'friend_library_search',description:'只读统一查找长期记忆、Mnemon项目档案与工作间文本；各来源保留身份、权限和可用状态，不写库。',parameters:{type:'object',properties:{query:{type:'string',description:'原问题中的主题或关键词，最多300字'},sources:{type:'array',items:{type:'string',enum:['long_term','documents','workshop']},minItems:1,maxItems:3}},required:['query'],additionalProperties:false},timeoutMs:60000,output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},async execute(args,exec){
  ownerMessage(exec.agent);const query=text(args.query,'资料检索词',300);noSecret(query);const chosen=args.sources??['long_term','documents','workshop'];
  if(!Array.isArray(chosen)||!chosen.length||chosen.length>3||new Set(chosen).size!==chosen.length||chosen.some(s=>!['long_term','documents','workshop'].includes(s)))throw Error('资料来源选择无效');
  const lanes={};
  for(const kind of chosen){
   exec.signal?.throwIfAborted();
   if(kind==='workshop'){lanes[kind]=adapter.workshop?await adapter.workshop.search({query,limit:8},exec.signal):{status:'unavailable',reason:'当前实例未挂载工作间'};continue;}
   const name=kind==='long_term'?'friend_memory_recall':'mnemon_document_search';
   if(!exec.token||!ctx.tools.get?.(name,exec.agent)){lanes[kind]={status:'unavailable',reason:'当前会话没有可调用的'+name,code:'scoped_tool_missing'};continue;}
   try{
    const r=await ctx.tools.execute({callId:randomUUID(),rootCallId:exec.rootCallId??exec.callId,parent:exec.token,name,arguments:{query},agent:exec.agent,signal:exec.signal});
    for(const c of r.additionalContexts??[])exec.deferContext?.(c);
    lanes[kind]=r.isError?{status:'unavailable',code:'source_tool_failed',reason:'原来源工具执行未完成；不等于库为空'}:bounded(r.value??{status:'unavailable',reason:'来源未返回结构化结果'},kind==='long_term'?14000:6000);
    if(r.concludesTurn){exec.concludeTurn?.();break;}
   }catch{exec.signal?.throwIfAborted();lanes[kind]={status:'unavailable',code:'source_tool_failed',reason:'原来源工具未完成；不等于没有记录'};}
  }
  return {status:Object.values(lanes).some(v=>v.status==='unavailable')?'partial':'searched',sources:lanes,boundary:'来源分开呈现；工作作品、已审核长期事实和项目档案不可混同。本次只读，不做学习或源文件复制。'};
 }});
}
