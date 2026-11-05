import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const read=async file=>{try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>65536)throw Error('迁移控制文件无效');return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export async function assertNoMigration(project){
  const fresh=await read(path.join(project,'.fresh-install.json'));
  if(fresh&&fresh.phase!=='ready')throw Error('空白部署尚未完成，请用同一空白包继续 Install-Fresh；未启动或重建角色');
  if(await read(path.join(project,'.migration.lock')))throw Error('迁移或恢复正在进行或上次未正常完成；请重试原迁移命令，不要启动实例');
  const state=await read(path.join(project,'.migration-restore.json'));
  if(state&&state.phase!=='ready')throw Error('迁移恢复尚未完成，请用原迁移包重新运行恢复入口；未创建新角色');
}
export async function acquireMigrationLock(project,purpose){
  const file=path.join(project,'.migration.lock'),token=crypto.randomUUID(),old=await read(file);
  if(old){if(!Number.isSafeInteger(old.pid)||old.pid<1)throw Error('迁移锁无效，未接管');try{process.kill(old.pid,0);throw Error('另一个迁移命令仍在运行');}catch(e){if(e.code!=='ESRCH')throw e;}await fs.unlink(file);}
  await fs.writeFile(file,JSON.stringify({schema:'ai-friend/migration-lock/1',pid:process.pid,token,purpose}),{flag:'wx',mode:0o600});
  const check=async()=>{const r=await read(file);if(r?.pid!==process.pid||r.token!==token)throw Error('迁移锁已变化，停止操作');};
  return {check,close:async()=>{await check();await fs.unlink(file);}};
}
