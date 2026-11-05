import {normalizeProfile} from '@ai-friend/qq-bridge/person-policy';
import {randomUUID} from 'node:crypto';
import {eligibleHeader} from './preview-sessions.js';
import {verifyReportSources} from './apply-evidence.js';
import {validateApplyPlan} from './apply-plan.js';
import {ownerMessage} from './evidence.js';
import {ownerIdentity,originalOwnerEvent,assistantResponseDelivered} from './source-identity.js';
import {text,hash,noSecret,uuid} from './validation.js';

const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
const words=blocks=>(blocks??[]).filter(row=>row.type==='text'&&typeof row.text==='string').map(row=>row.text).join('\n');
const bounded=(value,fallback,min,max)=>{const n=value??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('日常记忆配置超出范围');return n;};
const nativeId=/^native:([a-zA-Z0-9_-]{1,64}):([a-f0-9-]{36})$/i;
export const referenceVersion=ref=>hash(JSON.stringify([ref.id,ref.kind,ref.text,ref.createdAt??null,ref.updatedAt??null,ref.importance??null,ref.category??null]));

/** Only original, unseeded direct owner turns can enter this first implementation. */
export function conversationSource(agent,workspace){
  if(!agent||!eligibleHeader(agent.session?.header,workspace))throw new Error('日常记忆只接受本实例主用户的直接陪伴会话');
  const event=ownerMessage(agent);if(ownerIdentity(event,agent.session.header)?.qq?.recovery)throw Error('补收消息仅作临时对话，不直接写入长期记忆');
  if(event.sourceEventSeqs?.length)throw new Error('转发、注入或派生消息不能作为新主用户依据');
  const content=words(event.data.content);text(content,'本轮完整原话',10000);noSecret(content);
  const context=[];
  for(let seq=event.seq-1;seq>=Math.max(0,event.seq-160)&&context.length<6;seq--){
    const previous=agent.session.eventAt(seq),user=originalOwnerEvent(previous,agent.session.header);
    const assistant=assistantResponseDelivered(previous,agent.session.header);
    if(!user&&!assistant)continue;
    const value=words(user?previous.data.content:previous.data.message.content);if(!value)continue;
    try{noSecret(value);}catch{context.unshift({role:user?'user':'assistant',omitted:'疑似凭据正文未复制'});continue;}
    context.unshift({role:user?'user':'assistant',seq,text:value.slice(0,1800),truncated:value.length>1800});
  }
  return {source:{id:`event:${hash(`${agent.id}:${event.seq}:user_message`)}`,sessionId:agent.id,seq:event.seq,messageId:event.data.id,kind:'user_message',occurredAt:new Date(event.time).toISOString(),text:content,contentHash:hash(content),...ownerIdentity(event,agent.session.header)},context};
}

function requests(args,source){
  if(!Array.isArray(args.changes)||!args.changes.length||args.changes.length>4)throw new Error('每批需提供1–4项具体记忆变化');
  const changes=args.changes.map(row=>{
    if(!row||Object.keys(row).some(key=>!['action','target','content','referenceId','expectedContent','expectedVersion','storeId','evidenceQuote','reason','importance','profile'].includes(key)))throw new Error('记忆变化包含未定义字段');
    if(!['add','replace','remove'].includes(row.action)||!['user','memory','long_term'].includes(row.target))throw new Error('记忆动作或目标不正确');
    const quote=text(row.evidenceQuote,'本轮逐字依据',1500),reason=text(row.reason,'记忆变化理由',900);
    if(!source.text.includes(quote))throw new Error('记忆依据必须逐字引用本轮主用户原话');
    const normalized={action:row.action,target:row.target,evidenceQuote:quote,reason};
    if(row.profile!==undefined){if(row.action==='remove'||!['user','long_term'].includes(row.target))throw Error('Only personal facts can carry profile metadata');normalized.profile=normalizeProfile(row.profile,source.text,quote);}
    if(row.action==='add'){
      if(row.referenceId||row.expectedContent||row.expectedVersion)throw new Error('新增不能携带旧条目覆盖参数');
    }else{
      normalized.referenceId=text(row.referenceId,'旧条目引用',200);
      normalized.expectedContent=text(row.expectedContent,'已读旧条目全文',3000).replace(/\r\n/g,'\n');
      normalized.expectedVersion=text(row.expectedVersion,'已读旧条目版本',64);
    }
    if(row.action!=='remove')normalized.content=text(row.content,'完整记忆条目',3000).replace(/\r\n/g,'\n');
    else if(row.content!==undefined)throw new Error('撤回不接受新的事实正文');
    if(row.storeId!==undefined){if(row.target!=='long_term')throw new Error('常驻资料不能指定长期空间');normalized.storeId=text(row.storeId,'长期空间',64);}
    if(row.importance!==undefined){if(row.action!=='add'||row.target==='long_term'||!['low','normal','critical'].includes(row.importance))throw new Error('重要度只用于常驻新增');normalized.importance=row.importance;}
    noSecret(JSON.stringify(normalized));return normalized;
  });
  const targets=new Set();for(const row of changes){const key=row.referenceId??`${row.target}:${row.storeId??''}:${row.content}`;if(targets.has(key))throw new Error('同一条目不能在一批内重复处理');targets.add(key);}
  return changes;
}

