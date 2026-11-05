import fs from 'node:fs/promises';import path from 'node:path';
import {copyDatabase} from './protection-sql.js';
// Reuses the verified SQLite online-backup implementation. Native is not mutated
// by these batches: rollback changes the canonical ledger, not an entire index.
export function createSocialSnapshot(adapter){
 return async(id,signal)=>{
  const directory=path.join(adapter.journal.directory,'protection/qq-social');
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid social snapshot ID');
  for(let cursor=directory;;){const actual=await fs.realpath(cursor).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(actual&&path.resolve(actual).toLowerCase()!==path.resolve(cursor).toLowerCase())throw Error('Social snapshot directory redirected');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
  await fs.mkdir(directory,{recursive:true});if(path.resolve(await fs.realpath(directory)).toLowerCase()!==path.resolve(directory).toLowerCase())throw Error('Social snapshot directory redirected');
  const file=path.join(directory,id+'.sqlite'),partial=file+'.partial';let result;try{result=await copyDatabase(adapter.journal.db,partial,{signal,maxBytes:536870912,timeoutMs:30000});}catch(e){await fs.unlink(partial).catch(()=>{});throw e;}
  await fs.rename(partial,file);
  // Keep at most 16 verified snapshots / 512 MiB. Receipts and versions remain.
  const files=[];for(const name of await fs.readdir(directory)){if(!/^[a-f0-9-]{36}\.sqlite$/.test(name))continue;const candidate=path.join(directory,name),stat=await fs.lstat(candidate);if(stat.isSymbolicLink()||!stat.isFile())throw Error('Snapshot path redirected');files.push({file:candidate,size:stat.size,time:stat.mtimeMs});}
  files.sort((a,b)=>b.time-a.time);let bytes=0;for(let i=0;i<files.length;i++){const f=files[i];bytes+=f.size;if(f.file!==file&&(i>=16||bytes>536870912))await fs.unlink(f.file);}
  return {file,sha256:result.sha256,bytes:result.bytes,scope:'companion.sqlite consistent snapshot; Native indexes unchanged'};
 };
}
