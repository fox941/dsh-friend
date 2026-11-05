import {platformCompletionSource} from './platform-completion.js';
import {hash,noSecret} from './validation.js';
import {goalNoSave} from './goals.js';

function table(db,name){return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));}
function ownerGoal(adapter,goal){
  const origin=goal?.origin;if(!origin)return false;
  if(['owner_conversation','owner_message','current_self_state'].includes(origin.kind))return true;
  if(origin.kind==='platform_message'&&origin.id?.startsWith('intent:')){const intent=adapter.attention.store.get(origin.id.slice(7)),event=intent?.kind==='bilibili'?adapter.bilibiliInbox.store.event(intent.payload.eventId):null;return event?.kind==='private'&&event.sender===adapter.bilibiliSocial.config.ownerUid;}
  return origin.kind==='internal_reflection'&&origin.privacy!=='private';
}
/** Frozen, bounded provenance; no user message is invented to start an outgoing turn. */
export async function proactiveSource(adapter,intent,signal){
  if(!intent||intent.status!=='completed'||!['browse','recall','reflect','goal'].includes(intent.kind)||!intent.result)return null;
  const result=intent.result,db=adapter.journal.db;let value;
  // Requested completions are replies to a verified owner task, including no-save requests.
  if(intent.kind==='browse'&&intent.payload.requestId)return adapter.activityRequests?.publicationSource(intent,null)??null;
  if(intent.payload.platformActionId)return platformCompletionSource(adapter,intent);
  if(goalNoSave(JSON.stringify({payload:intent.payload,result})))return null;
  if(intent.kind==='browse'){
    const run=result.activityId?adapter.activities.store.get(result.activityId):null;
    if(run?.request.backgroundRequestId)return null;
    if(!run||run.request.learn===false||!['completed','completed_without_memory','already_observed'].includes(run.status))return null;
    const observation=adapter.activities.store.observation(run.observation_id??run.result?.observationId);if(!observation)return null;
    const p=observation.payload;value={key:'observation:'+observation.id,kind:'public_reading',text:p.text.slice(0,5000),title:p.title,url:p.url,scope:p.scope,observationId:observation.id};
  }else if(intent.kind==='goal'){
    const goal=adapter.goals.store.get(result.goalId);if(!ownerGoal(adapter,goal)||goal.status!=='completed'||!goal.completion)return null;
    const steps=goal.completion.stepIds.map(id=>adapter.goals.store.step(id));if(steps.some(s=>!s||!adapter.goals.verifyReceipt(s)))return null;
    value={key:`goal:${goal.id}:${goal.revision}`,kind:'goal_progress',text:JSON.stringify({title:goal.title,success:goal.success,completionEvidence:goal.completionEvidence,completion:goal.completion,steps:steps.map(s=>({kind:s.kind,receipt:s.receipt}))}).slice(0,6000),scope:'主用户相关目标的实际回执；反思与检索不等于外部行动'};
  }else if(intent.kind==='recall'){
    if(result.status!=='recalled'||!result.memoryToken||await adapter.preview.memoryReader.token(signal)!==result.memoryToken)return null;
    const items=(result.items??[]).filter(item=>{
      if(item.kind==='runtime'||item.kind==='self')return true;
      if(item.kind!=='native')return false;
      if(!table(db,'bili_social_memory_index'))return true;
      const indexed=db.prepare('SELECT thread_key FROM bili_social_memory_index WHERE store_id=? AND native_id=?').get(item.storeId,item.recordId);
      if(!indexed)return !/B站社交经历/.test(item.text);
      return indexed.thread_key.startsWith('public:')||indexed.thread_key===`private:${adapter.bilibiliInbox.store.control().account_id}:${adapter.bilibiliSocial.config.ownerUid}`;
    });
    if(!items.length)return null;
    value={key:'recall:'+hash(JSON.stringify(items.map(({id,revision})=>[id,revision]))),kind:'recalled_memory',text:items.map(item=>item.text).join('\n').slice(0,5000),memoryToken:result.memoryToken,scope:'本次检索到的已有资料；不是新发生的事件，原话撤回或记忆更正后须重核验'};
  }else{
    if(result.status!=='reflected'||typeof result.note!=='string')return null;
    if(intent.payload.goalId&&!ownerGoal(adapter,adapter.goals.store.get(intent.payload.goalId)))return null;
    value={key:'reflection:'+hash(result.note.normalize('NFKC').replace(/\s/g,'')),kind:'internal_thought',text:result.note.slice(0,1000),scope:'同一角色的内部想法；不是外部事实、已完成行动或独立人格依据'};
  }
  noSecret(JSON.stringify(value));if(goalNoSave(JSON.stringify(value)))return null;
  return {...value,originIntentId:intent.id};
}