/** The reviewer may veto, but cannot expand the requested CRUD operations. */
export function validateConversationPlan(value,frame){
  const plan=validateApplyPlan(value,frame);
  for(const decision of plan.decisions){
    const request=frame.proposals.find(row=>row.index===decision.proposalIndex).request;
    const primary=request.target==='long_term'?(request.action==='add'?'native_add':request.action==='replace'?'native_correct':'native_forget'):(request.action==='add'?'runtime_add':request.action==='replace'?'runtime_replace':'runtime_remove');
    let actual=0;
    for(const op of decision.operations){
      if(op.kind==='review_self')continue;
      const isPrimary=op.kind===primary&&(request.action==='add'||op.reference?.id===request.referenceId);
      const old=frame.memories.items.find(row=>row.id===request.referenceId);
      const copy=request.action!=='add'&&op.reference?.text===old?.text&&['runtime','native'].includes(op.reference?.kind)&&
        (request.action==='replace'?['runtime_replace','native_correct']:['runtime_remove','native_forget']).includes(op.kind);
      if(!isPrimary&&!copy)throw new Error('日常审核扩大了原请求的操作范围');
      if(request.action!=='remove'&&op.content!==request.content)throw new Error('审核不能静默改写提案正文；不可靠内容应暂缓');
      if(request.action==='add'&&(request.target==='long_term'?op.storeId!==request.storeId:op.target!==request.target))throw new Error('审核改变了新增记忆的目标');
      if(isPrimary)actual++;
      if(op.kind==='runtime_add')op.importance=request.importance??'normal';
    }
    if(decision.verdict==='apply'&&!actual)throw new Error('日常应用缺少原请求的主要操作');
  }
  return plan;
}

