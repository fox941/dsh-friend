import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {QQStickers} from './stickers.js';
import {hash} from './validation.js';

/** Offline migration reads the existing companion database in query-only mode.
 * Only SharedStickerStore writes its own pack; no channel, model or QQ API. */
export async function migrateQQStickers(instance,{assertOffline=async()=>{}}={}){
 await assertOffline();const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true,timeout:5000});
 try{db.exec('PRAGMA query_only=ON');const before=db.prepare('SELECT total_changes() n').get().n,binding=db.prepare('SELECT * FROM qq_bindings WHERE active=1').get();
  if(!binding)return {status:'not_configured',platformWrites:0};
  const decodeMedia=id=>{const row=db.prepare('SELECT * FROM platform_media WHERE id=?').get(id);if(!row)return null;if(hash(row.value_json)!==row.value_hash)throw Error('原媒体记录校验失败');return {id,...JSON.parse(row.value_json)};};
  const store={db,time:()=>new Date().toISOString(),media:decodeMedia,event(id){const row=db.prepare('SELECT * FROM platform_events WHERE id=?').get(id);if(!row)return null;if(hash(row.raw_json)!==row.raw_hash)throw Error('原社交消息校验失败');return {...row,raw:JSON.parse(row.raw_json)};}};
  const channel={binding,store:{get:id=>db.prepare('SELECT * FROM qq_inbox WHERE id=?').get(id),recovery(row){const r=db.prepare('SELECT value FROM platform_meta WHERE key=?').get('qq-recovered-owner:'+row.id);if(!r)return null;const p=JSON.parse(r.value);return p.platformId===row.platform_id&&p.bodyHash===row.body_hash&&p.bindingId===row.binding_id?p:null;}}};
  const library=new QQStickers({instance,store,channel,media:{asset(){throw Error('离线迁移不读取网络或产生新收藏');}}});
  const result=await library.initialize({account:binding.bot_qq,thread:binding.session_id,peer:binding.owner_qq,groupId:null});
  await assertOffline();if(db.prepare('SELECT total_changes() n').get().n!==before)throw Error('离线迁移修改了原数据库');return {...result,existingDatabaseWrites:0};
 }finally{db.close();}
}
