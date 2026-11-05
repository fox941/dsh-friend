import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {noLinks,readJson,json} from './migration-files.mjs';
const optional=async file=>{await noLinks(file);try{const s=await fs.stat(file);if(!s.isFile()||s.size>131072)throw Error('升级控制文件无效');return await readJson(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export const updatePending=project=>path.join(project,'.update-pending.json');
export async function assertNoUpdate(project){
  const pending=await optional(updatePending(project));if(!pending)return;
  const owner=await optional(path.join(project,'.work/update-operation.json'));
  if(pending.schema==='ai-friend/update-pending/1'&&owner&&typeof pending.launchToken==='string'&&pending.launchToken.length>0&&typeof pending.ownerToken==='string'&&owner.token===pending.ownerToken&&process.env.AI_FRIEND_UPDATE_TOKEN===pending.launchToken&&Number.isSafeInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);return;}catch{}}
  throw Error('代码升级尚未完成；请用原更新包继续 Apply-Update 或检查 Rollback-Update，未启动角色');
}
export async function updateOperation(project,purpose){
  const file=path.join(project,'.work/update-operation.json');await noLinks(file);await fs.mkdir(path.dirname(file),{recursive:true});const old=await optional(file);
  if(old){if(!Number.isSafeInteger(old.pid)||old.pid<1)throw Error('升级操作锁无效');try{process.kill(old.pid,0);throw Error('另一个升级操作仍在运行');}catch(e){if(e.code!=='ESRCH')throw e;}await fs.unlink(file);}
  const token=crypto.randomUUID();await fs.writeFile(file,json({schema:'ai-friend/update-operation/1',pid:process.pid,token,purpose}),{flag:'wx',mode:0o600});
  const check=async()=>{const r=await optional(file);if(r?.token!==token||r.pid!==process.pid)throw Error('升级操作锁变化');};
  return {token,check,close:async()=>{await check();await fs.unlink(file);}};
}
export async function atomicJson(file,value){await noLinks(file);await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,json(value),{mode:0o600,flag:'wx'});await fs.rename(temp,file);}
