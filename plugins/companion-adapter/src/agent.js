import {attachWorkshop} from './workshop-agent.js';
import {attachPersonProfiles} from './person-profiles-agent.js';
import {attachRecall} from './recall-agent.js';
import {attachReplyIntegrity} from './reply-integrity.js';
import {attachPlatforms} from './platform-agent.js';
import { userEvidence, ownerMessage } from './evidence.js';
import { attachGrowth } from './growth-agent.js';
import { attachPreview } from './preview-agent.js';
import { attachApplications } from './apply-agent.js';
import { attachNightly } from './nightly-agent.js';
import {attachProtection} from './protection-agent.js';
import {attachConversationMemory} from './conversation-agent.js';
import {attachQQAgent} from './qq-agent.js';
import {attachAttentionAgent} from './attention-agent.js';
import {attachGoals} from './goal-agent.js';
import {attachProactive} from './proactive-agent.js';
// B站工具（friend_bilibili_*、friend_activity_*、friend_browsing_*、friend_video_*）
// 已随功能迁入 @ai-friend/bilibili-tool 的 /agent 子模块，由 preset 挂载点独立注册。

export const name='ai-friend-companion-interaction';
export const inject=['tools','systemPrompt'];
const guidance=`以下是交互和运行规则，不规定个人名字、性格、关系或情绪。
尊重用户要求的详略。普通闲聊默认一到三句；用户只想聊天时先回应内容，不自动转成建议清单或工作计划。用户要求详细说明时再展开。用户说“简短确认”时，成功回执只用一句话确认必要结果；不要附带解释、表格、总结或建议。语言风格可以随交流发展，这些是信息展示规则，不是固定性格。
记忆写入必须以真实工具结果为准；未完成、失败或待重试时不要说已保存。工具返回的技术字段只供操作和核验，不要求在回答中逐项复述。写入成功且可读回时，未生成嵌入不是普通聊天需要主动报告的异常。不要主动报告技术 ID、存储域代号、文件名、路径、向量/索引状态或内部调用过程；用户明确排查技术问题或确实影响这次使用时再解释。工具详情保留在回合工具记录、记忆栏和记忆管理页。
明确更正当前长期事实时：先召回当前条目的完整 UUID 和原文，再调用 friend_memory_correct，evidenceQuote 必须逐字引用本轮主用户原话；newContent 是完整替代条目，只写当前有效事实并保留未被更改的信息，旧值和更改过程由工具历史保留。不能仅追加一句“旧的作废”就宣布结构化纠错完成。常驻用户画像或工作记忆中的旧事实使用 mnemon_runtime_memory 同步更正；它们与长期空间是不同来源。尚未生效的未来变化不要提前停用当前事实，语义不清时再询问。
日常问题采用当前有效记录。用户问以前如何约定、更改了几次时，可以用 friend_memory_history 查看历史。历史中的 previous 是过去版本，不能当成现行事实。
自身能力以本轮工具和运行快照为依据。已保存资料可以在本实例相同存储域的会话间共享，不要声称换会话就必然丢失。旧聊天原文没有自动全部进入长期记忆。向普通用户解释这一点时只需两句，不复述快照中的工具、目录和空间清单。快照不包含所有已保存资料的数量和正文，未实际查询时不要声称库是空的，也不要断言某件事“从没存过”“没有任何相关记录”。当前资料不足时可以直接说“我不知道，当前没找到相关信息”，不必为表达不知道而强制查询。查询无命中也只说明本次未找到，不证明所有历史和存储域都没有。工具不可用或额度用完时保留这种不确定性，不自动扩大权限、查询次数或写入记忆。有工具不等于做过动作；没有真实执行回执时不要声称已浏览或观看。找不到共同经历时直接说明不知道或未找到记录，不展开介绍检索过程。对用户的感受可以理解和回应，但不要编造自己的身体经历或共同往事。`;
const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],presentationMeta:(_args,value)=>({friendAdapter:{status:value.status??'read',summary:value.summary??'陪伴运行记录'}})};
const str=(description)=>({type:'string',description});
export function apply(ctx) { ctx.inject(['friendAdapter'],bound=>attach(bound)); }
function attach(ctx) {
  const adapter=ctx.friendAdapter;
  const rules=adapter.conversations?guidance.replace(/明确更正当前长期事实时：[\s\S]*?语义不清时再询问。/,'日常事实保存、更正和撤回遵循后面的统一记忆写入规则，使用 friend_memory_read / friend_memory_write；不能使用旧入口绕过审核和保护。'):guidance;
  ctx.systemPrompt.section({name:'ai-friend:interaction',order:10300,interpolate:false,text:rules});
  const capabilities=(agent)=>{
    const policy=adapter.policy();
    const names=ctx.tools.schemas(agent).map(tool=>tool.name).sort();
    return {configuredChannels:adapter.configuredChannels,visibleTools:names.slice(0,80),visibleToolCount:names.length,
      savedMemorySharing:names.some(name=>name.startsWith('mnemon_'))?'本实例同一存储域内，共享已实际保存的用户画像和激活空间资料；实际可用性以工具回执为准，旧会话全文不会自动全量进入上下文。':'当前未发现可见的 Mnemon 记忆工具，不承诺可以存取共享记忆。',
      adapterReady:policy.enabled,adapterWritesAllowed:policy.writeEnabled,adapterIssue:policy.issue,
      activeNativeSpaces:policy.spaces.filter(space=>space.active).map(space=>({id:space.id,name:space.name,hasSavedRecords:adapter.client.presence(space.id)})),
      savedContentBoundary:'hasSavedRecords=true 证明该激活长期空间存在有效记录，false 表示检查时为空，null 表示未知。常驻画像为空不代表长期资料为空，也不能据此宣称换会话后所有资料都会消失。这不证明记录均为真实用户个人资料；具体内容必须召回核对。',
      pendingCorrections:adapter.status(),
      workshop:adapter.workshop?.status()??null,
      conversationMemory:adapter.conversations?.status()??null,socialExperience:adapter.socialExperience?.status()??null,
      qq:adapter.qq?.status()??null,
      bilibiliInbox:adapter.bilibiliInbox?.status()??null,
      activities:adapter.activities?((({recent,...brief})=>brief)(adapter.activities.status())):null,
      growth:adapter.growth?{enabled:adapter.growth.config.enabled,revision:adapter.growth.store.revision(),reviewCallsRemaining:adapter.growth.read().reviewCallsRemaining}:null,
      nightly:adapter.nightly?{enabled:adapter.nightly.store.enabled(),hostReady:Boolean(adapter.nightly.host),running:Boolean(adapter.nightly.active),time:adapter.nightly.config.time,timeZone:'Asia/Shanghai'}:null,
      memoryApplication:adapter.applications?{enabled:adapter.applications.config.enabled,automatic:false,pending:adapter.applications.status().recent.filter(row=>['partial','interrupted','cancelled'].includes(row.status)).length}:null,
      memoryPreview:adapter.preview?{enabled:adapter.preview.config.enabled,previewOnly:true,automatic:false,callsRemaining:adapter.preview.status().callsRemaining}:null,
      recentExternalToolExecutions:agent?adapter.journal.actions(agent.id):[],
      observationBoundary:'执行回执仅证明对应工具调用的结果；不能据此宣称完整观看视频。未列工具仍以本轮实际工具声明为准。'};
  };
  ctx.systemPrompt.context({name:'ai-friend:capabilities',order:150,required:true,interpolate:false,text:({scope})=>`当前运行事实（由程序读取配置和工具注册表，不是人格记忆）：\n${JSON.stringify(capabilities(scope))}`});
  ctx.systemPrompt.context({name:'ai-friend:presentation',order:20000,required:true,interpolate:false,text:({scope})=>{
    let message;
    try{message=ownerMessage(scope);}catch{return '';}
    const request=(message.data.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
    if(!/简短|简单回答|简单确认|两句|一句|直接说/.test(request))return '';
    return '本轮用户明确要求简短：最终回答只给所问的结论，控制在一到两句、120个中文字符以内，不使用表格、分层说明、清单或补充建议。普通成功记忆写入只确认已保存的内容；向量/嵌入未生成但记录已成功保存且可读回时，不主动报告索引字段。解释记忆共享时只说已保存资料可跨会话召回、旧聊天全文不会自动带入；当前热记忆为空只说明当前为空，不能推断从未写入。保留真实的失败或未完成说明。此要求仅约束本轮展示，不改变记忆操作步骤，也不规定角色性格。';
  }});
  const owner=(exec)=>{
    ownerMessage(exec.agent);
    return exec.agent;
  };
  if(adapter.socialExperience)ctx.tools.register({name:'friend_social_experience_read',description:'只读查看QQ群、好友和空间经历的自我评价、聊天临时感受提案、独立审核及状态变更回执。评价完成不代表一定发生变化。',parameters:{type:'object',properties:{id:str('已知评价或聊天情绪任务完整ID，可省略')},additionalProperties:false},output,execute:async(args,exec)=>{owner(exec);return args.id?adapter.socialExperience.immediate?.read(args.id)??adapter.socialExperience.read(args.id):adapter.socialExperience.status();}});
  if(!adapter.conversations)ctx.tools.register({name:'friend_memory_correct',description:'更正当前有效的本地长期事实。先召回完整 UUID 和原文。核验新条目后停用旧条目，历史另存，失败可重试。仅限主用户本轮明确更正；未来生效的变化不要提前作废当前事实。',
    parameters:{type:'object',properties:{storeId:str('已知的激活空间 ID；仅一个激活空间时可省略。'),factKey:str('首次更正可给稳定事实键；后续自动沿用。'),oldId:str('被替代记录的完整 UUID。'),expectedOldContent:str('召回所得完整原文，用于防止过期覆盖。'),newContent:str('完整的新条目，保留未更改的内容。'),evidenceQuote:str('逐字引用本轮主用户明确更正的原话。'),reason:str('这次更正的简要依据。')},required:['oldId','expectedOldContent','newContent','evidenceQuote']},output,timeoutMs:60000,
    async execute(args,exec){const agent=owner(exec);return adapter.correct(args,userEvidence(agent,args.evidenceQuote),exec.signal);}
  });
  ctx.tools.register({name:'friend_memory_history',description:'查看本实例的长期事实更正历史。历史是过去版本，不是现行事实。可用当前记录 UUID 查整条更正链；也可列最近几次更正。',
    parameters:{type:'object',properties:{storeId:str('已激活的 Native 空间 ID，只有一个时可省略。'),factKey:str('已知事实键。'),recordId:str('已知的完整旧/新记录 UUID，用于查更正链。'),limit:{type:'integer',description:'1–10，默认5。'}}},output,
    async execute(args,exec){owner(exec);exec.signal.throwIfAborted();return {status:'read',history:adapter.history(args.storeId,args.factKey,args.limit??5,args.recordId)};}
  });
  ctx.tools.register({name:'friend_capabilities',description:'查询当前会话的实际工具、已配置渠道、记忆共享边界和纠错状态。不要把可用工具误当成已执行活动。',parameters:{type:'object',properties:{}},output,
    async execute(_args,exec){owner(exec);return {status:'read',...capabilities(exec.agent)};}
  });
  ctx.on('tools/result',(exec,result)=>{
    if(exec.agent && /^(?:bili|douyin|web_|browser_|bsk_|mcp__.*(?:browser|bili|douyin))/.test(exec.name))adapter.journal.action(exec.callId,exec.agent.id,exec.name,!result.isError);
  });
  attachGrowth(ctx,adapter);
  attachPreview(ctx,adapter);
  attachApplications(ctx,adapter);
  attachNightly(ctx,adapter);
  attachProtection(ctx,adapter);
  attachConversationMemory(ctx,adapter);attachPersonProfiles(ctx,adapter);attachRecall(ctx);attachReplyIntegrity(ctx,adapter);
  attachQQAgent(ctx,adapter);attachPlatforms(ctx,adapter);
  attachAttentionAgent(ctx,adapter);
  attachGoals(ctx,adapter);
  attachProactive(ctx,adapter);attachWorkshop(ctx,adapter);
}
