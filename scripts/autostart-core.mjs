import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
import {resolveInstance,identityAt,readLocalJson} from './instances.mjs';
import {atomicJson} from './update-lock.mjs';import {assertNoUpdate} from './update-lock.mjs';import {assertNoMigration} from './migration-lock.mjs';import {assertNoPendingUndo} from './protection-control.mjs';
import {currentBootKey,recordAlive,processStamp} from './process-records.mjs';
export const VERSION='1.0.0';
export const files=project=>{const root=resolveInstance(project,'main').root;return {root,config:path.join(root,'operations/autostart.local.json'),status:path.join(root,'operations/autostart-status.json'),lock:path.join(root,'operations/autostart-run.json')};};
const optional=file=>{try{return readLocalJson(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const same=(a,b)=>typeof a==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export const taskName=(project,sid)=>'AiFriend-Main-'+crypto.createHash('sha256').update(path.resolve(project).toLowerCase()+'|'+sid).digest('hex').slice(0,20);
export function validateConfig(project,c){
 if(!c||c.schema!=='ai-friend/autostart/1'||typeof c.enabled!=='boolean'||typeof c.paused!=='boolean'||!Number.isSafeInteger(c.revision)||c.revision<1||!same(c.projectRoot,project)||!same(c.instanceRoot,files(project).root)||!/^S-\d+(?:-\d+)+$/.test(c.ownerSid)||!/^[a-f0-9]{64}$/.test(c.machineKey)||typeof c.identity!=='string'||!c.identity||c.taskName!==taskName(project,c.ownerSid))throw Error('自启配置或归属无效，未启动角色');return c;
}
export function readConfig(project){const c=optional(files(project).config);return c?validateConfig(project,c):null;}
export async function validateRole(project){
 const root=files(project).root,identity=identityAt(root),bootstrap=readLocalJson(path.join(root,'bootstrap.json'));if(!same(bootstrap.configuredRoot,root))throw Error('主角色原路径不符，未创建新身份');const state=optional(path.join(root,'operations/state.json'));if(state?.identity&&state.identity!==identity)throw Error('主角色运行记录与身份不一致');
 for(const file of ['.tools/node-v24.22.1-win-x64/node.exe','node_modules/@deepseek-ai/dsh/lib/bin.js','runtime/dev/dsh-home/profiles/web/package.json','runtime/dev/dsh-home/profiles/web/cordis.patch.yml'])await fs.access(path.join(project,file));return identity;
}
export async function markManualAction(project,action){
 if(!['start','stop','restart','recover'].includes(action))return;const c=readConfig(project);if(!c)return;const paused=action==='stop';await atomicJson(files(project).config,{...c,paused,revision:c.revision+1,lastManualAction:action,updatedAt:new Date().toISOString()});
}
export function assertAutoStartIntent(project,env=process.env){
 const c=readConfig(project);if(!c||!c.enabled||c.paused||String(c.revision)!==env.AI_FRIEND_AUTOSTART_REV||c.machineKey!==env.AI_FRIEND_AUTOSTART_MACHINE||identityAt(files(project).root)!==c.identity)throw Error('自启已停用、暂停或配置变化，本次没有恢复主实例');return c;
}
export async function enableAutostart({project,context,task}){
 await assertNoUpdate(project);await assertNoMigration(project);const identity=await validateRole(project);await assertNoPendingUndo(files(project).root);const prior=readConfig(project);
 const c={schema:'ai-friend/autostart/1',version:VERSION,enabled:true,paused:false,revision:(prior?.revision??0)+1,projectRoot:path.resolve(project),instanceRoot:files(project).root,identity,ownerSid:context.ownerSid,machineKey:context.machineKey,taskName:taskName(project,context.ownerSid),updatedAt:new Date().toISOString()};validateConfig(project,c);
 await task('enable',c);await atomicJson(files(project).config,c);return {enabled:true,paused:false,taskName:c.taskName,startsNow:false,scope:'仅当前电脑、当前Windows用户登录后的Main'};
}
export async function disableAutostart({project,context,task}){
 const c=readConfig(project);if(!c){await task('disable',{projectRoot:path.resolve(project),...context,taskName:taskName(project,context.ownerSid)});return {enabled:false,mainStopped:false};}const local={...c,ownerSid:context.ownerSid,machineKey:context.machineKey,taskName:taskName(project,context.ownerSid),enabled:false,paused:true,revision:c.revision+1,updatedAt:new Date().toISOString()};
 await atomicJson(files(project).config,local);await task('disable',local);return {enabled:false,mainStopped:false,taskName:local.taskName};
}
async function acquire(project,bootKey){
 const file=files(project).lock,old=optional(file);if(old){if(!Number.isSafeInteger(old.pid)||old.pid<1)throw Error('自启执行锁无效');if(await recordAlive(old))return null;await fs.unlink(file);}
 const token=crypto.randomUUID();try{await fs.writeFile(file,JSON.stringify({pid:process.pid,...await processStamp(),token,bootKey}),{flag:'wx',mode:0o600});}catch(e){if(e.code==='EEXIST')return null;throw e;}return {close:async()=>{const now=optional(file);if(now?.token===token&&now.pid===process.pid)await fs.unlink(file);}};
}
const ready=h=>h?.state==='running'&&h.health?.available&&h.health.memory?.activeSpaces>0&&!h.health.memory.stores?.some(s=>!s.readable);
export async function runAutostart({project,context,hooks}){
 const c=readConfig(project);if(!c||!c.enabled||c.paused){const result={outcome:c?.enabled&&c.paused?'paused':'disabled',started:false};if(c){try{if(identityAt(files(project).root)===c.identity)await atomicJson(files(project).status,{schema:'ai-friend/autostart-status/1',phase:'finished',...result,finishedAt:new Date().toISOString()});}catch{}}return result;}
 const identity=await validateRole(project);if(identity!==c.identity)throw Error('主角色身份与自启登记不同，未重建角色');if(c.machineKey!==context.machineKey||c.ownerSid!==context.ownerSid)return {outcome:'different_machine_or_user',started:false};const lock=await acquire(project,context.bootKey??await currentBootKey());if(!lock)return {outcome:'already_running',started:false};
 let state={schema:'ai-friend/autostart-status/1',startedAt:new Date().toISOString(),phase:'checking',identity,started:false};
 const save=async()=>atomicJson(files(project).status,state);const allowed=()=>{const now=readConfig(project);return now?.enabled&&!now.paused&&now.revision===c.revision;};
 try{
  await save();await assertNoUpdate(project);await assertNoMigration(project);await assertNoPendingUndo(files(project).root);if(!allowed())return {outcome:'paused_or_changed',started:false};
  let host=await hooks.mainStatus();if(['owner_conflict','host_unresponsive'].includes(host.state)||host.state==='running'&&host.health?.available&&host.health.identity!==identity)throw Error('原主实例归属、控制通道或身份异常，保留现场');
  if(!ready(host)||!host.guardRunning){state.phase='starting_main';await save();await hooks.startMain(c);state.started=true;host=await hooks.waitMain();}
  if(!ready(host)||host.health.identity!==identity)throw Error('主实例未通过身份与记忆健康检查');
  if(!allowed()){const now=readConfig(project);if(now?.enabled&&now.paused&&state.started)await hooks.stopMain();return {outcome:'paused_or_changed',started:state.started};}
  state.phase='checking_platforms';await save();try{state.qq=await hooks.qq(()=>allowed());}catch{state.qq={state:'unavailable',action:'QQ状态检查未完成，请查看QQ-Status'};}if(!allowed())return {outcome:'paused_or_changed',started:state.started};try{state.bilibili=await hooks.bilibili();}catch{state.bilibili={state:'unavailable',action:'B站状态检查未完成，请查看Bilibili-Status'};}
  const notices=[];if(state.qq.action)notices.push(state.qq.action);if(state.bilibili.action)notices.push(state.bilibili.action);
  state={...state,phase:'finished',outcome:notices.length?'needs_attention':'ready',finishedAt:new Date().toISOString()};await save();if(notices.length)await hooks.notify(notices.join('；'));return state;
 }catch(e){state={...state,phase:'finished',outcome:'blocked',reason:'自启未完成，请查看Autostart-Status与主实例状态；未强杀进程或重建角色',finishedAt:new Date().toISOString()};await save();await hooks.notify(state.reason);throw e;}
 finally{if(state.phase!=='finished')await atomicJson(files(project).status,{...state,phase:'finished',outcome:'paused_or_changed',finishedAt:new Date().toISOString()});await lock.close();}
}
