export const relationshipActions=new Set(['qq_friend_add','qq_friend_accept','qq_friend_reject','qq_group_join','qq_group_accept','qq_group_reject']);
const terminal=new Set(['confirmed','rejected','tracking_expired']);
/** Technical readback only; existing attention remains the sole action chooser. */
export class QQRelationships{
 constructor({store,client,channel,now=()=>store.now().valueOf()}){Object.assign(this,{store,client,channel,now});this.running=null;}
 tracks(op){return Boolean(op?.dispatched&&relationshipActions.has(op.action));}
 confirmed(op,verification){if(verification?.verified!==true||op.account!==this.channel.binding?.bot_qq)throw Error('关系确认缺少实际账号及名单依据');return this.store.journal.transaction(()=>{
  const row=this.store.patch(op.id,'confirmed',{verification,relationship:{...op.relationship,status:'confirmed',checkedAt:this.now()}});
  if(['qq_group_join','qq_group_accept','qq_group_leave'].includes(op.action)){
   const id=op.args.groupId??this.store.event(op.args.eventId)?.raw.group_id;
   if(id){const groups=this.store.policy().groups;this.store.configure({groups:op.action==='qq_group_leave'?groups.filter(g=>g!==String(id)):[...groups,String(id)]});}
  }
  return row;
 });}
 async inspect(op,signal){
  if(!this.tracks(op)||op.account!==this.channel.binding?.bot_qq)return op;
  const at=this.now(),startedAt=op.relationship?.startedAt??Date.parse(this.store.db.prepare('SELECT created_at FROM platform_operations WHERE id=?').get(op.id).created_at),deadlineAt=startedAt+7*86400000;
  if(at>=deadlineAt)return this.store.patch(op.id,'unconfirmed',{relationship:{...op.relationship,startedAt,deadlineAt,status:'tracking_expired',checkedAt:at,notice:'跟踪窗口结束；没有证据证明对方拒绝，也不会自动重发'}});
  let evidence;
  try{evidence=await this.client.relationshipEvidence(op,signal);}catch{signal?.throwIfAborted();evidence={status:'unavailable'};}
  const latest=this.store.operation(op.id);if(latest.status!==op.status||latest.relationship?.checkedAt!==op.relationship?.checkedAt)return latest;
  if(evidence.verified===true)return this.confirmed(op,evidence);
  const checks=(op.relationship?.checks??0)+1,relationship={startedAt,deadlineAt,checkedAt:at,nextCheckAt:at+Math.min(900000,60000*2**Math.min(checks-1,4)),checks,status:evidence.status??'unknown',...evidence.requestTime?{requestTime:evidence.requestTime}:{},...evidence.limited?{limited:true}:{}};
  return this.store.patch(op.id,evidence.status==='rejected'?'rejected':op.status,{relationship});
 }
 poll(signal){if(this.running)return this.running;this.running=this.sweep(signal).finally(()=>{this.running=null;});return this.running;}
 async sweep(signal){
  if(!this.channel.ready||this.channel.reliability?.status().classification!=='ready'||this.channel.driving||this.channel.sending||this.channel.platforms?.active)return;
  const rows=this.store.db.prepare("SELECT id FROM platform_operations WHERE account=? AND dispatched=1 AND action IN ('qq_friend_add','qq_friend_accept','qq_friend_reject','qq_group_join','qq_group_accept','qq_group_reject') AND status IN ('accepted','unknown','unconfirmed') AND coalesce(json_extract(value_json,'$.relationship.status'),'') NOT IN ('confirmed','rejected','tracking_expired') AND coalesce(json_extract(value_json,'$.relationship.nextCheckAt'),0)<=? ORDER BY coalesce(json_extract(value_json,'$.relationship.checkedAt'),0),rowid LIMIT 3").all(this.channel.binding.bot_qq,this.now());
  let checked=0;
  for(const row of rows){signal?.throwIfAborted();const op=this.store.operation(row.id);if(terminal.has(op.relationship?.status))continue;if(++checked>3)break;await this.inspect(op,signal);}
 }
 status(){const ops=this.store.db.prepare("SELECT id FROM platform_operations WHERE account=? AND action IN ('qq_friend_add','qq_friend_accept','qq_friend_reject','qq_group_join','qq_group_accept','qq_group_reject','qq_friend_delete','qq_group_leave') ORDER BY rowid DESC LIMIT 30").all(this.channel.binding?.bot_qq??'').map(({id})=>{const op=this.store.operation(id);return {id,action:op.action,status:op.status,target:op.args,relationship:op.relationship??null,verification:op.verification??null};});return {operations:ops,trackingDays:7,source:'Actual bound AI account membership and request evidence; absence is not rejection',writesOnStatusRead:0};}
}
