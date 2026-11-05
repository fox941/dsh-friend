import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
/** Fixed localhost status API only. Credentials never leave this function. */
export async function nativeLoginPhase(instance,signal){
 try{
  const file=path.join(instance,'channels/qq/napcat/config/webui.json'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)return 'unavailable';
  const c=JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));if(!Number.isSafeInteger(c.port)||c.port<1024||c.port>65535||typeof c.token!=='string'||c.token.length<16)return 'unavailable';
  const post=async(endpoint,body,authorization)=>{const response=await fetch('http://127.0.0.1:'+c.port+'/api'+endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json',...authorization?{authorization:'Bearer '+authorization}:{}},body:JSON.stringify(body),signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(4000)])});if(!response.ok)throw Error();return response.json();};
  const auth=await post('/auth/login',{hash:crypto.createHash('sha256').update(c.token+'.napcat').digest('hex')});if(auth.data?.require2FA)return 'verification_required';if(typeof auth.data?.Credential!=='string')return 'unavailable';
  const result=await post('/QQLogin/CheckLoginStatus',{},auth.data.Credential),v=result.data;if(v?.isLogin===true)return 'logged_in';if(['waiting_qrcode','qrcode_expired'].includes(v?.loginPhase))return 'scan_required';return 'pending';
 }catch{signal?.throwIfAborted();return 'unavailable';}
}
