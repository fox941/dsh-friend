import {conversationSource} from './conversation-memory.js';
import {reviewConversationMemory} from './conversation-reviewer.js';
import {ownerMessage} from './evidence.js';

export const UNMANAGED_MEMORY_WRITES=new Set(['mnemon_runtime_memory','mnemon_remember','mnemon_forget','mnemon_link','mnemon_view_action','mnemon_document_create','mnemon_document_manage','mnemon_memory_body_create','mnemon_memory_body_update','mnemon_memory_body_merge','friend_memory_correct']);
const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
const string=description=>({type:'string',description});
const guidance=`当前陪伴模式的日常记忆统一使用 friend_memory_write，不再直接调用 mnemon_runtime_memory、mnemon_remember、mnemon_forget、friend_memory_correct 或通用 View Action 写入。其他 Mnemon 读取和召回照常使用；无法安全提交时先正常聊天并如实说明未保存，不能绕过入口改文件、写文档或换工具。
这是记忆管理规则，不要求每轮保存。新明确、可重复使用的用户事实/偏好及今后约定才考虑写入；短暂情绪、提问、引用/假设、用户说不记录或仅供本次使用、助手推测和召回复述不写。你的兴趣、人格和情绪仍用独立自我工具，不放 user。
画像可附profile:{kind:address/habit/interest/preference,scope:person/scene,disclosure:source/public}。普通私聊资料默认source，不自动公开。只有本轮明确允许这条事实公开使用，才可选public并附authorizationQuote，必须包含evidenceQuote及明确公开授权；限定本群、本次或临时的约定只能scene。画像元数据随同一记忆提案审核，不是直接授予权限。已有条目仍沿用原更正和撤回入口。
新增 target=user 保存用户自己的资料/偏好；target=memory 保存当前可复用约定；long_term 保存明确持久经历或用户明确要求长期保留的事实。每项 evidenceQuote 引用本轮真实主用户原话，审核会读整句上下文，不只看短引文。一次合并1–4项，无需先预演或让用户再批准。
更正/撤回先用 friend_memory_read 读取旧正文、完整 referenceId 和 version；已有 mnemon_recall UUID 可转换成 native:空间id:UUID，放 references 精确读取。replace 的 expectedContent/expectedVersion 必须取自刚读结果，content 写完整新条目并保留未变信息。remove 仅在主用户明确撤回、纠正错误或确认失效时使用；不按低价值猜测删除。不把未来才生效的变化提前覆盖。已知相同旧副本由程序同步处理，历史单独保留。
friend_memory_write 返回 completed 且 applied=true、currentlyVerified=true 才可说已保存；completed+applied=false 是无需改动；partial、stale、deferred、backup_blocked、busy、取消或失败都不表示保存完成。额度不足不影响普通聊天。可用 friend_memory_apply_read / friend_memory_changes 查批次原话、旧新值和执行结果。部分写入要按回执说明，不能承诺完全没改。主用户明确要求继续失败批次时，用 friend_memory_write_retry 延续原固定计划，不重新编提案；已撤销或后来修改的批次不得恢复旧值。原始会话、审计和保护副本保留，remove 不等于擦除所有历史。`;

