import {ownerMessage,userEvidence} from './evidence.js';
import {ownerIdentity} from './source-identity.js';
const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
export function attachProactive(ctx,adapter){
  const proactive=adapter.proactive;if(!proactive)return;
  ctx.systemPrompt.section({name:'ai-friend:proactive',order:10440,interpolate:false,text:'同一角色可经统一注意力自主决定是否通过绑定主用户QQ分享真实阅读、目标进展、回忆或想法；不机械定时推送。主动发送不伪造用户消息。只有friend_proactive_status中published是OneBot已返回消息ID的实际发言，尚未发送、拒绝、未知回执都不能当作说过的话；确认发送也不表示对方已读。主动草稿过期或新消息/状态到来后重新判断，不补发旧稿。主用户可通过friend_proactive_control暂停、恢复或取消未发送机会。不要把自己的主动表达当成新增独立人格或事实证据。'});
  ctx.systemPrompt.context({name:'ai-friend:qq-published-initiatives',order:181,required:true,interpolate:false,text:({scope})=>{
    try{const event=ownerMessage(scope),identity=ownerIdentity(event,scope.session.header);if(identity?.channel!=='qq')return '';return JSON.stringify({actualProactivePublications:proactive.store.publications().map(({body,platform_id,at,source})=>({body,platformId:platform_id,at,sourceKind:source.kind,scope:source.scope})),boundary:'这些文字已由OneBot确认发送；无需因用户接着问而假装不知道自己刚分享的内容。不是用户说过的话，不证明已读。'});}catch{return '';}
  }});
  ctx.tools.register({name:'friend_proactive_status',description:'主用户只读查看主动QQ联系机会、暂停状态、未知回执和真实已发内容；不发送或重试。',parameters:{type:'object',properties:{query:{type:'string',maxLength:80,description:'可选，按关键词查询过去已经确认发送的主动发言'},limit:{type:'integer',minimum:1,maximum:20}}},output,async execute(args,exec){ownerMessage(exec.agent);exec.signal.throwIfAborted();return {status:'read',...proactive.status(args)};}});
  ctx.tools.register({name:'friend_proactive_control',description:'按主用户明确要求暂停、恢复主动QQ联系，或取消未发送的主动机会。不影响普通QQ聊天，不重发结果不明的消息。',parameters:{type:'object',properties:{action:{type:'string',enum:['pause','resume','cancel_pending']},requestQuote:{type:'string'}},required:['action','requestQuote'],additionalProperties:false},output,async execute(args,exec){
    const source=userEvidence(exec.agent,args.requestQuote),raw=ownerMessage(exec.agent).data.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),verbs={pause:'暂停|关闭|停止|别|不要',resume:'恢复|开启|继续|可以',cancel_pending:'取消|撤销|清除'}[args.action];
    if(args.action==='pause'&&/(?:不要|别|不需要).{0,8}(?:暂停|关闭|停止)/.test(raw)||args.action==='cancel_pending'&&/(?:不要|别|不需要).{0,8}(?:取消|撤销|清除)/.test(raw))throw new Error('不能把否定的控制请求当成授权');
    if(!verbs||!/(?:主动|推送|分享|联系)/.test(source.quote)||!new RegExp(verbs).test(source.quote)||args.action==='resume'&&/(?:不要|别|不需要).{0,8}(?:恢复|开启|继续)/.test(raw))throw new Error('需要本轮主用户明确的主动联系控制请求');
    exec.signal.throwIfAborted();return proactive.control(args.action);
  }});
}
