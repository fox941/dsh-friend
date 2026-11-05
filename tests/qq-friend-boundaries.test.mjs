import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const src=process.env.FRIEND_ADAPTER_SOURCE??path.resolve(import.meta.dirname,'../plugins/companion-adapter/src'),load=n=>import(pathToFileURL(path.join(src,n))),{Journal}=await load('journal.js'),{Platforms}=await load('platforms.js');
const bot='987654321',owner='123456789',alice='112233445',bob='112233446',group='719030047';
const message=(sender=alice,text='你好',id=1,extra={})=>({post_type:'message',message_type:'private',self_id:Number(bot),user_id:Number(sender),message_id:id,message:[{type:'text',data:{text}}],sender:{user_id:Number(sender),nickname:'同名好友'},...extra});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qq-friend-gate-')),journal=new Journal(root+'/companion'),frames=[],sends=[],wakes=[],learned=[],state={friends:new Set([alice,bob]),lookupFailure:false,lookupMalformed:false,lookups:0,onLookup:null,onConversation:null};
 const adapter={journal,writeEnabled:true,activities:{instance:root},qq:{ready:true,binding:{id:'bound',bot_qq:bot,owner_qq:owner,active:1},connection:{connected:true}},growth:{read:()=>({identityId:'same-character',states:[{kind:'self_description',status:'established',statement:'OWNER-PRIVATE-FACT'}]}),emotions:{context:()=>null}},attention:{offer(){},store:{patch(_id,_status,change){wakes.push(change.wake);}}}};
 const memory={async context(){return {learningAllowed:true,items:[]};},enqueue(e,p){learned.push({event:e.id,proposals:p});},bind(){},async close(){}};
 const clients={async qq(action,params){if(action==='get_friend_list'){state.lookups++;await state.onLookup?.(state.lookups);if(state.lookupFailure)throw Error('temporary native failure');return state.lookupMalformed?{}:[...state.friends].map(user_id=>({user_id:Number(user_id)}));}sends.push({action,params});return {message_id:100+sends.length};}};
 const platforms=new Platforms(adapter,{clients,socialMemory:memory,config:{groups:[group]}});adapter.platforms=platforms;const host={conversation:async frame=>{frames.push(frame);return await state.onConversation?.(frame)??{disposition:'reply',body:'我听到了。',reason:'普通交流',memoryProposals:[]};}};platforms.bind(host);
 t.after(async()=>{await platforms.close();journal.close();const absolute=await fs.realpath(root),temp=await fs.realpath(os.tmpdir());assert.equal(path.dirname(absolute),temp);await fs.rm(absolute,{recursive:true});});
 return {root,journal,platforms,adapter,state,frames,sends,wakes,learned,memory,host,receive:e=>platforms.receive(e),run:id=>platforms.execute({id:'intent-'+id,payload:{platformEventId:id}},new AbortController().signal)};
}
test('each real friend has durable continuous history separate from other friends and group even with the same nickname',async t=>{
 const f=await fixture(t),a=await f.receive(message(alice,'ALICE-PRIVATE-TOPIC',11)),b=await f.receive(message(bob,'BOB-PRIVATE-TOPIC',12));await f.run(a.eventId);await f.run(b.eventId);
 assert.equal(f.frames[0].history.length,0);assert.equal(f.frames[1].history.length,0);assert.equal(f.frames[0].principal.role,'participant');assert.equal(f.frames[0].principal.senderQQ,alice);
 const next=await f.receive(message(alice,'继续刚才的话题',13));await f.run(next.eventId);const own=f.frames.at(-1);assert.ok(own.history.some(h=>h.body==='ALICE-PRIVATE-TOPIC'));assert.ok(!JSON.stringify(own).includes('BOB-PRIVATE-TOPIC'));assert.ok(!JSON.stringify(own).includes('OWNER-PRIVATE-FACT'));
 const g=await f.receive(message(alice,'群里说话',14,{message_type:'group',group_id:Number(group)}));await f.run(g.eventId);assert.ok(!JSON.stringify(f.frames.at(-1)).includes('ALICE-PRIVATE-TOPIC'));
 await f.platforms.close();const reopened=new Platforms(f.adapter,{clients:f.platforms.clients,config:{groups:[group]},socialMemory:f.memory});reopened.bind(f.host);t.after(()=>reopened.close());const r=await reopened.receive(message(alice,'重开后接着聊',15));await reopened.execute({id:'reopened',payload:{platformEventId:r.eventId}},new AbortController().signal);assert.ok(f.frames.at(-1).history.some(h=>h.body==='ALICE-PRIVATE-TOPIC'));
});
test('disabling friend chat cancels a queued friend message before media, model or send',async t=>{
 const f=await fixture(t),r=await f.receive(message());f.platforms.store.configure({friends:false});const result=await f.run(r.eventId);assert.equal(result.status,'cancelled');assert.equal(f.frames.length,0);assert.equal(f.sends.length,0);assert.equal(f.learned.length,0);
});
test('deleting a friend after receipt cancels the old candidate without a model call',async t=>{
 const f=await fixture(t),r=await f.receive(message());f.state.friends.delete(alice);assert.equal((await f.run(r.eventId)).status,'cancelled');assert.equal(f.frames.length,0);assert.equal(f.sends.length,0);
});
test('friend deletion while the model composes cannot send or learn the resulting draft',async t=>{
 const f=await fixture(t),r=await f.receive(message());f.state.onConversation=async()=>{f.state.friends.delete(alice);return {disposition:'reply',body:'尚未发送的正文',reason:'想回答',memoryProposals:[]};};assert.equal((await f.run(r.eventId)).status,'cancelled');assert.equal(f.frames.length,1);assert.equal(f.sends.length,0);assert.equal(f.learned.length,0);
});
test('policy changes during recall prevent model access and changes during expression prevent learning or reply',async t=>{
 const f=await fixture(t),r=await f.receive(message());f.memory.context=async()=>{f.platforms.store.configure({friends:false});return {items:[]};};assert.equal((await f.run(r.eventId)).status,'cancelled');assert.equal(f.frames.length,0);
 f.platforms.store.configure({friends:true});f.memory.context=async()=>({items:[]});const second=await f.receive(message(alice,'第二条',2));f.state.onConversation=async()=>{f.platforms.store.configure({friends:false});return {disposition:'ignore',reason:'不回应',memoryProposals:[]};};assert.equal((await f.run(second.eventId)).status,'cancelled');assert.equal(f.learned.length,0);assert.equal(f.sends.length,0);
});
test('failed or malformed friend lookup parks the original without treating unknown membership as deletion',async t=>{
 const f=await fixture(t),r=await f.receive(message());f.state.lookupFailure=true;assert.equal((await f.run(r.eventId)).pending,true);assert.equal(f.platforms.store.event(r.eventId).status,'queued');assert.equal(f.wakes.at(-1).kind,'time');assert.equal(f.frames.length,0);
 f.state.lookupFailure=false;f.state.lookupMalformed=true;assert.equal((await f.run(r.eventId)).pending,true);assert.equal(f.platforms.store.event(r.eventId).status,'queued');f.state.lookupMalformed=false;assert.equal((await f.run(r.eventId)).status,'sent');assert.equal(f.sends.length,1);
});
test('loss of verified transport during expression waits for a connection event rather than sending or cancelling',async t=>{
 const f=await fixture(t),r=await f.receive(message());f.state.onConversation=async()=>{f.adapter.qq.ready=false;return {disposition:'reply',body:'旧稿',reason:'正常交流'};};assert.equal((await f.run(r.eventId)).pending,true);assert.equal(f.wakes.at(-1).kind,'event');assert.equal(f.platforms.store.event(r.eventId).status,'queued');assert.equal(f.sends.length,0);assert.equal(f.learned.length,0);
});
test('withdrawal or binding changes during a native friend lookup prevent any continuation',async t=>{
 const f=await fixture(t),r=await f.receive(message());f.state.onLookup=async()=>f.platforms.store.eventState(r.eventId,'withdrawn');assert.equal((await f.run(r.eventId)).status,'source_changed');assert.equal(f.frames.length,0);assert.equal(f.sends.length,0);
 f.state.onLookup=null;const second=await f.receive(message(alice,'下一条',2));f.adapter.qq.binding.owner_qq=alice;assert.equal((await f.run(second.eventId)).status,'cancelled');assert.equal(f.frames.length,0);
});
test('a delayed native result cannot bypass a newly disabled friend policy',async t=>{
 const f=await fixture(t),r=await f.receive(message());f.state.onLookup=async()=>f.platforms.store.configure({friends:false});assert.equal((await f.run(r.eventId)).status,'cancelled');assert.equal(f.frames.length,0);assert.equal(f.sends.length,0);
});