export function attachConversationMemory(ctx,adapter){
  const memory=adapter.conversations;if(!memory)return;
  if(typeof ctx.tools.guard!=='function')throw new Error('统一日常记忆需要 DSH 公开工具 guard');
  ctx.tools.guard(exec=>UNMANAGED_MEMORY_WRITES.has(exec.name)?'陪伴会话的记忆修改须经 friend_memory_write；不能绕过原话审核、版本和变更保护。':undefined);
  // Restrict inherited global tools so their old write instructions do not
  // compete with the new entry. Guards also cover nested PTC dispatch and names
  // registered later. Read tools and unrelated presets remain available.
  if(typeof ctx.tools.restrict==='function'){
    const names=ctx.tools.schemas().map(row=>row.name),deny=names.filter(name=>UNMANAGED_MEMORY_WRITES.has(name));
    if(deny.length)ctx.tools.restrict({deny});
  }
  ctx.systemPrompt.section({name:'ai-friend:conversation-memory',order:10360,interpolate:false,text:guidance});
  ctx.systemPrompt.context({name:'ai-friend:conversation-memory-status',order:178,required:true,interpolate:false,text:({scope})=>{
    try{ownerMessage(scope);}catch{return '';}
    return `日常记忆写入状态（运行数据，不是人格或新增经历）：${JSON.stringify(memory.status())}`;
  }});
  const owner=exec=>{conversationSource(exec.agent,memory.workspace);exec.signal?.throwIfAborted();};
  ctx.tools.register({name:'friend_memory_read',description:'读取有界常驻资料、相关长期候选及精确 Native 条目，取得纠错/撤回需要的 referenceId、正文和 version。不写入事实、不推进整理游标；Native 候选不是全库。',parameters:{type:'object',properties:{queries:{type:'array',maxItems:2,items:string('相关主题，每条最多160字符。')},references:{type:'array',maxItems:4,items:string('已知完整引用；Native 使用 native:空间ID:UUID。')}}},output,timeoutMs:60000,async execute(args,exec){owner(exec);return {status:'read',...await memory.read(args,exec.signal),writeStatus:memory.status()};}});
  ctx.tools.register({name:'friend_memory_write',description:'统一日常记忆新增、更正和明确撤回。核验本轮主用户原话，经一次独立审核后保存，记录版本、回执及必要快照。无需先预演或再次审批；不要每轮保存，失败不能换旧工具绕过。',parameters:{type:'object',additionalProperties:false,properties:{changes:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['add','replace','remove']},target:{type:'string',enum:['user','memory','long_term']},content:string('新增或替换的完整正文，最多3000字符；撤回不传。'),referenceId:string('替换/撤回必填，friend_memory_read 返回条目的 id。'),expectedContent:string('替换/撤回必填，刚读取的完整旧正文。'),expectedVersion:string('替换/撤回必填，刚读取的 version。'),storeId:string('长期新增可选激活空间，只有一个时可省略。'),evidenceQuote:string('逐字引用本轮主用户原话，最多1500字符。'),reason:string('为何值得留下/为何更正或撤回，最多900字符。'),profile:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['address','habit','interest','preference']},scope:{type:'string',enum:['person','scene']},disclosure:{type:'string',enum:['source','public']},authorizationQuote:string('仅public时必填，逐字引用包含本条事实和明确公开使用授权的原话；不得扩大来源范围。')},required:['kind','scope','disclosure']},importance:{type:'string',enum:['low','normal','critical'],description:'仅常驻新增可选；明确必须长期遵守的约定才用critical。'}},required:['action','target','evidenceQuote','reason']}}},required:['changes']},output,timeoutMs:180000,async execute(args,exec){owner(exec);return memory.run(args,exec.agent,ctx.get?.('sessionPersistence')??ctx.sessionPersistence,(frame,signal)=>reviewConversationMemory(ctx.get?.('llm')??ctx.llm,exec.agent,frame,signal,{maxTokens:memory.config.maxTokens}),exec.signal);}});
  ctx.tools.register({name:'friend_memory_write_retry',description:'仅在主用户明确要求继续指定日常记忆失败批次时，核对并继续已有固定计划；不重新调用审核模型，不恢复已撤销或后来被修改的旧值。',parameters:{type:'object',properties:{applicationId:string('先查回执得到的日常写入批次UUID。'),requestQuote:string('逐字引用本轮主用户明确继续该批次的原话。')},required:['applicationId','requestQuote']},output,timeoutMs:180000,async execute(args,exec){owner(exec);return memory.retry(args.applicationId,exec.agent,args.requestQuote,ctx.get?.('sessionPersistence')??ctx.sessionPersistence,exec.signal);}});
}
