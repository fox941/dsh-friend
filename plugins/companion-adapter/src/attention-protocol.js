import * as z from 'zod';

export const attentionProtocolVersion='3';
const reason=z.string().min(1).max(700).describe('简短依据，不能只含空白，不输出内部推理过程');
const wake=z.union([
 z.object({kind:z.literal('time'),afterSeconds:z.number().int().min(30).max(86400)}).strict(),
 z.object({kind:z.enum(['event','task_end','state_change','change'])}).strict()
]).describe('选择一个真实唤醒条件。kind只填一个枚举值；不能把event|task_end等拼成字符串');
const goalRelation=z.object({action:z.enum(['reuse','supplement']),id:z.string().min(1),expectedRevision:z.number().int().min(1),expectedGoalsRevision:z.number().int().min(0).optional(),reason,sourceId:z.string().min(1),quote:z.string().min(1).max(700),title:z.string().min(1).max(240).optional(),success:z.string().min(1).max(600).optional()}).strict();

export function attentionSchema(ids=[],routingIds=[]){
 const candidate=(ids.length?z.enum(ids):z.string().min(1)).describe('必须逐字使用本批candidates里的id，不能用事项类型、标题或旧ID代替');
 const update=z.discriminatedUnion('action',[
  z.object({id:candidate,action:z.literal('defer'),reason,wake}).strict(),
  z.object({id:candidate,action:z.literal('dismiss'),reason,wake:wake.nullable().optional()}).strict()
 ]);
 const shape={reason,updates:z.array(update).max(32).optional().describe('可省略；每个ID最多一次，start目标不能同时出现在这里'),suggestions:z.array(z.object({kind:z.enum(['browse','recall','reflect','workshop']),topic:z.string().min(1).max(160),reason,resolution:z.enum(['new','reuse','supplement']).optional(),targetId:z.string().min(1).optional(),expectedRevision:z.string().min(1).optional(),mergeFrom:z.object({id:z.string().min(1),revision:z.string().min(1)}).strict().optional()}).strict()).max(2).optional(),affect:z.unknown().optional().describe('可选情绪提案，保持原独立审核；本字段不直接改变状态'),goals:z.array(z.unknown()).max(1).optional().describe('可选目标提案，保持原来源及权限审核')};
 return z.discriminatedUnion('action',[
  z.object({...shape,action:z.literal('start'),targetId:candidate,executionTarget:z.enum(['bilibili_video','external_document']).optional().describe('当目标executionRouting.required=true时必须填写，明确是B站视频还是网页/论文文档；不能以教程代替文档')}).strict(),
  z.object({...shape,action:z.literal('continue'),targetId:z.null().optional()}).strict(),
  z.object({...shape,action:z.literal('rest'),targetId:z.null().optional()}).strict()
 ]).superRefine((value,ctx)=>{
  if(value.action==='start'&&routingIds.includes(value.targetId)&&!value.executionTarget)ctx.addIssue({code:'custom',path:['executionTarget'],message:'此浏览事项必须明确executionTarget：bilibili_video或external_document'});
  if(!value.reason.trim())ctx.addIssue({code:'custom',path:['reason'],message:'依据不能为空白'});
  if(value.action==='start'&&!ids.includes(value.targetId))ctx.addIssue({code:'custom',path:['targetId'],message:'目标不在本次候选中'});
  for(const [i,g]of(value.goals??[]).entries())if(g&&['reuse','supplement'].includes(g.action)){
   const parsed=goalRelation.safeParse(g);
   if(!parsed.success)for(const issue of parsed.error.issues)ctx.addIssue({code:'custom',path:['goals',i,...issue.path],message:issue.message});
   if(g.action==='supplement'&&!g.title)ctx.addIssue({code:'custom',path:['goals',i,'title'],message:'补充目标必须说明新增关注点'});
  }
  for(const [i,s]of(value.suggestions??[]).entries()){if(['reuse','supplement'].includes(s.resolution)&&(!s.targetId||!s.expectedRevision))ctx.addIssue({code:'custom',path:['suggestions',i],message:'复用需要本轮待办ID和版本'});if(s.resolution==='new'&&(s.targetId||s.expectedRevision||s.mergeFrom))ctx.addIssue({code:'custom',path:['suggestions',i],message:'新建不能夹带旧事项修改'});if(value.action==='start'&&(s.targetId===value.targetId||s.mergeFrom?.id===value.targetId))ctx.addIssue({code:'custom',path:['suggestions',i],message:'本轮已选择执行的事项不重复复用或合并'});}
  if((value.suggestions??[]).filter(s=>s.kind==='workshop').length>1)ctx.addIssue({code:'custom',path:['suggestions'],message:'每次最多一项自主工作提案'});
  const used=new Set();for(const [i,row]of(value.updates??[]).entries()){
   if(!ids.includes(row.id)||used.has(row.id)||row.id===value.targetId)ctx.addIssue({code:'custom',path:['updates',i,'id'],message:'事项ID必须属于本批、不能重复，也不能是本次start目标'});
   used.add(row.id);
  }
 });
}

export function attentionJsonSchema(ids=[],routingIds=[]){return z.toJSONSchema(attentionSchema(ids,routingIds),{io:'input',reused:'ref'});}

export function validateAttention(value,ids,now=Date.now(),candidates=[]){
 const parsed=attentionSchema(ids,candidates.filter(r=>r.executionRouting?.required).map(r=>r.id)).safeParse(value);
 if(!parsed.success){
  const flatten=(issues,prefix=[])=>issues.flatMap(issue=>issue.code==='invalid_union'&&issue.errors?issue.errors.flatMap(group=>flatten(group,[...prefix,...issue.path])):[{path:[...prefix,...issue.path],message:issue.message}]);
  const issues=flatten(parsed.error.issues).slice(0,16).map(issue=>({path:issue.path.join('.'),message:issue.message.slice(0,240)}));
  const hint=issues.some(i=>i.path.startsWith('suggestions'))?'自主意图格式无效':issues.some(i=>i.path.includes('afterSeconds'))?'重新考虑时间超出范围':issues.some(i=>i.path.includes('wake'))?'延后缺少有效的重新考虑条件':issues.some(i=>i.path.includes('targetId')||i.path.endsWith('.id'))?'行为选择目标或事项ID不在本次候选中':'行为选择格式无效';
  throw Object.assign(new Error(hint),{code:'ATTENTION_SCHEMA_INVALID',repairable:true,issues});
 }
 const decision=parsed.data;return {...decision,updates:(decision.updates??[]).map(row=>({...row,wake:row.action==='defer'?row.wake.kind==='time'?{kind:'time',at:now+row.wake.afterSeconds*1000}:row.wake:null})),suggestions:decision.suggestions??[]};
}
