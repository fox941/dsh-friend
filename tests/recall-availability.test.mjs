import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';
const src=process.env.FRIEND_ADAPTER_SOURCE??path.resolve(import.meta.dirname,'../plugins/companion-adapter/src');
const {DEFAULT_THREE_TIER_VIEW_STRATEGY:strategy}=await import(pathToFileURL(path.resolve(src,'../vendor/mnemon-three-tier/index.js')));
async function query(unavailable){
 const view={id:'view',readGrants:[{id:'grant',sourceInstanceKey:'source',schema:'dsh-mnemon.memory-spaces/v1',value:{memoryBodyIds:['default']}}]};
 return strategy.createTurn(view).query({view,route:{id:'route',readGrantId:'grant',sourceInstanceKey:'source',sourceRouteId:'recall'},input:{query:'no matching records'},signal:new AbortController().signal},async()=>({id:'evidence',viewId:'view',routeId:'route',sourceInstanceKey:'source',observedAt:new Date().toISOString(),items:[],truncated:false,...unavailable===undefined?{}:{unavailable}}));
}
test('exact Native sparse-results advisories are no-match evidence, retaining their source notice',async()=>{
 for(const value of [undefined,'陪伴记忆: sparse_results','one: sparse_results\ntwo: sparse_results']){
  const result=await query(value);assert.equal(result.unavailable,undefined);assert.equal(result.output.unavailable,undefined);assert.deepEqual(result.output.results,[]);assert.equal(result.output.memoryEvidence.id,'evidence');
  if(value)assert.equal(result.output.memoryEvidence.metadata.searchNotice,value);
 }
});
test('unknown errors and mixed source failures must stay unavailable',async()=>{
 for(const value of ['database unavailable','one: sparse_results\ntwo: connection refused','one: sparse_results\n','sparse_results','one: sparse_results extra']){
  const result=await query(value);assert.equal(result.output.unavailable,value);assert.equal(result.unavailable,value);
 }
});