export class ConversationMemoryController{
  constructor({applications,backend,memoryReader,workspace,authority,config={}}){
    Object.assign(this,{applications,backend,memoryReader,workspace,authority});
    if(config.enabled!==undefined&&typeof config.enabled!=='boolean')throw new Error('日常记忆开关必须是布尔值');
    this.config={enabled:config.enabled??true,dailyCallLimit:bounded(config.dailyCallLimit,40,0,200),timeoutMs:bounded(config.timeoutMs,45000,1000,60000),maxTokens:bounded(config.maxTokens,6144,1024,8192)};
  }
  status(){const calls=this.applications.store.calls('conversation');return {enabled:this.config.enabled,callsToday:calls,callsRemaining:Math.max(0,this.config.dailyCallLimit-calls),channelScope:'本实例直接主用户及已核验绑定的QQ私聊；转发或未绑定身份不开放',protectedWrites:true};}
  async read({queries=[],references=[]}={},signal){
    if(!Array.isArray(queries)||queries.length>2||!Array.isArray(references)||references.length>4)throw new Error('记忆读取最多两个查询、四个精确引用');
    queries=queries.map(query=>text(query,'查询',160));references=references.map(ref=>text(ref,'精确引用',200));
    noSecret(JSON.stringify({queries,references}));
    const result=await this.memoryReader.read(queries,signal),items=new Map(result.items.map(row=>[row.id,row]));
    for(const ref of references){
      const match=nativeId.exec(ref);if(!match){if(!items.has(ref))throw new Error('指定常驻引用已失效');continue;}
      const [,storeId,recordId]=match;uuid(recordId);this.backend.correction.selectStore(storeId);
      const row=await this.backend.correction.client.showReadOnly(storeId,recordId,signal);
      if(!row){items.delete(ref);continue;}
      if(row.content.length>6000)throw new Error('长期条目超出本次读取预算');noSecret(row.content);
      items.set(ref,{id:ref,kind:'native',storeId,recordId,text:row.content,category:row.category,importance:row.importance,createdAt:row.created_at,updatedAt:row.updated_at});
    }
    const after=await this.memoryReader.token(signal);
    return {...result,items:[...items.values()].map(row=>({...row,version:referenceVersion(row)})),changedDuringRead:result.changedDuringRead||result.token!==after,token:after};
  }
  run(args,agent,persistence,reviewer,signal){
    if(!this.config.enabled)return Promise.reject(new Error('日常记忆写入已关闭，不能改用旧工具绕过'));
    const input=conversationSource(agent,this.workspace),changes=requests(args,input.source);
    const key=hash(JSON.stringify(['conversation-v1',input.source.sessionId,input.source.messageId,input.source.seq,changes]));
    return this.applications.runConversation(this.authority,async combined=>{
      const existing=this.applications.store.bySelection(key);
      if(existing?.plan)return this.resume(existing,persistence,combined);
      await persistence?.flush?.();await verifyReportSources([input.source],persistence,this.workspace,combined);
      const count=this.applications.store.db.prepare("SELECT count(*) n FROM apply_runs WHERE json_extract(approval_json,'$.kind')='conversation' AND json_extract(approval_json,'$.sessionId')=? AND json_extract(approval_json,'$.messageId')=?").get(input.source.sessionId,input.source.messageId).n;
      if(!existing&&count>=2)throw new Error('同一条主用户消息最多两批日常写入；保留依据，避免循环反复提案');
      const queries=[...new Set(changes.map(row=>(row.expectedContent??row.content??row.evidenceQuote).slice(0,160)))].slice(0,2);
      const memories=await this.read({queries,references:changes.filter(row=>row.referenceId).map(row=>row.referenceId)},combined);
      const proposals=changes.map((request,index)=>{
        const old=request.referenceId?memories.items.find(row=>row.id===request.referenceId):null;
        if(request.action!=='add'){
          if(!old||old.text!==request.expectedContent||old.version!==request.expectedVersion)throw new Error('旧条目已改变或版本过期，请重新读取后提案');
          if(request.target==='long_term'?old.kind!=='native':old.kind!=='runtime'||old.target!==request.target)throw new Error('旧引用与记忆目标不匹配');
        }
        if(request.target==='long_term')request.storeId=old?.storeId??this.backend.correction.selectStore(request.storeId,true);
        return {index,action:request.action==='add'?'supplement':request.action==='replace'?'temporal_change':'withdraw',summary:request.reason,reason:request.reason,evidence:[{sourceId:input.source.id,quote:request.evidenceQuote}],referenceIds:old?[old.id]:[],request};
      });
      const caller={kind:'conversation',policy:'conversation-memory-v1',owner:true,sessionId:input.source.sessionId,messageId:input.source.messageId,seq:input.source.seq,channel:input.source.channel,principal:input.source.principal,authorizedAt:this.applications.store.time()};
      const frame=freeze(JSON.parse(JSON.stringify({protocol:'ai-friend/memory-conversation/1',reviewedAt:this.applications.store.time(),authorization:caller,sources:[input.source],conversationContext:input.context,proposals,memories,activeSpaces:this.backend.correction.policy().spaces.filter(row=>row.active).map(row=>({id:row.id,name:row.name}))})));
      if(JSON.stringify(frame).length>100000)throw new Error('日常记忆审核材料过多，未截断原话后写入');noSecret(JSON.stringify(frame));
      // No model call or snapshot for exact already-known additions. Semantic
      // duplicates and contextual assertions still need the independent reviewer.
      const exact=proposals.every(item=>item.request.action==='add'&&memories.items.some(ref=>['runtime','native'].includes(ref.kind)&&ref.text===item.request.content));
      return this.applications.reviewFrame({reportId:existing?.reportId??randomUUID(),key,selection:proposals.map(row=>row.index),caller,frame,reviewer,config:this.config,budgetKind:'conversation',validate:validateConversationPlan,modelRequired:!exact,noModelDecision:exact?{decisions:proposals.map(row=>({proposalIndex:row.index,verdict:'noop',timing:'current',reason:'已有完全相同的记忆；不重复写入或增加独立证据。',operations:[]}))}:undefined},combined);
    },signal);
  }
  async resume(row,persistence,signal){
    if(row.approval?.kind!=='conversation')throw new Error('此批不是日常聊天记忆写入');
    if(this.applications.protection?.withdrawnReport(row.reportId))return {...await this.applications.read(row.id,signal),replayed:true};
    if(this.applications.store.steps(row.id).every(step=>step.status==='applied'))return {...await this.applications.read(row.id,signal),replayed:true};
    await persistence?.flush?.();await verifyReportSources(row.frame.sources,persistence,this.workspace,signal);
    return this.applications.advance(row,signal);
  }
  retry(id,agent,quote,persistence,signal){
    if(!this.config.enabled)throw new Error('日常记忆写入已关闭');
    const input=conversationSource(agent,this.workspace),wanted=text(quote,'本轮重试原话',1500);if(!input.source.text.includes(wanted))throw new Error('重试需引用本轮主用户原话');uuid(id);
    if(!/(?:重试|继续|接着|恢复).{0,24}(?:记忆|写入|保存|批次|失败|未完成)|(?:记忆|写入|保存|批次).{0,24}(?:重试|继续|接着|恢复)/.test(wanted)||/(?:不要|别|不再|暂不|不想|禁止).{0,12}(?:重试|继续|恢复|写入|保存)/.test(input.source.text))throw new Error('需要主用户明确继续记忆批次的请求，普通提问或否定不触发重试');
    const row=this.applications.store.get(id);if(!row?.plan)throw new Error('没有可继续的固定计划；需重新读取后提出新写入');
    return this.applications.runConversation(this.authority,combined=>this.resume(row,persistence,combined),signal);
  }
}
