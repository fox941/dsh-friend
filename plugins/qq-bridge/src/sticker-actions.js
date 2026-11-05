import {eventStickerScope,stickerScope} from './stickers.js';
import {qqId} from './qq-config.js';

const actions=new Set(['qq_sticker_favorite','qq_send_sticker']);
function scopeFor(client,op){
 if(!client.stickers||!['sticker_collection','sticker_expression'].includes(op.source?.kind))throw Error('表情操作缺少可信收藏/表达来源');
 const scope=stickerScope(op.source.stickerScope);if(scope.account!==op.account)throw Error('表情操作账号不符');
 if(op.source.eventId){const e=client.store.event(op.source.eventId);if(!e||!['queued','sent','ignored'].includes(e.status)||JSON.stringify(stickerScope(eventStickerScope(e)))!==JSON.stringify(scope)||e.raw.historyRecovery)throw Error('表情操作原社交事件失效');}
 if(scope.groupId&&!client.store.policy().groups.includes(scope.groupId))throw Error('表情来源群未接入');
 if(!scope.groupId&&scope.peer!==client.channel.binding.owner_qq&&!client.store.policy().friends)throw Error('好友表情功能已关闭');
 return scope;
}
export async function readNativeFavorites(client,md5){
 const list=await client.qq('fetch_custom_face_detail',{count:512});
 if(!Array.isArray(list)||list.length>512)throw Error('QQ收藏表情详情格式异常');
 // Never expose signed CDN URLs or native IDs to the expression model.
 return {matched:list.some(r=>typeof r.md5==='string'&&r.md5.toLowerCase()===md5),coverage:'first-512',count:list.length};
}
export async function prepareStickerAction(client,op,signal){
 if(!actions.has(op.action))return null;
 const scope=scopeFor(client,op),asset=await client.stickers.asset(scope,op.args.stickerId);signal?.throwIfAborted();
 const state={sha256:asset.row.sha256,description:asset.row.caption,animated:asset.row.mediaType==='image/gif',scope:'ai-shared-library; send-to-current-conversation-only'};
 if(op.action==='qq_sticker_favorite'){
  const current=await readNativeFavorites(client,asset.row.md5);return {account:op.account,stickerAsset:asset,target:{stickerId:asset.row.id},state:{...state,alreadyFavorite:current.matched}};
 }
 if(op.args.userId!==undefined||op.args.groupId!==undefined)throw Error('表情表达只能发送回原会话，不接受其他目标');
 let target;if(scope.groupId){target={groupId:qqId(scope.groupId)};}else{const userId=qqId(scope.peer);if(userId!==client.channel.binding.owner_qq){const friends=await client.qq('get_friend_list');if(!Array.isArray(friends)||!friends.some(f=>String(f.user_id)===userId))throw Error('表情接收人已不是已核验好友');}target={userId};}
 if(op.args.text!==undefined&&(typeof op.args.text!=='string'||op.args.text.length>1000))throw Error('表情附文超长');
 return {account:op.account,stickerAsset:asset,target:{...target,stickerId:asset.row.id,text:op.args.text??''},state};
}
export async function writeStickerAction(client,op,prepared,signal,onDispatch){
 if(!actions.has(op.action))return null;
 const scope=scopeFor(client,op),asset=await client.stickers.asset(scope,op.args.stickerId);signal?.throwIfAborted();
 if(asset.row.sha256!==prepared.stickerAsset.row.sha256)throw Error('提交前表情变化');
 if(String((await client.qq('get_login_info')).user_id)!==op.account)throw Error('QQ收藏/发送账号变化');
 if(op.action==='qq_sticker_favorite'){
  client.stickers.controls.assertEnabled(scope.account,op.args.stickerId);onDispatch();const v=await client.qq('add_custom_face',{file:asset.file,md5:asset.row.md5,file_name:'sticker'+asset.file.slice(asset.file.lastIndexOf('.')),file_size:asset.bytes.length,is_origin:true});
  if(v&&typeof v.result!=='undefined'&&Number(v.result)!==0)throw Object.assign(Error('QQ拒绝收藏表情'),{definitive:true});
  return {submitted:true,apiAccepted:v?.result!==undefined&&Number(v.result)===0,notice:'已尝试添加；需实际收藏列表匹配才能确认'};
 }
 const t=prepared.target,message=[...t.text?[{type:'text',data:{text:t.text}}]:[],{type:'image',data:{file:'base64://'+asset.bytes.toString('base64'),sub_type:1,summary:'[表情]'}}];
 client.stickers.controls.assertEnabled(scope.account,op.args.stickerId);onDispatch();const ack=await client.qq(t.groupId?'send_group_msg':'send_private_msg',{...t.groupId?{group_id:Number(t.groupId)}:{user_id:Number(t.userId)},message});
 if(!ack?.message_id)throw Error('QQ表情发送回执缺失');return {apiAccepted:true,platformId:String(ack.message_id),kind:'sticker',stickerId:asset.row.id};
}
export async function verifyStickerAction(client,op,signal){
 if(!actions.has(op.action))return {handled:false};
 const scope=scopeFor(client,op),asset=await client.stickers.asset(scope,op.args.stickerId);signal?.throwIfAborted();
 if(op.action==='qq_sticker_favorite'){const r=await readNativeFavorites(client,asset.row.md5);return {handled:true,result:r.matched?{verified:true,state:{favorite:true,md5Matched:true,coverage:r.coverage}}:null};}
 return {handled:true,result:op.receipt?.apiAccepted===true&&typeof op.receipt.platformId==='string'?{verified:true,platformId:op.receipt.platformId,recipientRead:false,state:{apiAccepted:true}}:null};
}
