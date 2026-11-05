import {text,noSecret} from './validation.js';
const supported=new Set(['runtime_add','runtime_replace','native_add','native_correct','runtime_archive','review_self','runtime_remove','native_forget']);
const immutableProposal=new Set(['keep','duplicate','conflict','defer']);
function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('应用审核包含未定义字段');}
export function validateApplyPlan(value,frame){
  keys(value,['decisions']);if(!Array.isArray(value.decisions)||value.decisions.length!==frame.proposals.length)throw new Error('应用审核须逐项返回决定');
  const sources=new Map(frame.sources.map(row=>[row.id,row])),memories=new Map(frame.memories.items.map(row=>[row.id,row]));
  const selected=new Map(frame.proposals.map(row=>[row.index,row])),seen=new Set();let count=0;
  const decisions=value.decisions.map(row=>{
    keys(row,['proposalIndex','verdict','timing','reason','operations']);const proposal=selected.get(row.proposalIndex);
    if(!proposal||seen.has(row.proposalIndex)||!['apply','noop','defer'].includes(row.verdict)||!['current','future','uncertain'].includes(row.timing)||!Array.isArray(row.operations))throw new Error('应用决定的提案、时效或操作不正确');
    seen.add(row.proposalIndex);const reason=text(row.reason,'应用审核依据',900);
    if(row.verdict!=='apply'&&row.operations.length||row.verdict==='apply'&&(!row.operations.length||row.timing!=='current'||immutableProposal.has(proposal.action)))throw new Error('不能应用待定、未来生效或无需改动的提案');
    const operations=row.operations.map(operation=>{
      keys(operation,['kind','referenceId','target','storeId','content','evidence','becauseRefs','observationIds']);
      if(operation.observationIds!==undefined&&(!frame.videoGrounding||operation.kind!=='native_add'||!Array.isArray(operation.observationIds)||operation.observationIds.length>4||new Set(operation.observationIds).size!==operation.observationIds.length||operation.observationIds.some(id=>typeof id!=='string'||!frame.videoGrounding.items.some(v=>v.observationId===id))))throw Error('视频观察编号必须来自本批核对原件');
      if(!supported.has(operation.kind)||++count>8||!Array.isArray(operation.evidence)||operation.evidence.length<1||operation.evidence.length>4)throw new Error('应用操作数量或类型不正确');
      if(['runtime_remove','native_forget'].includes(operation.kind)&&frame.authorization?.kind!=='conversation')throw new Error('撤回操作仅限有当前原话依据的日常记忆入口');
      const evidence=operation.evidence.map(item=>{
        keys(item,['sourceId','quote']);const source=sources.get(item.sourceId),quote=text(item.quote,'应用原话',1500);
        if(!source||!source.text.includes(quote)||!proposal.evidence.some(ref=>ref.sourceId===source.id))throw new Error('应用引文与所选提案的原始事件不匹配');return {sourceId:source.id,quote};
      });
      const external=frame.authorization?.kind==='activity'&&operation.kind==='native_add'&&operation.target==='event'&&evidence.some(item=>sources.get(item.sourceId).kind==='external_observation');
      if(!external&&!evidence.some(item=>sources.get(item.sourceId).kind==='user_message'))throw new Error('应用必须有真实主用户依据');
      if(frame.authorization?.kind==='activity'&&(operation.kind!=='native_add'||operation.referenceId||operation.becauseRefs?.length))throw new Error('活动只能新增来源明确的经历，不能修改用户事实或旧状态');
      const ref=operation.referenceId?memories.get(operation.referenceId):null;
      if(operation.referenceId&&!ref)throw new Error('应用引用了未核对的旧条目');
      if(['runtime_replace','runtime_archive','runtime_remove'].includes(operation.kind)&&ref?.kind!=='runtime'||['native_correct','native_forget'].includes(operation.kind)&&ref?.kind!=='native'||operation.kind==='review_self'&&ref?.kind!=='self')throw new Error('应用目标与旧条目类型不一致');
      if(operation.kind==='runtime_archive'&&(proposal.action!=='leave_hot'||ref.target!=='memory'||ref.importance==='critical'))throw new Error('只能转存明确完成的普通工作记忆，不能移动用户画像或关键约定');
      if(proposal.action==='leave_hot'&&operation.kind!=='runtime_archive')throw new Error('退出常驻提案只能完整转存原工作条目');
      if(operation.kind==='runtime_add'&&!['user','memory'].includes(operation.target))throw new Error('新增常驻条目缺少明确目标');
      if(['native_add','runtime_archive'].includes(operation.kind)&&!frame.activeSpaces.some(space=>space.id===operation.storeId))throw new Error('应用只能写入已核对的激活本地 Native 空间');
      if(operation.kind==='native_add'&&operation.target!=='event')throw new Error('新增 Native 仅支持经历事实，不把用户画像批量复制进去');
      const content=['runtime_add','runtime_replace','native_add','native_correct'].includes(operation.kind)?text(operation.content,'应用后的完整条目',3000).replace(/\r\n/g,'\n'):null;
      if(ref&&content===ref.text)throw new Error('相同条目无需改写，应返回 noop');
      const becauseRefs=operation.becauseRefs??[];
      if(!Array.isArray(becauseRefs)||becauseRefs.length>4||becauseRefs.some(id=>!memories.has(id)||memories.get(id).kind==='self'))throw new Error('状态复核缺少可核对的事实关联');
      if(operation.kind==='review_self'&&proposal.action!=='review_self'&&!becauseRefs.length)throw new Error('跨层状态复核须说明关联的事实');
      return {proposalIndex:row.proposalIndex,kind:operation.kind,...ref?{reference:ref}:{},...operation.target?{target:operation.target}:{},...operation.storeId?{storeId:operation.storeId}:{},...content?{content}:{},...operation.observationIds?{observationIds:operation.observationIds}:{},evidence,becauseRefs,reason};
    });
    return {proposalIndex:row.proposalIndex,verdict:row.verdict,timing:row.timing,reason,operations};
  }).sort((a,b)=>a.proposalIndex-b.proposalIndex);
  // Exact existing copies are projections of the same old fact. Propagate one
  // reviewed replacement mechanically; never ask the model to paraphrase each.
  const operations=decisions.flatMap(row=>row.operations);
  for(const operation of [...operations])if(['runtime_replace','native_correct','runtime_remove','native_forget'].includes(operation.kind)){
    const removing=['runtime_remove','native_forget'].includes(operation.kind),matching=removing?['runtime_remove','native_forget']:['runtime_replace','native_correct'];
    for(const copy of frame.memories.items.filter(item=>['runtime','native'].includes(item.kind)&&item.id!==operation.reference.id&&item.text===operation.reference.text)){
      const existing=operations.find(other=>other.reference?.id===copy.id);
      if(existing){if(!matching.includes(existing.kind)||existing.content!==operation.content)throw new Error('同一旧事实的已知副本收到不一致的更正，请重新审核');continue;}
      if(operations.length>=8)throw new Error('同一旧事实的完整副本超出本次应用预算');
      const propagated={...operation,kind:copy.kind==='runtime'?(removing?'runtime_remove':'runtime_replace'):(removing?'native_forget':'native_correct'),reference:copy,becauseRefs:[]};
      decisions.find(row=>row.proposalIndex===operation.proposalIndex).operations.push(propagated);operations.push(propagated);
    }
  }
  const targets=new Set();
  for(const operation of operations){
    const key=operation.reference?.id??`${operation.kind}:${operation.storeId??operation.target}:${operation.content}`;
    if(targets.has(key))throw new Error('同一目标不能在一批应用中被重复修改');targets.add(key);
    if(operation.kind==='review_self'&&operation.becauseRefs.some(id=>!operations.some(other=>other.reference?.id===id&&['runtime_replace','native_correct','runtime_remove','native_forget'].includes(other.kind))))throw new Error('关联状态复核没有对应的事实更正');
    if(['runtime_replace','native_correct'].includes(operation.kind)){
      for(const copy of frame.memories.items.filter(item=>['runtime','native'].includes(item.kind)&&item.id!==operation.reference.id&&item.text===operation.reference.text)){
        if(!operations.some(other=>other.reference?.id===copy.id&&['runtime_replace','native_correct'].includes(other.kind)&&other.content===operation.content))throw new Error('同一旧事实的已知完整副本必须同步更正');
      }
    }
  }
  const result={decisions};noSecret(JSON.stringify(result));return result;
}
