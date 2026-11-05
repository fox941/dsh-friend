import {randomUUID} from 'node:crypto';import {hash,noSecret} from './util.js';
export async function saveActivityMemory(controller,observation,reflection,reviewer,signal){
 const app=controller.applications,source=controller.store.reportSource(observation.id),key=hash('activity-memory:'+observation.id),{verifyReportSources,validateApplyPlan}=controller.ports.memory;
 return app.runActivity(controller.authority,async combined=>{
   const previous=app.store.bySelection(key);await verifyReportSources([source],null,controller.workspace,combined);
   if(previous?.plan)return app.protection?.withdrawnReport(previous.reportId)?app.read(previous.id,combined):app.advance(previous,combined);
   const p=observation.payload,content=`外部阅读经历（不是用户资料）\n时间：${source.occurredAt}\n来源：${p.url}\n标题：${p.title}\n观察范围：${p.scope}\n我的暂时理解：${reflection.summary}\n观察依据摘录（来源类型见观察范围）：${reflection.quote}`;
   const storeId=controller.applications.backend.correction.selectStore(undefined,true),memories=await app.memoryReader.read([],combined),caller={kind:'activity',policy:'activity-observation-v1',observationId:observation.id,authorizedAt:app.store.time()};
   const proposal={index:0,action:'supplement',summary:reflection.summary,reason:'保存已实际读取、来源范围明确的经历',evidence:[{sourceId:source.id,quote:reflection.quote}],referenceIds:[]};
   const frame={protocol:'ai-friend/activity-memory/1',reviewedAt:app.store.time(),authorization:caller,sources:[source],proposals:[proposal],memories,activeSpaces:[{id:storeId}],content};noSecret(JSON.stringify(frame));
   return app.reviewFrame({reportId:previous?.reportId??randomUUID(),key,selection:[0],caller,frame,config:{dailyCallLimit:app.config.dailyCallLimit,timeoutMs:180000},validate:validateApplyPlan,modelRequired:true,reviewer:async(f,s)=>{const result=await reviewer(f,s),d=result.decision;if(typeof d?.save!=='boolean'||typeof d.reason!=='string'||!d.reason.trim()||d.reason.length>900)throw new Error('活动记忆审核输出无效');return {...result,decision:{decisions:[{proposalIndex:0,verdict:d.save?'apply':'defer',timing:'current',reason:d.reason,operations:d.save?[{kind:'native_add',target:'event',storeId,content,evidence:proposal.evidence}]:[]}]}};}},combined);
 },signal);
}
