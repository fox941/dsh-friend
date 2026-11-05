import {hash} from './validation.js';
const digest=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const conflict=message=>Object.assign(Error(message),{status:409});
/** Owner administration is separate from collection provenance and model
 * preference. No original row, image, native favorite or send is removed. */
export class StickerControls{
 constructor(library){this.l=library;}
 key(account,id){if(!/^\d{5,12}$/.test(account)||!digest.test(id))throw Error('表情管理标识无效');return 'qq-sticker-control:v1:'+account+':'+id;}
 state(account,id){const row=this.l.store.db.prepare('SELECT value FROM platform_meta WHERE key=?').get(this.key(account,id));if(!row)return {enabled:true,revision:0,updatedAt:null};
  const {value,checksum}=JSON.parse(row.value);if(checksum!==hash(JSON.stringify(value))||value?.schema!==1||value.account!==account||value.stickerId!==id||typeof value.enabled!=='boolean'||!Number.isSafeInteger(value.revision)||value.revision<1)throw Error('表情停用记录校验失败');return {enabled:value.enabled,revision:value.revision,updatedAt:value.updatedAt};
 }
 assertEnabled(account,id){if(!this.state(account,id).enabled)throw Error('表情已由主用户停用，原图和历史保留');}
 set(scope,{stickerId,enabled,expectedRevision,requestId}){
  this.l.checkScope(scope);if(!digest.test(stickerId)||typeof enabled!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!uuid.test(requestId??''))throw Object.assign(Error('表情管理参数无效'),{status:400});
  const item=this.l.rows(scope).find(r=>r.id===stickerId);if(!item)throw Object.assign(Error('没有该表情记录'),{status:404});
  const command={account:scope.account,stickerId,enabled,expectedRevision,requestId},commandHash=hash(JSON.stringify(command)),key='sticker-management:'+scope.account+':'+requestId;
  return this.l.store.journal.transaction(()=>{
   const prior=this.l.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get(key);if(prior){const record=this.l.store.media(prior.id);if(record.commandHash!==commandHash)throw conflict('同一操作标识对应不同请求');return {repeated:true,changed:record.changed,state:this.state(scope.account,stickerId),operationId:record.id};}
   const before=this.state(scope.account,stickerId);if(before.revision!==expectedRevision)throw conflict('状态已被其他操作修改，请刷新后再试');
   if(enabled&&!this.l.shared.valid(item))throw conflict('原来源暂不可用，恢复开关不能使来源重新有效');
   const changed=before.enabled!==enabled,after=changed?{enabled,revision:before.revision+1,updatedAt:this.l.store.time()}:before;
   if(changed){const value={schema:1,account:scope.account,stickerId,...after},raw=JSON.stringify(value);this.l.store.db.prepare('INSERT INTO platform_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key(scope.account,stickerId),JSON.stringify({value,checksum:hash(raw)}));}
   const record=this.l.store.saveMedia(key,{kind:'sticker_management',version:1,commandHash,account:scope.account,stickerId,requestId,source:'owner-ui',changed,before,after,at:this.l.store.time()});return {repeated:false,changed,state:after,operationId:record.id};
  });
 }
}
