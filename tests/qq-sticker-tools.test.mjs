import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
import {fixture as qqFixture,module as load} from './qq-fixture.mjs';
const {Platforms}=await load('platforms.js'),{attachPlatforms}=await load('platform-agent.js'),{recoveredToolDenial}=await load('qq-host.js');
const signal=new AbortController().signal,png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSfkAAAAASUVORK5CYII=','base64');
async function setup(t,{sticker=true}={}){
 const f=await qqFixture(t),adapter={journal:f.journal,qq:f.qq,writeEnabled:true,activities:{instance:f.directory},growth:{read:()=>({identityId:'same',states:[]}),emotions:{context:()=>null}},attention:{offer(){},store:{patch(){}}}};
 const platforms=adapter.platforms=new Platforms(adapter);f.qq.platforms=platforms;f.qq.media=platforms.media;
 platforms.media.call=async()=>({base64:png.toString('base64')});platforms.bind({saveImage:async()=>({attachmentId:'test-png'}),vision:async frame=>({description:'一张可爱的猫猫图',stickers:frame.images.map(i=>({assetId:i.assetId,isSticker:sticker,description:'猫猫摊手'}))})});
 const tools=new Map();attachPlatforms({systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}},adapter);
 t.after(()=>platforms.close());return {...f,adapter,platforms,tools,async read(){return tools.get('friend_qq_media_read').execute({},{agent:f.agent,signal});},async tool(name,a={}){return tools.get(name).execute(a,{agent:f.agent,signal});}};
}
async function incoming(f,body='这张表情我觉得挺有意思',sub_type=1){await f.receive(body,{message:[{type:'text',data:{text:body}},{type:'image',data:{file:'sticker.png',sub_type}}]});return f.read();}
test('main QQ tools collect observed bytes, return actual local result and only queue QQ favorite/send',async t=>{
 const f=await setup(t),read=await incoming(f),assetId=read.images[0].assetId;
 const first=await f.tool('friend_qq_sticker_read');assert.equal(first.collectable[0].assetId,assetId);assert.equal(first.items.length,0);
 const saved=await f.tool('friend_qq_sticker_collect',{assetId,caption:'猫猫摊手',tags:['无奈','猫'],reason:'这张摊手表情很适合表达我的无奈'});
 assert.equal(saved.status,'collected');assert.equal(saved.nativeFavorite.status,'queued');
 const found=await f.tool('friend_qq_sticker_read',{query:'猫'});assert.equal(found.items[0].stickerId,saved.stickerId);
 const sent=await f.tool('friend_qq_sticker_send',{stickerId:saved.stickerId,text:'摊手。',reason:'贴合语境'});assert.equal(sent.status,'queued');assert.equal(f.sends.length,0);
});
test('main tool honors NoSave even when a prior readable picture exists',async t=>{
 const f=await setup(t),read=await incoming(f);await f.complete();await f.receive('这条不保存记忆，收藏上一张');
 await assert.rejects(f.tool('friend_qq_sticker_collect',{assetId:read.images[0].assetId,caption:'猫',tags:[],reason:'喜欢'}),/禁止保存/);
});
test('model can autonomously collect a genuine sticker, but ordinary photo needs an actual request',async t=>{
 const f=await setup(t,{sticker:false}),read=await incoming(f,'这是一张普通照片',0),args={assetId:read.images[0].assetId,caption:'照片',tags:[],reason:'喜欢'};
 await assert.rejects(f.tool('friend_qq_sticker_collect',args),/普通照片/);
 await f.complete();await f.receive('把上一张照片当作表情收藏起来');const r=await f.tool('friend_qq_sticker_collect',{...args,syncToQQ:false});assert.equal(r.status,'collected');assert.equal(f.platforms.store.pending().length,0);
});
test('failed QQ favorite enqueue reports local success separately without retry or deletion',async t=>{
 const f=await setup(t),read=await incoming(f);f.platforms.stickers.offerFavorite=async()=>{throw Error('queue full');};
 const r=await f.tool('friend_qq_sticker_collect',{assetId:read.images[0].assetId,caption:'猫',tags:['猫'],reason:'喜欢猫的表情'});
 assert.equal(r.status,'collected');assert.equal(r.nativeFavorite.status,'not_queued');assert.equal((await f.tool('friend_qq_sticker_read')).library.count,1);
});
test('recovered tool gate allows read but denies new sticker collection/send',async t=>{
 const f=await setup(t);await incoming(f);const event=f.events.findLast(e=>e.type==='user/message'),row=f.qq.store.get(event.data.source.principal.inboxId);
 f.journal.db.prepare('INSERT INTO platform_meta VALUES(?,?)').run('qq-recovered-owner:'+row.id,JSON.stringify({platformId:row.platform_id,bodyHash:row.body_hash,bindingId:row.binding_id,historyOnly:false,reason:'fixture historical recovery'}));
 assert.equal(recoveredToolDenial({agent:f.agent,name:'friend_qq_sticker_read'}),undefined);
 assert.equal(typeof recoveredToolDenial({agent:f.agent,name:'friend_qq_sticker_collect'}),'string');
 assert.equal(typeof recoveredToolDenial({agent:f.agent,name:'friend_qq_sticker_send'}),'string');
});
test('GIF visual preview can be static while the stored incoming asset preserves the complete original',async t=>{
 const f=await setup(t),gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');let previewed=0;
 f.platforms.media.call=async()=>({base64:gif.toString('base64')});
 f.platforms.media.previewImages=async(bytes,mediaType)=>{assert.deepEqual(bytes,gif);assert.equal(mediaType,'image/gif');previewed++;return {frames:[{data:png,mediaType:'image/png',timeSeconds:0}],coverage:{kind:'first-frame-only',frameCount:1,timestamps:[0],complete:false}};};
 const r=await incoming(f);assert.equal(previewed,1);assert.equal(r.images[0].visualCoverage,'first-frame-only');assert.equal(r.images[0].mediaType,'image/gif');
 const saved=await f.tool('friend_qq_sticker_collect',{assetId:r.images[0].assetId,caption:'GIF猫猫',tags:['猫'],reason:'喜欢',syncToQQ:false}),scope={account:f.qq.binding.bot_qq,thread:f.qq.binding.session_id,peer:f.qq.binding.owner_qq,groupId:null};
 assert.deepEqual((await f.platforms.stickers.asset(scope,saved.stickerId)).bytes,gif);
});
test('face-only QQ input is admitted as media and preserves actual ID without guessing its meaning',async t=>{
 const f=await setup(t);await f.receive('',{message:[{type:'face',data:{id:'14'}}]});const r=await f.read();assert.equal(r.faces[0].id,'14');assert.equal(r.faces[0].source,'qq_builtin_face_id');assert.equal(r.images.length,0);
});
