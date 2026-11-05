import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {scene,src,bot,owner,alice,bob,group} from './qq-scene-integrity-fixture.mjs';
const require=createRequire(src+'/../package.json'),bridge=n=>import(pathToFileURL(require.resolve('@ai-friend/qq-bridge/'+n)));
const {QQStickers,eventStickerScope,stickerScope}=await bridge('stickers'),{QQStore}=await bridge('store'),{migrateQQStickers}=await bridge('sticker-migration');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSfkAAAAASUVORK5CYII=','base64'),hash=v=>createHash('sha256').update(v).digest('hex');
const signal=new AbortController().signal;
async function image(f,{sender=alice,groupId,bytes=png,body='看看这张表情'}={}){
 f.platforms.media.call=async()=>({base64:bytes.toString('base64')});f.platforms.media.host={saveImage:async()=>({attachmentId:'fixture'}),vision:async frame=>({description:'猫猫摊手，感觉无奈',stickers:frame.images.map(i=>({assetId:i.assetId,isSticker:true,description:'猫猫摊手，感觉无奈'}))})};
 const event=await f.receive(body,{sender,groupId,segments:[{type:'text',data:{text:body}},{type:'image',data:{file:'meme.png',sub_type:1}}]}),inputId=f.platforms.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('input:social:'+event.id).id;
 await f.platforms.media.read(inputId,signal);const scope=eventStickerScope(event),candidate=f.platforms.stickers.observed(scope,{inputId})[0];return {event,scope,candidate,bytes};
}
const metadata={caption:'私聊中约好的内部称呼PRIVATE-CAPTION',tags:['猫猫','PRIVATE-TAG'],reason:'PRIVATE-REASON 是私聊里的事，不应进入其他人的选图提示'};
const collect=(f,v,data=metadata)=>f.platforms.stickers.collect(v.scope,v.candidate,data,signal);
const library=f=>new QQStickers({instance:f.root,store:f.platforms.store,media:f.platforms.media,channel:f.adapter.qq});
async function legacy(f,v,{caption='旧收藏',reason='旧喜欢理由',tags=['猫猫'],corruptMetadata=false}={}){
 const scope=stickerScope(v.scope),dir=f.platforms.stickers.legacyScopeRoot(scope),id=hash(v.bytes),relative='memes/'+id+'.png';await fs.mkdir(path.join(dir,'memes'),{recursive:true});await fs.writeFile(path.join(dir,relative),v.bytes);
 const data={id,path:relative,scope,sha256:id,md5:createHash('md5').update(v.bytes).digest('hex'),bytes:v.bytes.length,mediaType:'image/png',caption,tags,reason,createdAt:'2026-11-01T00:00:00Z',source:{inputId:v.candidate.inputId,observationId:v.candidate.observationId,assetId:v.candidate.assetId}},raw=JSON.stringify(data);
 const db=new DatabaseSync(dir+'/index.db');try{db.exec('CREATE TABLE IF NOT EXISTS memes(path TEXT PRIMARY KEY,tag TEXT,file_name TEXT,caption TEXT,keywords TEXT,mtime REAL,captioned_at REAL);CREATE TABLE IF NOT EXISTS sticker_meta(path TEXT PRIMARY KEY,value_json TEXT NOT NULL,value_hash TEXT NOT NULL)');db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?,?)').run(relative,'猫猫',id+'.png',caption,tags.join(' '),1,1);db.prepare('INSERT INTO sticker_meta VALUES(?,?,?)').run(relative,raw,corruptMetadata?'0'.repeat(64):hash(raw));}finally{db.close();}
 return {dir,id,file:dir+'/'+relative,data};
}
async function snapshot(dir){const out={};async function walk(p,prefix=''){for(const e of await fs.readdir(p,{withFileTypes:true})){if(e.isDirectory())await walk(p+'/'+e.name,prefix+e.name+'/');else out[prefix+e.name]=hash(await fs.readFile(p+'/'+e.name));}}await walk(dir);return out;}

