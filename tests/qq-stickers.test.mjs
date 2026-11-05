import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {scene,src,bot,owner,alice,bob,group} from './qq-scene-integrity-fixture.mjs';
const require=createRequire(src+'/../package.json');
const {QQStickers,eventStickerScope}=await import(pathToFileURL(require.resolve('@ai-friend/qq-bridge/stickers')));
const {QQAccountClient}=await import(pathToFileURL(require.resolve('@ai-friend/qq-bridge/accounts')));
const {conversationProblem,reviewQQConversation}=await import(pathToFileURL(src+'/qq-conversation-protocol.js'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSfkAAAAASUVORK5CYII=','base64');
async function image(f,{sender=alice,groupId,body='这张猫猫表情挺有趣',sticker=true,bytes=png,forward=false}={}){
 f.platforms.media.call=async()=>({base64:bytes.toString('base64')});
 f.platforms.media.host={saveImage:async()=>({attachmentId:'fixture'}),vision:async frame=>({description:'猫猫摊手，无奈的表情',stickers:frame.images.map(i=>({assetId:i.assetId,isSticker:sticker,description:'猫猫摊手，无奈'}))})};
 const event=await f.receive(body,{sender,groupId,segments:[{type:'text',data:{text:body}},{type:'image',data:{file:'fixture.png',sub_type:sticker?1:0}}]});
 const id=f.platforms.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('input:social:'+event.id).id;
 await f.platforms.media.read(id,new AbortController().signal);
 const scope=eventStickerScope(event),candidate=f.platforms.stickers.observed(scope,{inputId:id})[0];
 return {event,scope,candidate,inputId:id};
}
const collect=(f,v,changes={})=>f.platforms.stickers.collect(v.scope,v.candidate,{caption:'猫猫摊手，表示无奈',tags:['无奈','猫猫'],reason:'我喜欢它用摊手表达无奈的感觉',...changes},new AbortController().signal);
function native(f,{failWrite=false,neverMatch=false,account=bot}={}){
 const calls=[],favorites=[];f.adapter.qq.connection.call=async(action,a)=>{calls.push({action,args:a});if(action==='get_login_info')return {user_id:account};if(action==='fetch_custom_face_detail')return favorites;if(action==='get_friend_list')return [{user_id:alice},{user_id:bob}];if(action==='add_custom_face'){if(failWrite)throw Error('network acknowledgement lost');if(!neverMatch)favorites.push({md5:a.md5.toUpperCase(),url:'https://secret.invalid/signed'});return {result:0};}if(action.startsWith('send_'))return {message_id:'246813579'};throw Error('Unexpected method '+action);};
 const client=new QQAccountClient({channel:f.adapter.qq,instance:f.root,store:f.platforms.store,media:f.platforms.media});client.stickers=f.platforms.stickers;f.platforms.clients=client;
 f.platforms.host.operation=async()=>({decision:'execute',reason:'我想收藏/表达，实际核对范围后执行'});return {calls,favorites,client};
}
async function favorite(f,v,saved){return f.platforms.offer('qq_sticker_favorite',{stickerId:saved.stickerId},'喜欢这张表情',{kind:'sticker_collection',eventId:v.event.id,stickerScope:v.scope},'favorite-'+saved.stickerId);}
const runOp=(f,r)=>f.platforms.execute({id:'intent-'+r.operationId,payload:{platformActionId:r.operationId}},new AbortController().signal);

test('shared persistent collection reuses dsh-meme search and keeps exact image bytes after reopening',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v);assert.equal(saved.status,'collected');
 const library=new QQStickers({instance:f.root,store:f.platforms.store,media:f.platforms.media,channel:f.adapter.qq});
 assert.equal(library.search(v.scope,'猫猫 无奈').items[0].stickerId,saved.stickerId);
 assert.deepEqual((await library.asset(v.scope,saved.stickerId)).bytes,png);assert.equal(library.status(v.scope).count,1);
 assert.equal(f.journal.db.prepare('SELECT count(*) n FROM platform_operations').get().n,0);
});
test('same bytes collected twice are idempotent and retain the original reason',async t=>{
 const f=await scene(t),v=await image(f),first=await collect(f,v),second=await collect(f,v,{reason:'另一个理由'});
 assert.equal(second.status,'already_collected');assert.equal(f.platforms.stickers.rows(v.scope)[0].origins[0].reason,'我喜欢它用摊手表达无奈的感觉');assert.equal('likeReason' in first,false);assert.equal(f.platforms.stickers.status(v.scope).count,1);
});
test('same-AI private, other-friend and group destinations share collected images while collection still needs local source',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v);
 const other={...v.scope,peer:bob,thread:'qq-private:'+bot+':'+bob},publicScope={account:bot,thread:'qq-group:'+bot+':'+group,groupId:group};
 assert.equal(f.platforms.stickers.search(other,'猫').items[0].stickerId,saved.stickerId);
 assert.equal(f.platforms.stickers.search(publicScope,'猫').items[0].stickerId,saved.stickerId);
 assert.deepEqual((await f.platforms.stickers.asset(other,saved.stickerId)).bytes,png);
 assert.deepEqual((await f.platforms.stickers.asset(publicScope,saved.stickerId)).bytes,png);
 await assert.rejects(f.platforms.stickers.collect(other,v.candidate,{caption:'猫',reason:'喜欢',tags:[]}));
 await assert.rejects(f.platforms.stickers.asset({...other,account:'999999999'},saved.stickerId));
});
test('NoSave and test sources have no collectible candidates or lasting library',async t=>{
 for(const body of ['接入测试，不保存记忆，请看表情','不要保存这张图']){const f=await scene(t),v=await image(f,{body});assert.equal(v.candidate,undefined);assert.equal(f.platforms.stickers.status(v.scope).count,0);assert.equal(f.state.sends.length,0);}
});
test('unread and fabricated observation references cannot be collected',async t=>{
 const f=await scene(t),v=await image(f);await assert.rejects(collect(f,{...v,candidate:{...v.candidate,observationId:'invented'}}));
 await assert.rejects(collect(f,{...v,candidate:{...v.candidate,assetId:'invented'}}));assert.equal(f.platforms.stickers.status(v.scope).count,0);
});
test('withdrawn source disables a prior collection without deleting its record or bytes',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v);f.platforms.store.eventState(v.event.id,'withdrawn');
 assert.equal(f.platforms.stickers.search(v.scope,'猫').items.length,0);await assert.rejects(f.platforms.stickers.asset(v.scope,saved.stickerId));assert.equal(f.platforms.stickers.status(v.scope).count,1);
});
test('on-disk modification invalidates a sticker before sending',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v),asset=await f.platforms.stickers.asset(v.scope,saved.stickerId);
 await fs.writeFile(asset.file,Buffer.concat([png,Buffer.from('changed')]));await assert.rejects(f.platforms.stickers.asset(v.scope,saved.stickerId));assert.equal(f.state.sends.length,0);
});
test('capacity stops new collection without deleting an earlier favorite',async t=>{
 const f=await scene(t),v=await image(f);f.platforms.stickers.maxItems=1;const old=await collect(f,v),next=await image(f,{bytes:Buffer.concat([png,Buffer.from('next')])});
 await assert.rejects(collect(f,next),/容量/);assert.deepEqual((await f.platforms.stickers.asset(v.scope,old.stickerId)).bytes,png);
});
test('a junction cannot redirect collection into another directory',async t=>{
 const f=await scene(t),v=await image(f),foreign=f.root+'/unrelated',library=f.platforms.stickers.scopeRoot(v.scope);
 await fs.mkdir(foreign);await fs.mkdir(f.platforms.stickers.root,{recursive:true});await fs.symlink(foreign,library,'junction');
 try{await assert.rejects(collect(f,v),/联接|符号链接/);assert.deepEqual(await fs.readdir(foreign),[]);}finally{await fs.unlink(library);}
});
test('image-only sticker reply goes through the actual social send path once',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v);f.state.decisions=[{disposition:'reply',replyFormat:'sticker',stickerId:saved.stickerId,body:'',reason:'一张摊手就能表达我此刻的无奈'}];
 const r=await f.run(v.event);assert.equal(r.status,'sent');const send=f.state.sends.find(s=>s.action==='send_private_msg');
 assert.equal(send.params.user_id,Number(alice));assert.equal(send.params.message.length,1);assert.equal(send.params.message[0].data.sub_type,1);assert.deepEqual(Buffer.from(send.params.message[0].data.file.slice(9),'base64'),png);
 assert.equal(r.receipt.reply.stickerId,saved.stickerId);
});
test('group sticker stays in original group and can have accompanying text',async t=>{
 const f=await scene(t),v=await image(f,{groupId:group}),saved=await collect(f,v);f.state.decisions=[{disposition:'reply',replyFormat:'sticker',stickerId:saved.stickerId,body:'有点无奈。',reason:'贴合当前语境'}];
 const r=await f.run(v.event);assert.equal(r.status,'sent');const send=f.state.sends.find(s=>s.action==='send_group_msg');assert.equal(send.params.group_id,Number(group));assert.equal(send.params.message[0].data.text,'有点无奈。');
});
test('model may collect without replying, and QQ native sync is only queued',async t=>{
 const f=await scene(t),v=await image(f);f.state.decisions=[{disposition:'ignore',reason:'我先收下这张喜欢的表情，暂时不接话',stickerCollections:[{assetId:v.candidate.assetId,caption:'猫猫摊手',tags:['无奈'],reason:'这种表达合我心意'}]}];
 const r=await f.run(v.event);assert.equal(r.status,'ignored');assert.equal(f.platforms.stickers.status(v.scope).count,1);
 assert.equal(f.platforms.store.pending()[0].action,'qq_sticker_favorite');assert.equal(f.state.sends.length,0);
});
test('normal photo is not offered as a sticker collection candidate by the model contract',async t=>{
 const f=await scene(t),v=await image(f,{sticker:false,body:'这是一张私人照片'});assert.equal(v.candidate.stickerCandidate,false);
 f.state.decisions=[{disposition:'ignore',reason:'这不是表情，正常看图即可'}];await f.run(v.event);
 assert.equal(f.platforms.stickers.status(v.scope).count,0);
});
test('native favorite requires MD5 readback and a repeated completed operation never resubmits',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v),n=native(f),op=await favorite(f,v,saved);
 const result=await runOp(f,op);assert.equal(result.status,'confirmed');const stored=f.platforms.store.operation(op.operationId);assert.equal(stored.verification.state.md5Matched,true);
 await runOp(f,op);assert.equal(n.calls.filter(c=>c.action==='add_custom_face').length,1);assert(!JSON.stringify(stored.before).includes('secret.invalid'));
});
test('existing native favorite is a no-op with no second upload',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v),n=native(f);n.favorites.push({md5:(await f.platforms.stickers.asset(v.scope,saved.stickerId)).row.md5});
 const result=await runOp(f,await favorite(f,v,saved));assert.equal(result.status,'noop');assert.equal(n.calls.filter(c=>c.action==='add_custom_face').length,0);
});
test('unknown native submission never gets retried even when its favorite is not yet visible',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v),n=native(f,{failWrite:true}),op=await favorite(f,v,saved);
 assert.equal((await runOp(f,op)).status,'unknown');await runOp(f,op);await runOp(f,op);
 assert.equal(n.calls.filter(c=>c.action==='add_custom_face').length,1);assert.equal(f.platforms.stickers.status(v.scope).count,1);
});
test('API result zero alone does not certify QQ favorites',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v),n=native(f,{neverMatch:true}),op=await favorite(f,v,saved);
 assert.equal((await runOp(f,op)).pending,true);assert.equal(f.platforms.store.operation(op.operationId).status,'accepted');assert.equal(n.calls.filter(c=>c.action==='add_custom_face').length,1);
});
test('wrong actual QQ account prevents native favorite or send',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v),n=native(f,{account:owner});
 assert.equal((await runOp(f,await favorite(f,v,saved))).status,'failed');assert.equal(n.calls.filter(c=>c.action==='add_custom_face').length,0);
});
test('queued main-channel sticker uses its trusted original scope and real platform receipt',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v),n=native(f),source={kind:'sticker_expression',stickerScope:v.scope,eventId:v.event.id};
 const op=await f.platforms.offer('qq_send_sticker',{stickerId:saved.stickerId,text:'摊手。'},'用表情表达',source,'send-one');assert.equal((await runOp(f,op)).status,'confirmed');
 const send=n.calls.find(c=>c.action==='send_private_msg');assert.equal(send.args.user_id,Number(alice));assert.equal(send.args.message.at(-1).data.sub_type,1);
});
test('arbitrary receiver and untrusted generic platform action cannot bypass sticker scope',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v),n=native(f);
 for(const [source,args] of [[{kind:'model_proposal'},{stickerId:saved.stickerId}],[{kind:'sticker_expression',stickerScope:v.scope},{stickerId:saved.stickerId,userId:bob}]]){
  const op=await f.platforms.offer('qq_send_sticker',args,'scope check',source,JSON.stringify([source,args]));assert.equal((await runOp(f,op)).status,'failed');
 }assert.equal(n.calls.filter(c=>c.action.startsWith('send_')).length,0);
});
test('reply format validates real candidate IDs and rejects invented collection sources',()=>{
 const id='a'.repeat(64),frame={event:{kind:'friend'},replyOptions:{formats:['text','sticker'],stickers:[{stickerId:id}],collectable:[]}};
 assert.equal(conversationProblem({disposition:'reply',reason:'表达',replyFormat:'sticker',stickerId:id,body:''},frame),null);
 assert.equal(conversationProblem({disposition:'reply',reason:'表达',replyFormat:'sticker',stickerId:'b'.repeat(64),body:''},frame),'invalid_sticker_id');
 assert.equal(conversationProblem({disposition:'ignore',reason:'先不回复',stickerCollections:[{assetId:'invented',caption:'图',tags:[],reason:'喜欢'}]},frame),'invalid_sticker_collection');
});
test('fact repair cannot add new sticker collection side effects',async()=>{
 const frame={event:{kind:'friend'},replyOptions:{formats:['text'],collectable:[{assetId:'x',stickerCandidate:true}]}},original={disposition:'reply',reason:'自然回应',body:'尚未核实'};let n=0;
 const result=await reviewQQConversation(frame,new AbortController().signal,async()=>({decision:++n===1?original:{...original,stickerCollections:[{assetId:'x',caption:'图',tags:[],reason:'喜欢'}]}}),()=>{},()=>n===1?'reply_facts_unverified:unsupported':null);
 assert.equal(result.decision.stickerCollections,undefined);assert.equal(n,2);
});
