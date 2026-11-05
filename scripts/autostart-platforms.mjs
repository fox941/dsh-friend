import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
import {readLocalJson} from './instances.mjs';import {sleep} from './runtime-io.mjs';
export function classifyBiliNav(value,uid){if(value?.code===0&&value.data?.isLogin===true)return String(value.data.mid)===uid?'ready':'wrong_account';if(value?.code===-101||value?.code===0&&value.data?.isLogin===false)return 'login_required';if(value?.code===-412||value?.code===-352)return 'platform_verification';return 'unavailable';}
export function classifyQQPhase(value){if(value?.isLogin===true)return 'logged_in';const phase=value?.loginPhase;if(['waiting_qrcode','qrcode_expired'].includes(phase))return 'scan_required';if(['qrcode_scanned','initializing','reconnecting','connecting'].includes(phase))return 'pending';return 'unavailable';}
async function adapterImports(project){const root=path.join(project,'runtime/dev'),require=createRequire(path.join(root,'dsh-home/profiles/web/package.json')),src=path.dirname(require.resolve('@ai-friend/companion-adapter/qq-offline')),biliSrc=path.dirname(require.resolve('@ai-friend/bilibili-tool/offline'));return {root,src,biliSrc,require:createRequire(await fs.realpath(require.resolve('@ai-friend/companion-adapter/qq-offline')))};}
export async function qqProbe(project){
 const {root,src,require}=await adapterImports(project),{readQQSettings}=await import(pathToFileURL(path.join(src,'qq-config.js'))),config=await readQQSettings(root);if(!config.configured||!config.enabled)return {state:'disabled'};
 const {WebSocket}=require('ws');return new Promise(resolve=>{const ws=new WebSocket(config.url,{headers:{Authorization:'Bearer '+config.accessToken},maxPayload:1048576});let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);ws.terminate();resolve(value);},timer=setTimeout(()=>finish({state:'bridge_unavailable'}),3500);
 ws.on('open',()=>ws.send(JSON.stringify({action:'get_login_info',params:{},echo:'autostart-read-login'})));ws.on('error',()=>finish({state:'bridge_unavailable'}));ws.on('close',()=>finish({state:'bridge_unavailable'}));ws.on('message',bytes=>{try{const v=JSON.parse(bytes);if(v.echo!=='autostart-read-login')return;finish(v.status==='ok'&&v.data?.user_id?{state:String(v.data.user_id)===config.botQQ?'ready':'wrong_account'}:{state:'bridge_unavailable'});}catch{}});
 });
}
export async function napcatStatusReader(project,{request=fetch}={}){
 const file=path.join(project,'runtime/dev/channels/qq/napcat/config/webui.json');let c;try{c=readLocalJson(file);}catch(e){if(e.code==='ENOENT')return async()=>({state:'unavailable'});throw e;}
 if(!Number.isSafeInteger(c.port)||c.port<1024||c.port>65535||typeof c.token!=='string'||c.token.length<16)throw Error('本机QQ管理页配置异常');let credential;
 const post=async(endpoint,payload,authorization)=>{const r=await request('http://127.0.0.1:'+c.port+'/api'+endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json',...(authorization?{authorization:'Bearer '+authorization}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('本机QQ管理页暂不可用');return await r.json();};
 return async()=>{try{if(!credential){const r=await post('/auth/login',{hash:crypto.createHash('sha256').update(c.token+'.napcat').digest('hex')});if(r.data?.require2FA)return {state:'webui_verification'};credential=r.data?.Credential;if(typeof credential!=='string')return {state:'unavailable'};}const r=await post('/QQLogin/CheckLoginStatus',{},credential);return {state:classifyQQPhase(r.data)};}catch{return {state:'unavailable'};}};
}
export async function prepareQQ(project,{probe=()=>qqProbe(project),launch,hasOtherQQ,allowed=()=>true,readWeb,wait=sleep,attempts=12}={}){
 let status=await probe();if(['ready','disabled'].includes(status.state))return status;if(status.state==='wrong_account')return {state:'wrong_account',action:'QQ当前账号不符，请运行Open-QQ-Login.cmd核对AI账号'};
 const web=readWeb??await napcatStatusReader(project);let ui=await web();if(!['logged_in','scan_required','pending','webui_verification'].includes(ui.state)){
  if(await hasOtherQQ())return {state:'existing_qq',action:'其他QQ进程已运行，未接管；请检查AI账号的NapCat'};if(!allowed())return {state:'paused'};try{await launch();}catch{return {state:'launch_failed',action:'QQ桥接未启动，请运行Start-QQ.cmd检查'};}
 }
 for(let n=0;n<attempts;n++){if(!allowed())return {state:'paused'};status=await probe();if(status.state==='ready')return status;if(status.state==='wrong_account')return {state:'wrong_account',action:'QQ账号不符，请运行Open-QQ-Login.cmd核对'};ui=await web();if(ui.state==='scan_required')return {state:'scan_required',action:'QQ需扫码，请运行Open-QQ-Login.cmd'};if(ui.state==='webui_verification')return {state:'webui_verification',action:'QQ管理页需要验证，请运行Open-QQ-Login.cmd'};await wait(2000);}
 return {state:'pending_or_unavailable',action:'QQ暂未连接，请查看QQ-Status；尚未确认登录失效'};
}
export async function checkBilibili(project,{request=fetch,now=Date.now()}={}){
 const {root,biliSrc}=await adapterImports(project),{readBiliCredentials}=await import(pathToFileURL(path.join(biliSrc,'activity-config.js')));let c;
 try{c=await readBiliCredentials(root);}catch(e){return /登录已过期/.test(e.message)?{state:'expired',action:'B站本地凭据到期，请运行Login-Bilibili.cmd'}:{state:'invalid_config',action:'B站配置异常，请查看Bilibili-Status'};}
 if(!c)return {state:'unconfigured'};
 let value;try{const response=await request('https://api.bilibili.com/x/web-interface/nav',{method:'GET',redirect:'error',headers:{'user-agent':'Mozilla/5.0','referer':'https://www.bilibili.com/',cookie:'SESSDATA='+c.sessdata+'; bili_jct='+c.bili_jct+'; DedeUserID='+c.dedeuserid},signal:AbortSignal.timeout(12000)});if(!response.ok)return {state:'unavailable',action:'B站暂不可达，登录状态尚未确认'};value=await response.json();}catch{return {state:'unavailable',action:'B站网络检查未完成，尚未确认登录失效'};}
 const state=classifyBiliNav(value,c.dedeuserid);if(state==='login_required')return {state,action:'B站登录失效，请运行Login-Bilibili.cmd'};if(state==='wrong_account')return {state,action:'B站实际账号与AI配置不符，请核对登录'};if(state==='platform_verification')return {state,action:'B站要求平台验证，请检查AI账号页面'};if(state!=='ready')return {state,action:'B站状态检查未完成，请查看Bilibili-Status'};
 try{const {readWebSession}=await import(pathToFileURL(path.join(biliSrc,'bilibili-web-session.js')));await readWebSession(root,c,now);return {state:'ready',comments:'local_session_ready'};}catch{return {state:'ready',comments:'needs_sync',action:'B站已登录，评论会话需同步：Sync-Bilibili-Web-Session.cmd'};}
}