test('all known QQ destinations share the image, never private caption/tags/reason or source identifiers',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v),dest={account:bot,thread:'qq-group:'+bot+':'+group,groupId:group};
 const view=f.platforms.stickers.search(dest,'猫');assert.equal(view.items[0].stickerId,saved.stickerId);assert.equal(view.scope,'ai-shared-library');
 const raw=JSON.stringify(view);for(const privatePart of ['PRIVATE-CAPTION','PRIVATE-TAG','PRIVATE-REASON',v.event.id,v.candidate.assetId,alice])assert(!raw.includes(privatePart));
 assert.equal(view.items[0].description,'猫猫摊手，感觉无奈');assert.deepEqual(view.items[0].tags,['猫猫']);
 assert(f.platforms.stickers.rows(dest)[0].origins[0].reason.includes('PRIVATE-REASON'));
});
test('private collection can actually be sent through group reply without private conversation memory entering frame',async t=>{
 const f=await scene(t),v=await image(f,{body:'PRIVATE-CHAT-TEXT'}),saved=await collect(f,v),event=await f.receive('今天有点无奈',{sender:owner,groupId:group});
 f.state.decisions=[{disposition:'reply',replyFormat:'sticker',stickerId:saved.stickerId,body:'摊手。',reason:'这张贴合当前对话'}];assert.equal((await f.run(event)).status,'sent');
 assert.equal(f.state.sends.find(s=>s.action==='send_group_msg').params.group_id,Number(group));
 const frame=JSON.stringify(f.state.frames.at(-1));for(const text of ['PRIVATE-CHAT-TEXT','PRIVATE-CAPTION','PRIVATE-REASON'])assert(!frame.includes(text));
});
test('group collection can actually be sent to a different known friend',async t=>{
 const f=await scene(t),v=await image(f,{groupId:group}),saved=await collect(f,v),e=await f.receive('发个无奈的表情吧',{sender:bob});
 f.state.decisions=[{disposition:'reply',replyFormat:'sticker',stickerId:saved.stickerId,body:'',reason:'用表情回应'}];assert.equal((await f.run(e)).status,'sent');
 assert.equal(f.state.sends.find(s=>s.action==='send_private_msg').params.user_id,Number(bob));
});
test('concurrent copies from two conversations become one blob with two internal provenance records',async t=>{
 const f=await scene(t),a=await image(f),b=await image(f,{groupId:group});await Promise.all([collect(f,a),collect(f,b)]);
 const rows=f.platforms.stickers.rows(a.scope);assert.equal(rows.length,1);assert.equal(rows[0].origins.length,2);assert.equal((await fs.readdir(f.platforms.stickers.scopeRoot(a.scope)+'/memes')).length,1);
});
test('repeated collection within one conversation preserves original provenance and does not grow it on every repost',async t=>{
 const f=await scene(t),a=await image(f);await collect(f,a);const b=await image(f);assert.equal((await collect(f,b)).status,'already_collected');assert.equal(f.platforms.stickers.rows(a.scope)[0].origins.length,1);
});
test('withdrawn one-of-two origins retains the independent valid origin; withdrawing both disables without deleting',async t=>{
 const f=await scene(t),a=await image(f),b=await image(f,{groupId:group}),saved=await collect(f,a);await collect(f,b);f.platforms.store.eventState(a.event.id,'withdrawn');
 assert.equal(f.platforms.stickers.search(b.scope,'猫').items.length,1);await f.platforms.stickers.asset(b.scope,saved.stickerId);
 f.platforms.store.eventState(b.event.id,'withdrawn');assert.equal(f.platforms.stickers.search(b.scope,'猫').items.length,0);assert.equal(f.platforms.stickers.status(b.scope).count,1);
});
test('same actor account is required even when all its conversations share',async t=>{
 const f=await scene(t),v=await image(f),saved=await collect(f,v);assert.throws(()=>f.platforms.stickers.search({...v.scope,account:'999999999'},'猫'));
 await assert.rejects(f.platforms.stickers.asset({...v.scope,account:'999999999'},saved.stickerId));
});
test('legacy migration merges duplicates, preserves unique files, original captions/reasons and all old directories',async t=>{
 const f=await scene(t),a=await image(f),b=await image(f,{groupId:group}),c=await image(f,{sender:bob,bytes:Buffer.concat([png,Buffer.from('second')])});
 const old=await Promise.all([legacy(f,a,{reason:'PRIVATE-FIRST'}),legacy(f,b,{reason:'PRIVATE-GROUP'}),legacy(f,c)]),before=await Promise.all(old.map(o=>snapshot(o.dir)));
 const r=await f.platforms.stickers.initialize(a.scope);assert.equal(r.status,'completed');assert.equal(r.imported,3);assert.equal(r.uniqueImages,2);
 const rows=f.platforms.stickers.rows(a.scope);assert.equal(rows.find(v=>v.id===old[0].id).origins.length,2);
 for(let i=0;i<old.length;i++)assert.deepEqual(await snapshot(old[i].dir),before[i]);
 assert.deepEqual((await f.platforms.stickers.asset(a.scope,old[2].id)).bytes,c.bytes);
 assert(!JSON.stringify(f.platforms.stickers.search(a.scope,'猫')).includes('PRIVATE-'));
});
test('reopening migration reuses durable import receipts without duplicate rows or source entries',async t=>{
 const f=await scene(t),v=await image(f),old=await legacy(f,v);await f.platforms.stickers.initialize(v.scope);const fresh=library(f),r=await fresh.initialize(v.scope);
 assert.equal(r.imported,0);assert.equal(r.reused,1);assert.equal(fresh.rows(v.scope).length,1);assert.equal(fresh.rows(v.scope)[0].origins.length,1);assert.deepEqual((await fresh.asset(v.scope,old.id)).bytes,png);
});
test('an interrupted/uncommitted blob is reused by hash on restart instead of duplicating or overwriting',async t=>{
 const f=await scene(t),v=await image(f),old=await legacy(f,v),shared=f.platforms.stickers.scopeRoot(v.scope);await fs.mkdir(shared+'/memes',{recursive:true});await fs.writeFile(shared+'/memes/'+old.id+'.png',png);
 assert.equal((await f.platforms.stickers.initialize(v.scope)).imported,1);assert.equal((await fs.readdir(shared+'/memes')).length,1);assert.equal(f.platforms.stickers.rows(v.scope).length,1);
});
test('one per-row failure leaves a partial report and restart imports only the missing row',async t=>{
 const f=await scene(t),a=await image(f),b=await image(f,{sender:bob,bytes:Buffer.concat([png,Buffer.from('new')])});await legacy(f,a);await legacy(f,b);
 const backend=f.platforms.stickers.shared,original=backend.persist.bind(backend);let failed=false;backend.persist=async(...args)=>{if(!failed){failed=true;throw Error('injected filesystem failure');}return original(...args);};
 const first=await f.platforms.stickers.initialize(a.scope);assert.equal(first.status,'partial');assert.equal(first.issues.length,1);
 const fresh=library(f),r=await fresh.initialize(a.scope);assert.equal(r.status,'completed');assert.equal(r.imported,1);assert.equal(r.reused,1);assert.equal(r.uniqueImages,2);
});
test('corrupt old metadata is reported and preserved rather than used for cross-chat sending',async t=>{
 const f=await scene(t),v=await image(f),old=await legacy(f,v,{corruptMetadata:true}),before=await snapshot(old.dir),r=await f.platforms.stickers.initialize(v.scope);
 assert.equal(r.status,'partial');assert.equal(r.issues.length,1);assert.equal(r.uniqueImages,0);assert.deepEqual(await snapshot(old.dir),before);
});
test('migration preserves all old unique images even above the new shared collection cap',async t=>{
 const f=await scene(t),a=await image(f),b=await image(f,{sender:bob,bytes:Buffer.concat([png,Buffer.from('second')])});await legacy(f,a);await legacy(f,b);f.platforms.stickers.maxItems=1;
 assert.equal((await f.platforms.stickers.initialize(a.scope)).uniqueImages,2);const c=await image(f,{bytes:Buffer.concat([png,Buffer.from('third')])});await assert.rejects(collect(f,c),/容量/);assert.equal(f.platforms.stickers.rows(a.scope).length,2);
});
test('global native-favorite proposal dedup finds existing old per-conversation receipts and never revives cancellation',async t=>{
 const f=await scene(t),a=await image(f),b=await image(f,{groupId:group}),saved=await collect(f,a),source={kind:'sticker_collection',stickerScope:a.scope,eventId:a.event.id};
 const prior=await f.platforms.offer('qq_sticker_favorite',{stickerId:saved.stickerId},'先前收藏',source,'old-scoped-key');f.platforms.store.patch(prior.operationId,'cancelled');
 const current=await f.platforms.stickers.offerFavorite(b.scope,saved.stickerId,{kind:'sticker_collection',eventId:b.event.id});assert.equal(current.operationId,prior.operationId);assert.equal(current.status,'cancelled');assert.equal(f.platforms.store.db.prepare("SELECT count(*) n FROM platform_operations WHERE action='qq_sticker_favorite'").get().n,1);
});
test('offline migration keeps the companion database rows and pending operations byte-for-byte unchanged',async t=>{
 const f=await scene(t),qqStore=new QQStore(f.journal),binding=qqStore.bind({configured:true,bindingId:'11111111-1111-4111-8111-111111111111',botQQ:bot,ownerQQ:owner});f.adapter.qq.binding=binding;
 const v=await image(f,{groupId:group});await legacy(f,v);f.platforms.store.offer('qq_sticker_favorite',{args:{stickerId:hash(png)},reason:'保留的旧候选',source:{kind:'sticker_collection',eventId:v.event.id,stickerScope:v.scope}},'old-op',bot);
 const tables=()=>Object.fromEntries(f.journal.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,f.journal.db.prepare('SELECT * FROM "'+name+'"').all()]));
 const before=tables(),r=await migrateQQStickers(f.root);assert.equal(r.status,'completed');assert.equal(r.existingDatabaseWrites,0);assert.deepEqual(tables(),before);
});
