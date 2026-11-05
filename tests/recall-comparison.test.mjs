import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';
const src=process.env.FRIEND_ADAPTER_SOURCE??path.resolve(import.meta.dirname,'../plugins/companion-adapter/src'),{recallEvidence}=await import(pathToFileURL(src+'/recall.js')),{DEFAULT_THREE_TIER_VIEW_STRATEGY:strategy}=await import(pathToFileURL(path.resolve(src,'../vendor/mnemon-three-tier/index.js'))),signal=new AbortController().signal,authority={viewId:'same-event-view',sourceInstanceKey:'same-event-source',memoryBodyIds:['default']},reason='比较同一虚构读书会事件的首次笔记与后来修订原件';
const evidence=(items)=>({id:'source-read',viewId:authority.viewId,sourceInstanceKey:authority.sourceInstanceKey,truncated:false,items:items.map(([id,text])=>({id,text,provenance:{memoryBodyId:'default',relevanceTier:'medium'}}))});
test('ordinary misses the second same-event original while explicit comparison retains both under unchanged content limits',async()=>{
 const input=evidence([['later','同一虚构活动的后来修订原件。'],['earlier','同一虚构活动的首次原件。']]);
 for(const complex of [false,true]){const turn=strategy.createTurn({id:authority.viewId}),r=await recallEvidence({query:'虚构活动 两份记录',...complex?{complexReason:reason}:{}},(query,complexReason)=>turn.recall({query,...complexReason?{intent:'complex:'+complexReason}:{}},async()=>structuredClone(input),signal,authority),signal);assert.deepEqual(r.results.map(i=>i.id),complex?['later','earlier']:['later']);assert(r.retrieval.characters<=12000);assert.equal(turn.state.recallAttempts.length,1);}
});
test('comparison can recover a missing side with a distinct focused query after two ordinary queries without reopening Source scope',async()=>{
 const turn=strategy.createTurn({id:authority.viewId});let calls=0;const provider=async input=>{calls++;return input.query.includes('首次')?evidence([['earlier','同一活动首次原件。']]):input.query.includes('其他')?evidence([['noise','无关活动的一份原件。']]):evidence([['later','同一活动后来原件。'],['earlier','同一活动首次原件。']]);};
 const read=(query,why)=>turn.recall({query,...why?{intent:'complex:'+why}:{}},provider,signal,authority);
 const initial=await recallEvidence({query:'活动记录',alternateQuery:'其他活动'},read,signal);assert.equal(calls,2);assert(!initial.results.some(r=>r.id==='earlier'));
 const recovery=await recallEvidence({query:'同一活动 首次原件',complexReason:reason},read,signal);assert.equal(calls,3);assert.equal(recovery.results[0].id,'earlier');assert(turn.state.usedCharacters<=12000);assert(turn.state.usedResults<=12);
 await assert.rejects(turn.recall({query:'未经授权的原件',intent:'complex:'+reason,memoryBodyIds:['private-other']},provider,signal,authority),/outside/);assert.equal(calls,3);
});
test('upgrading a repeated ordinary query replays its admitted evidence; recovery requires a different query and still closes at four',async()=>{
 const turn=strategy.createTurn({id:authority.viewId});let calls=0;const provider=async()=>{calls++;return evidence([['later','后来观察原件。'],['earlier','首次观察原件。']]);};
 const first=await turn.recall({query:'活动观察'},provider,signal,authority),replayed=await turn.recall({query:'活动观察',intent:'complex:'+reason},provider,signal,authority);assert.deepEqual(replayed.results,first.results);assert.equal(calls,1);
 const recovery=await turn.recall({query:'活动观察 首次'},provider,signal,authority);assert(recovery.results.some(r=>r.id==='earlier'));assert.equal(calls,2);
 await turn.recall({query:'活动观察 来源'},provider,signal,authority);await turn.recall({query:'活动观察 版本'},provider,signal,authority);assert.equal((await turn.recall({query:'第五次'},provider,signal,authority)).notRun,true);assert.equal(calls,4);
});
