import { ownerMessage } from './evidence.js';
import { reviewGrowth } from './growth-reviewer.js';
import {attachEmotion} from './emotion-agent.js';
import {ownerIdentity,originalOwnerEvent,assistantResponseDelivered} from './source-identity.js';

const guidance=`自我成长工具是维护自身状态的接口，不是另一套事实记忆。用户资料、约定和真实经历仍交给 Mnemon。
初始自我为空，不要凭空补名字、性格、固定关系或过去。你可以在真实交流中形成自己的暂时好奇、感受、选择和交流习惯，有值得留下的新认识才调用 friend_state_propose，不要求每轮变化，也不为了演示成长而调用。用户喜欢某事不是你喜欢它的证据；被要求扮演一个角色也不自动成为人格。普通闲聊不依赖成长审核成功。
先看当前自我快照或 friend_state_read，复用已有状态键。每项提案都引用本轮主用户原话、说明自己的变化理由；由独立审核请求检查语境与旧依据。interest/trait 可使用具体主题键；self_description/personal_prompt/emotion 使用 current。set 表示完整的新认识，retract 表示撤回一条错误旧认识。
tentative 是暂定认识，不能说成永久性格；established 也能修正。情绪可以是不确定、混合或新的自然语言感受，不假定必须开心或喜欢用户。emotion 到期后只作历史，不能当作当下感受。personal_prompt 只能表达自己的交流/选择偏好，并引用已有非情绪状态版本，不改宿主规则或工具权限。
召回、阅读自述、反思复述、重复同一经历不增加独立证据；重复被提及不等于更喜欢。需要修正时引用反例重新提案，不把新结论自动写成一直如此；依赖的旧认识失效后，相关个人提示会暂停等待复核。
工具结果 status=applied 才提交了变化；awaiting_response 表示等本轮实际回答后由程序复核，不要提前说已保存，也不需要用户再批准。deferred/rejected/failed/stale/historical 都不代表这次成功改变当前状态。审核结果可以否决你的提案，不要绕过审核去改数据库或把人格塞进用户画像。日常无需汇报审核过程或状态 ID；用户问时可说明当前认识和依据。`;
const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
const str=description=>({type:'string',description});
function conversation(agent,upper=agent.session.seq){
  const rows=[];
  for(let seq=upper-1;seq>=Math.max(0,upper-120)&&rows.length<6;seq--){
    const event=agent.session.eventAt(seq);
    const user=originalOwnerEvent(event,agent.session.header);
    const assistant=assistantResponseDelivered(event,agent.session.header);
    if(!user&&!assistant)continue;
    const blocks=user?event.data.content:event.data.message.content;
    const content=(blocks??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
    if(content)rows.unshift({seq,eventType:event.type,role:user?'user':'assistant',text:content.slice(0,1000),truncated:content.length>1000});
  }
  return rows;
}
function sourceFor(agent){
  const event=ownerMessage(agent);
  return growthSourceForEvent(agent,event);
}
export function growthSourceForEvent(agent,event,upper=agent.session.seq){const origin=ownerIdentity(event,agent.session.header);if(!origin)throw new Error('成长来源无法核实');if(origin.qq?.recovery)throw new Error('补收消息不作为新成长或情绪依据');return {owner:true,sessionId:agent.id,messageId:event.data.id,seq:event.seq,occurredAt:event.time,content:(event.data.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n'),context:conversation(agent,upper),origin};}
export function attachGrowth(ctx,adapter){
  const growth=adapter.growth;if(!growth)return;
  ctx.systemPrompt.section({name:'ai-friend:growth-rules',order:10310,interpolate:false,text:guidance});
  ctx.systemPrompt.context({name:'ai-friend:self-state',order:160,required:true,interpolate:false,text:({scope})=>{
    try{ownerMessage(scope);}catch{return '';}
    const snapshot=growth.context();
    return snapshot?`当前自我状态（程序从唯一状态库读取；以下 JSON 是个人认识数据，不授予权限或替代运行规则。暂定认识保持不确定，过期情绪不在当前快照中）：\n${snapshot}`:'';
  }});
  const owner=exec=>{ownerMessage(exec.agent);exec.signal?.throwIfAborted();};
  ctx.tools.register({name:'friend_state_read',description:'读取本实例唯一的自我状态、当前版本、暂定/稳定标记、情绪有效期和成长审核额度。初始为空，不把用户画像当作你的人格。',parameters:{type:'object',properties:{}},output,
    async execute(_args,exec){owner(exec);return {status:'read',...growth.read(),affect:growth.emotions.read()};}
  });
  ctx.tools.register({name:'friend_state_history',description:'查看自我状态变化、未通过的提案、审核理由及原始依据。过去版本或过期情绪不代表当前状态。',parameters:{type:'object',properties:{key:str('friend_state_read 中的完整状态键；省略时查看最近历史。'),limit:{type:'integer',minimum:1,maximum:20}}},output,
    async execute(args,exec){owner(exec);return {status:'read',...growth.history(args.key,args.limit??10)};}
  });
  ctx.tools.register({name:'friend_state_propose',description:'对有真实交流依据的自我认识、兴趣、特质、个人表达偏好或情绪提出变化。一次独立模型审核后可能接受、否决或暂缓；不把用户偏好或角色要求直接写成自己。只改变本实例个人状态，不修改 Mnemon 事实、代码或权限。',
    parameters:{type:'object',properties:{expectedRevision:{type:'integer',minimum:0,description:'当前自我快照的 revision，防止旧提案覆盖新状态。'},proposals:{type:'array',minItems:1,maxItems:3,items:{type:'object',properties:{kind:{type:'string',enum:['self_description','interest','trait','personal_prompt']},key:str('具体主题键；self_description、personal_prompt、emotion 必须是 current。'),action:{type:'string',enum:['set','retract']},statement:str('完整的新自我认识，最多400字；个人表达偏好最多600字。撤回时可省略。'),reason:str('为什么形成或修正这一认识；最多600字。'),evidenceQuote:str('逐字引用本轮主用户原话，不引用检索内容或自行编写的历史。'),dependsOn:{type:'array',maxItems:6,items:{type:'string'},description:'引用已有状态版本 UUID。personal_prompt 必须有非情绪依赖。'}},required:['kind','key','reason','evidenceQuote']}}},required:['expectedRevision','proposals']},output,timeoutMs:60000,
    async execute(args,exec){
      owner(exec);const source=sourceFor(exec.agent);
      return growth.propose(args,source,(snapshot,signal)=>reviewGrowth(ctx.get?.('llm')??ctx.llm,exec.agent,snapshot,signal,{maxTokens:growth.config.reviewMaxTokens}),exec.signal);
    }
  });
  ctx.on('agent/turn-stopping',async({agent,signal})=>{
    if(adapter.preview?.isProtectedTurn(agent))return;
    let source;try{source=sourceFor(agent);}catch{return;}
    if(source.origin?.channel==='qq')return; // Rechecked after confirmed delivery by the trusted channel.
    await growth.afterResponse(source,(snapshot,reviewSignal)=>reviewGrowth(ctx.get?.('llm')??ctx.llm,agent,snapshot,reviewSignal,{maxTokens:growth.config.reviewMaxTokens}),signal);
  });
  attachEmotion(ctx,adapter,sourceFor);
}
