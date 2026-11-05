import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import {fixture,module,old,updated} from './protection-fixture.mjs';
const {ConversationMemoryController,conversationSource}=await module('conversation-memory.js');
const {attachConversationMemory,UNMANAGED_MEMORY_WRITES}=await module('conversation-agent.js');
const {reviewConversationMemory}=await module('conversation-reviewer.js');
const {databaseHash}=await module('protection-sql.js'),{undoBatch}=await module('protection-undo.js');
const stamp=Date.parse('2026-10-28T04:00:00Z');

async function dailyFixture(t,options={}){
  const f=await fixture(t,options),authority=Object.freeze({});f.app.conversationAuthority=authority;
  const daily=new ConversationMemoryController({applications:f.app,backend:f.backend,memoryReader:f.app.memoryReader,workspace:f.workspace,authority,config:options.dailyConfig});
  const rows=new Map();let agent,turn=0,calls=0;
  function next(message,overrides={}){
    turn++;const id=`daily-session-${turn}`,events=[{seq:0,time:stamp+turn,type:'turn/start',data:{turn:1}},{seq:1,time:stamp+turn,type:'user/message',data:{id:`message-${turn}`,source:{kind:'user'},content:[{type:'text',text:message}]}}];
    const header={id,createdAt:stamp+turn,cwd:f.workspace,agentPreset:'companion',isSeeded:false,...overrides};rows.set(id,{header,events});
    agent={id,session:{header,seq:events.length,eventAt:seq=>events[seq]}};return agent;
  }
  const persistence={async flush(){},async open(id,mode){assert.equal(mode,'read');const row=rows.get(id);if(!row)throw new Error('missing daily source');return {header:row.header,read:async(from,count)=>({events:structuredClone(row.events.slice(from,from+count))}),close:async()=>{}};}};
  next('我喜欢无糖乌龙茶，以后也可以记住。');
  return {...f,daily,persistence,rows,next,get agent(){return agent;},get calls(){return calls;},async run(changes,review=compile,signal){return daily.run({changes},agent,persistence,frame=>{calls++;return review(frame);},signal);}};
}
function compile(frame,{self=false,verdict='apply'}={}){
  return {decision:{decisions:frame.proposals.map(proposal=>{
    const r=proposal.request,evidence=proposal.evidence;
    const kind=r.target==='long_term'?(r.action==='add'?'native_add':r.action==='replace'?'native_correct':'native_forget'):(r.action==='add'?'runtime_add':r.action==='replace'?'runtime_replace':'runtime_remove');
    const operation={kind,evidence,...r.referenceId?{referenceId:r.referenceId}:{},...r.action!=='remove'?{content:r.content}:{},...kind==='runtime_add'?{target:r.target}:{},...kind==='native_add'?{target:'event',storeId:r.storeId}:{}};
    const operations=verdict==='apply'?[operation]:[];
    if(self&&verdict==='apply'){const state=frame.memories.items.find(row=>row.kind==='self'&&row.key==='trait:纸桥时间');if(state)operations.push({kind:'review_self',referenceId:state.id,becauseRefs:[r.referenceId],evidence});}
    return {proposalIndex:proposal.index,verdict,timing:verdict==='defer'?'uncertain':'current',reason:'隔离测试审核依据完整原话和当前条目。',operations};
  })},provider:'fixture',model:'fixture'};
}
const addition=(quote='我喜欢无糖乌龙茶，以后也可以记住。',content='用户喜欢无糖乌龙茶。')=>[{action:'add',target:'user',content,evidenceQuote:quote,reason:'用户明确陈述可重复使用的偏好。'}];
async function replacement(f,action='replace',target='memory'){
  const ref=(await f.daily.read()).items.find(row=>row.kind==='runtime'&&row.text===old);
  return [{action,target,referenceId:ref.id,expectedContent:ref.text,expectedVersion:ref.version,...action==='replace'?{content:updated}:{},evidenceQuote:f.agent.session.eventAt(1).data.content[0].text,reason:'用户明确更正或撤回当前约定。'}];
}
const undo=(f,id)=>undoBatch(f.protection,id,{kind:'isolated-daily-undo'},{assertOffline:()=>f.offline()});


export {dailyFixture,compile,addition};
