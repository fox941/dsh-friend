import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {aborted} from './validation.js';
const quoted=name=>'"'+name.replaceAll('"','""')+'"';
const json=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?{$integer:String(item)}:item instanceof Uint8Array?{$blob:Buffer.from(item).toString('base64')}:item);
export async function fileHash(file){const hash=crypto.createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
export async function writableFile(file){if(path.resolve(await fs.realpath(path.dirname(file))).toLowerCase()!==path.resolve(path.dirname(file)).toLowerCase())throw new Error('保护文件目录不允许重定向');const stat=await fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(stat&&(stat.isSymbolicLink()||!stat.isFile()))throw new Error('保护文件不允许重定向');}
export function integrity(db){if(Object.values(db.prepare('PRAGMA quick_check').get())[0]!=='ok')throw new Error('快照 SQLite 完整性检查失败');}
export async function databaseHash(file,signal){
  const db=new DatabaseSync(file,{readOnly:true,timeout:1000}),hash=crypto.createHash('sha256');
  try{
    db.exec('BEGIN');
    hash.update(json(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()));
    const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all();
    for(const table of tables){
      aborted(signal);hash.update(json(table));
      const order=/WITHOUT\s+ROWID/i.test(table.sql??'')?db.prepare(`PRAGMA table_info(${quoted(table.name)})`).all().filter(row=>row.pk).sort((a,b)=>a.pk-b.pk).map(row=>quoted(row.name)).join(','):'rowid';
      const statement=db.prepare(`SELECT * FROM ${quoted(table.name)} ORDER BY ${order}`);statement.setReadBigInts(true);let count=0;
      for(const row of statement.iterate()){hash.update(json(row));hash.update('\n');if(++count%512===0){await new Promise(resolve=>setImmediate(resolve));aborted(signal);}}
    }
    db.exec('COMMIT');return hash.digest('hex');
  }finally{db.close();}
}
export async function copyDatabase(source,destination,{signal,maxBytes=536870912,timeoutMs=30000}={}){
  await writableFile(destination);
  const own=typeof source==='string',db=own?new DatabaseSync(source,{readOnly:true,timeout:1000}):source,deadline=Date.now()+timeoutMs;
  try{
    const pageSize=db.prepare('PRAGMA page_size').get().page_size;
    if(db.prepare('PRAGMA page_count').get().page_count*pageSize>maxBytes)throw new Error('单份快照超过空间上限');aborted(signal);
    await backup(db,destination,{rate:128,progress:({totalPages})=>{aborted(signal);if(Date.now()>deadline)throw new Error('一致性快照超过时间预算');if(totalPages*pageSize>maxBytes)throw new Error('单份快照超过空间上限');}});
    aborted(signal);if(Date.now()>deadline)throw new Error('一致性快照超过时间预算');if((await fs.stat(destination)).size>maxBytes)throw new Error('单份快照超过空间上限');const check=new DatabaseSync(destination,{readOnly:true});try{integrity(check);}finally{check.close();}
    return {bytes:(await fs.stat(destination)).size,sha256:await fileHash(destination)};
  }finally{if(own)db.close();}
}
export function nativeFootprint(file,excluded=[]){
  const db=new DatabaseSync(file,{readOnly:true}),digest=crypto.createHash('sha256'),ids=[...new Set(excluded)],slots=ids.map(()=>'?').join(',');
  try{
    const statement=db.prepare(`SELECT * FROM insights ${ids.length?`WHERE id NOT IN (${slots})`:''} ORDER BY id`);statement.setReadBigInts(true);for(const row of statement.iterate(...ids))digest.update(json(row));
    const edges=db.prepare(`SELECT * FROM edges ${ids.length?`WHERE source_id NOT IN (${slots}) AND target_id NOT IN (${slots})`:''} ORDER BY rowid`);edges.setReadBigInts(true);for(const row of edges.iterate(...ids,...ids))digest.update(json(row));
    return {outside:digest.digest('hex'),lastOp:db.prepare('SELECT coalesce(max(id),0) AS n FROM oplog').get().n};
  }finally{db.close();}
}
export function unexplainedNativeWrites(file,afterId,allowed){const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT operation,insight_id FROM oplog WHERE id>? ORDER BY id').all(afterId).some(row=>!['remember','forget','show'].includes(row.operation)||!allowed.includes(row.insight_id));}finally{db.close();}}
