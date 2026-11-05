import {hash,text} from './validation.js';

/** Link planning provenance without inventing execution or changing success criteria. */
export function relateGoal(controller,args,source){
 const {store,journal}=controller;
 if(Object.keys(args).some(k=>!['action','id','expectedRevision','title','success','reason','sourceId','quote','expectedGoalsRevision'].includes(k)))throw Error('目标复用/补充不能夹带采纳、步骤或完成标准修改');
 const reason=text(args.reason,'目标复用理由',600),topic=args.title===undefined?null:text(args.title,'补充关注点',240),detail=args.success===undefined?null:text(args.success,'补充说明',600);
 if(args.action==='supplement'&&!topic)throw Error('补充目标需要title说明新增关注点');
 const operation=hash(JSON.stringify(['goal-relation',args.action,args.id,topic,detail,source])),old=store.receipt(operation);
 if(old){const current=store.get(old.goal.id);return {...old,goal:current,replayed:true,originalRevision:old.goal.revision,historical:current.revision!==old.goal.revision};}
 const receipt=journal.transaction(()=>{
  const before=store.get(args.id);if(!before||!Number.isSafeInteger(args.expectedRevision)||before.revision!==args.expectedRevision)throw Error('目标版本已变化，请重新读取');
  if(['completed','abandoned'].includes(before.status))throw Error('已结束目标不能借复用自动复活');
  const goal=structuredClone(before);
  if(args.action==='supplement'){
   const notes=goal.planningNotes??[];if(notes.length>=8)throw Error('目标补充已达保留上限，请明确重订或另建不同目标');
   goal.planningNotes=[...notes,{topic,detail,reason,source:structuredClone(source),at:store.time(),independentEvidence:false}];
   store.save(goal,'supplement',reason,source,before);
  }else{
   // A repeated mention adds history, without waking a waiting goal or making
   // a fresh review candidate by artificially incrementing its revision.
   store.note(goal,'reuse',reason,source);
  }
  const result={status:args.action==='reuse'?'reused':'supplemented',goal};store.saveReceipt(operation,result);return result;
 });
 if(args.action==='supplement')controller.attention.signal('goal_change');
 return receipt;
}
