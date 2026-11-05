const validId=value=>typeof value==='string'&&/^[1-9]\d{4,11}$/.test(value);
const numeric=value=>typeof value==='string'&&/^\d{1,24}$/.test(value);
const account=core=>String(core.selfInfo?.uin??'');
const seconds=()=>Math.floor(Date.now()/1000);
function friendRow(row,now=seconds()){
 return row&&row.isInitiator===false&&row.isDoubt!==true&&typeof row.friendUid==='string'&&row.friendUid.length<=100&&/^\d{10}$/.test(String(row.reqTime))&&Number(row.reqTime)>=1577836800&&Number(row.reqTime)<=now+30&&Number.isInteger(row.reqType);
}
function groupRow(row,core,now=seconds()){
 if(!row||row.type!==1||!numeric(row.seq)||!validId(String(row.group?.groupCode))||typeof row.user2?.uid!=='string')return false;
 if(row.user1?.uid&&core.selfInfo?.uid&&row.user1.uid!==core.selfInfo.uid)return false;
 const time=Number(BigInt(row.seq)/1000000n);return time>=1577836800&&time<=now+30&&Number.isInteger(row.status);
}
async function lists(core,kind){
 if(kind==='friend'){const data=await core.apis.FriendApi.getBuddyReq();if(!Array.isArray(data?.buddyReqs))throw Error('incoming_friend_list_unavailable');return data.buddyReqs;}
 const data=await core.apis.GroupApi.getSingleScreenNotifies(false,50);if(!Array.isArray(data))throw Error('incoming_group_list_unavailable');return data;
}
async function uin(core,uid){const result=String(await core.apis.UserApi.getUinByUidV2(uid)??'');if(!validId(result)||result===account(core))throw Error('incoming_sender_unverified');return result;}
export async function incomingList(core,kind,{limit=50}={}){
 if(!['friend','group'].includes(kind)||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('invalid_incoming_query');
 const rows=await lists(core,kind),events=[],scanned=rows.slice(0,1000),pending=scanned.filter(row=>kind==='friend'?friendRow(row)&&row.isDecide===false&&row.reqType===1:groupRow(row,core)&&row.status===1).sort((a,b)=>kind==='friend'?Number(b.reqTime)-Number(a.reqTime):BigInt(a.seq)<BigInt(b.seq)?1:-1);let excluded=scanned.length-pending.length;
 for(const row of pending.slice(0,limit)){
  try{const sender=await uin(core,kind==='friend'?row.friendUid:row.user2.uid);events.push({post_type:'request',self_id:account(core),request_type:kind,user_id:sender,flag:kind==='friend'?String(row.reqTime):row.seq,comment:String(kind==='friend'?row.extWords??'':row.postscript??'').slice(0,2000),time:kind==='friend'?Number(row.reqTime):Number(BigInt(row.seq)/1000000n),...kind==='group'?{sub_type:'invite',group_id:String(row.group.groupCode)}:{}});}catch{excluded++;}
 }
 return {events,count:rows.length,limited:rows.length>=1000||pending.length>limit||kind==='group'&&rows.length>=50,excluded,scope:kind==='friend'?'ordinary-incoming-only':'self-invitations-only'};
}
async function resolve(core,input){
 const {kind,flag,userId,groupId}=input;
 if(!['friend','group'].includes(kind)||!numeric(flag)||!validId(userId)||userId===account(core)||kind==='friend'&&!/^\d{10}$/.test(flag)||kind==='group'&&!validId(groupId))throw Error('invalid_incoming_request');
 const rows=await lists(core,kind),matches=[];
 for(const row of rows.slice(0,kind==='friend'?1000:50)){
  if(kind==='friend'?(!friendRow(row)||String(row.reqTime)!==flag):(!groupRow(row,core)||row.seq!==flag||String(row.group.groupCode)!==groupId))continue;
  if(await uin(core,kind==='friend'?row.friendUid:row.user2.uid)===userId)matches.push(row);
 }
 if(matches.length!==1)return {state:matches.length?'ambiguous':'not_observed',row:null};
 const row=matches[0];const state=kind==='friend'?(row.isDecide===false&&row.reqType===1?'pending':row.isDecide===true&&row.reqType===7?'rejected':[2,3].includes(row.reqType)?'accepted_unconfirmed':'unknown'):(row.status===1?'pending':row.status===3?'rejected':row.status===2?'accepted_unconfirmed':'unknown');return {state,row};
}
export async function incomingState(core,input){const value=await resolve(core,input);return {kind:input.kind,flag:input.flag,userId:input.userId,...input.groupId?{groupId:input.groupId}:{},state:value.state};}
export async function decideIncoming(core,input){
 if(typeof input.approve!=='boolean')throw Error('invalid_incoming_decision');
 const current=await resolve(core,input);if(current.state!=='pending')return {submitted:false,apiAccepted:false,status:'source_not_pending',sourceState:current.state};
 const path=input.kind==='friend'?'NodeIKernelBuddyService/approvalFriendRequest':'NodeIKernelGroupService/operateSysNotify',method=core.eventWrapper?.createEventFunction?.(path);
 if(typeof method!=='function')throw Error('incoming_native_unavailable');
 const row=current.row;let timer;
 try{
  const call=input.kind==='friend'?method({friendUid:row.friendUid,reqTime:String(row.reqTime),accept:input.approve}):method(false,{operateType:input.approve?1:2,targetMsg:{seq:row.seq,type:1,groupCode:String(row.group.groupCode),postscript:' '}});
  const result=await Promise.race([Promise.resolve(call),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('incoming_native_timeout_no_retry')),10000);})]);
  const code=result?.result??result?.resultCode??result?.code;
  return {submitted:true,apiAccepted:code!==undefined&&Number(code)===0,status:code!==undefined&&Number(code)!==0?'native_rejected':'submitted_unconfirmed'};
 }finally{clearTimeout(timer);}
}
