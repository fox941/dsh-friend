const validId=v=>typeof v==='string'&&/^[1-9]\d{4,11}$/.test(v);
export function nativeFriendMethod(core){return core.eventWrapper?.createEventFunction?.('NodeIKernelBuddyService/reqToAddFriends')??null;}
export function nativeFriendDiagnostics(core){const method=nativeFriendMethod(core),raw=core.eventWrapper?.WrapperSession?.getBuddyService?.()?.reqToAddFriends,fn=typeof raw==='function'?raw:method;return {callable:typeof method==='function',invocation:'bound-original-no-service-proxy',arity:typeof fn==='function'?fn.length:null,source:typeof fn==='function'?Function.prototype.toString.call(fn).slice(0,800):null};}
export function friendFailure(error){const message=String(error?.message??'');return {name:['TypeError','RangeError','Error'].includes(error?.name)?error.name:'Error',category:/not (?:implemented|supported|found)|unsupported|undefined.*function|not a function/i.test(message)?'native_method_unavailable':/argument|parameter|expected|invalid|type/i.test(message)?'native_argument_validation':/timeout/i.test(message)?'native_timeout':'native_call_failed',typeHints:['number','string','object','array','boolean'].filter(word=>new RegExp('\\b'+word+'\\b','i').test(message))};}
export async function friendRequestState(core,userId,{since=0}={}){
 if(!validId(userId)||!Number.isSafeInteger(since)||since<0)throw Error('invalid_friend_lookup');
 const uid=await core.apis.UserApi.getUidByUinV2(userId);
 if(typeof uid!=='string'||!uid||uid.includes('*'))throw Error('friend_identity_unavailable');
 const data=await core.apis.FriendApi.getBuddyReq();
 if(!Array.isArray(data?.buddyReqs))throw Error('friend_requests_unavailable');
 const matches=data.buddyReqs.slice(0,1000).filter(r=>r.friendUid===uid&&r.isInitiator===true&&/^\d{10}$/.test(String(r.reqTime))&&Number(r.reqTime)>=since&&Number(r.reqTime)<=Math.floor(Date.now()/1000)+30).sort((a,b)=>Number(b.reqTime)-Number(a.reqTime));
 const request=matches[0];
 return {userId,status:!request?'not_observed':request.reqType===6?'rejected':request.reqType===13&&!request.isDecide?'pending_approval':[4,5].includes(request.reqType)?'peer_agreed_not_membership_confirmed':'unknown',requestTime:request?Number(request.reqTime):null,limited:data.buddyReqs.length>=1000};
}
export async function submitFriendRequest(core,userId,message){
 if(!validId(userId)||userId===String(core.selfInfo?.uin)||typeof message!=='string'||!message.trim()||message.length>300)throw Error('invalid_friend_request');
 const method=nativeFriendMethod(core);
 if(typeof method!=='function')throw Object.assign(Error('native_friend_add_unavailable'),{unsupported:true});
 // Pinned NapCat v4.18.41 declares exactly (number, string). Never try
 // alternative write signatures when the response is missing or ambiguous.
 let timer;
 try{
  const value=await Promise.race([Promise.resolve(method(Number(userId),message)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('native_friend_timeout_no_retry')),10000);})]);
  const code=value?.result??value?.resultCode??value?.code;
  if(code!==undefined&&(!Number.isInteger(Number(code))||Number(code)!==0))return {submitted:true,apiAccepted:false,status:'native_rejected',code:Number.isInteger(Number(code))?Number(code):null};
  return {submitted:true,apiAccepted:code!==undefined&&Number(code)===0,status:'submitted_unconfirmed',userId};
 }finally{clearTimeout(timer);}
}
