import {VideoRecall,recallWithMnemon} from './video-recall.js';

export function attachVideoNotes(ctx, adapter) {
  if (!adapter.activities?.videoNotes) return;
  const {ownerMessage}=adapter.ports.evidence;
  ctx.systemPrompt.section({name: 'ai-friend:video-notes', order: 10371, interpolate: false,
    text: 'friend_video_notes_read用于回忆已观察的视频：给出完整BV号或链接，可按当前问题query与少量keywords检索更早的字幕/画面解读原件，或includeHistory查看理解修订。没有明确BV时用friend_video_recall按问题找候选与原件，不猜造视频。笔记是暂定理解，不等于外部事实；回答具体细节时核对evidence，区分字幕、转写及模型画面推断。查不到可以换同义关键词，仍不清楚就说明未知；是否补看由你决定。它只回查原记录，不会重新看视频或写长期记忆/情绪。不同CID版本不能拼成同一次观看；需要旧版时显式指定返回的availableVersions中的cid。不要把笔记、回忆或修订当成新的独立经历或增长依据。'});
  ctx.tools.register({name: 'friend_video_notes_read', description: '回查指定B站视频的阶段性理解、未证实疑问和来源原片段。支持问题/关键词检索较早观察、按CID隔离与修订历史分页；不重新观看、不调用模型、不写长期记忆或人格。旧版有依据的反思可首次派生为笔记。',
    parameters: {type: 'object', properties: {video: {type: 'string'}, cid: {type: ['string', 'null'], description: '不传使用最近实际观察版本；null为没有CID的旧文字版'}, query: {type: 'string', maxLength: 300}, keywords: {type: 'array', maxItems: 8, items: {type: 'string', maxLength: 40}}, evidenceId: {type: 'string', description: '按返回的source.id精确读取历史引用原文'}, includeHistory: {type: 'boolean'}, beforeRevision: {type: 'integer', minimum: 1}, limit: {type: 'integer', minimum: 1, maximum: 12}}, required: ['video']},
    output: {schema: {type: 'object', additionalProperties: true}, render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}]},
    async execute(args, exec) { ownerMessage(exec.agent); return adapter.activities.videoNotes.read(args.video, args); }
  });
  if (adapter.client && adapter.applications && adapter.journal) {
    const recall = new VideoRecall(adapter);
    ctx.systemPrompt.section({name:'ai-friend:video-recall',order:10372,interpolate:false,text:'模糊提到以前看过的视频且没有BV号时，可用friend_video_recall。query按当前问题表达，alternateQuery可给一个忠实的同义检索表达，不能虚构人物、视频名或新经历。工具内部复用本轮mnemon_recall，共享普通聊天两次查询等原有限额；不要先后反复穷举，预算不足可以说明暂未找到。它只返回可追溯的Native经历候选与实际原文片段，rankScore是检索排序不是正确概率。多个候选分开核对，不能把不同视频/分P/CID拼成同一次经历；可用返回的sourceUrl、cid、evidenceId继续friend_video_notes_read精读，仍无法区分时再询问。候选中的sourceType=multimodal只是容器；具体按evidenceTypes判定字幕/转写/图片解读。召回、笔记与查询改写都不是新增外部证据，不能据此提高兴趣/情绪或改写人格。该工具不重新观看，不新增模型判断角色。'});
    ctx.tools.register({name:'friend_video_recall',description:'不需要BV号，按模糊问题从本轮Mnemon共享记忆召回找到曾观察视频的候选，再核验已应用的Native经历回执、当前正文与原文引用。返回视频版本与可核对片段；不会重新看视频或写长期记忆。最多一个可选同义查询，仅初次未找到可追溯视频时使用，仍占本轮原召回额度。',parameters:{type:'object',additionalProperties:false,properties:{query:{type:'string',maxLength:300},alternateQuery:{type:'string',maxLength:160},keywords:{type:'array',maxItems:8,items:{type:'string',maxLength:40}},limit:{type:'integer',minimum:1,maximum:4}},required:['query']},timeoutMs:60000,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},async execute(args,exec){ownerMessage(exec.agent);return recall.find(args,q=>recallWithMnemon(ctx,exec,q),exec.signal);}});
  }

}
