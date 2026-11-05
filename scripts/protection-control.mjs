import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {processStamp,recordAlive} from './process-records.mjs';

async function record(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function alive(pid){if(!Number.isInteger(pid)||pid<1)throw new Error('实例锁的进程信息无效');try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
export async function assertNoPendingUndo(root){
  const file=path.join(root,'companion','companion.sqlite');
  if(!await fs.stat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))return;
  const db=new DatabaseSync(file,{readOnly:true,timeout:1000});
  try{if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='protection_undos'").get()&&db.prepare("SELECT 1 FROM protection_undos WHERE status!='completed' LIMIT 1").get())throw new Error('记忆撤销尚未完成。实例保持停止，请用原批次 ID 重试 Undo-Memory.cmd；不要删除检查点或覆盖 runtime。');}finally{db.close();}
}
/** Shares the managed Host's exclusive launch lock, closing the start/undo race. */
export async function acquireOfflineLease(root){
  const lock=path.join(root,'host.lock'),token=crypto.randomUUID();await fs.mkdir(root,{recursive:true});
  const guard=await record(path.join(root,'operations/guard.json'));if(guard&&await recordAlive(guard))throw new Error('运行保护仍在运行，请先运行 Stop-Dev.cmd。');
  const host=await record(path.join(root,'host.json'));if(host&&await recordAlive(host))throw new Error('请先运行 Stop-Dev.cmd，停机后才能检查或撤销记忆。');
  const previous=await record(lock);if(previous){if(await recordAlive(previous))throw new Error('实例或另一个离线维护命令仍在运行，未进行恢复。');await fs.unlink(lock);}
  await fs.writeFile(lock,JSON.stringify({pid:process.pid,...await processStamp(),token,kind:'memory-protection',startedAt:new Date().toISOString()}),{flag:'wx'});
  const assertOffline=async()=>{const current=await record(lock);if(current?.pid!==process.pid||current?.token!==token)throw new Error('离线维护锁已变化，停止恢复');const owner=await record(path.join(root,'host.json'));if(owner&&await recordAlive(owner))throw new Error('检测到 Host 运行，停止恢复');const guard=await record(path.join(root,'operations/guard.json'));if(guard&&await recordAlive(guard))throw new Error('检测到运行保护启动，停止离线维护');};
  const close=async()=>{const current=await record(lock);if(current?.pid===process.pid&&current?.token===token)await fs.unlink(lock);};
  try{await assertOffline();return {assertOffline,close};}catch(error){await close();throw error;}
}
