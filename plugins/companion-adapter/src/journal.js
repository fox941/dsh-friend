import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { aborted } from './validation.js';

export class Journal {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'companion.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS adapter_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO adapter_schema VALUES (1,1);`);
    if (this.db.prepare('SELECT version FROM adapter_schema WHERE id=1').get().version !== 1) throw new Error('不支持的适配插件数据版本');
    this.db.exec(`CREATE TABLE IF NOT EXISTS adapter_corrections (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL, fact_key TEXT NOT NULL,
      old_id TEXT NOT NULL, old_content TEXT NOT NULL, old_snapshot TEXT NOT NULL,
      new_content TEXT NOT NULL, new_id TEXT, evidence TEXT NOT NULL, reason TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('prepared','written','committed')),
      paused INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adapter_correction_history ON adapter_corrections(store_id,fact_key,created_at);
      CREATE TABLE IF NOT EXISTS adapter_heads (store_id TEXT NOT NULL, fact_key TEXT NOT NULL, current_id TEXT NOT NULL, PRIMARY KEY(store_id,fact_key));
      CREATE TABLE IF NOT EXISTS adapter_actions (call_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL, succeeded INTEGER NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS adapter_actions_session ON adapter_actions(session_id,at);`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  get(id) { return this.db.prepare('SELECT * FROM adapter_corrections WHERE id=?').get(id); }
  head(store,key) { return this.db.prepare('SELECT current_id FROM adapter_heads WHERE store_id=? AND fact_key=?').get(store,key)?.current_id; }
  keyForRecord(store,id) {
    const keys=this.db.prepare('SELECT DISTINCT fact_key FROM adapter_corrections WHERE store_id=? AND (old_id=? OR new_id=?) LIMIT 2').all(store,id,id);
    if(keys.length>1)throw new Error('此记录对应多个事实键，请明确指定');
    return keys[0]?.fact_key;
  }
  prepare(row) {
    return this.transaction(() => {
      if (this.get(row.id)) return this.get(row.id);
      const pending = this.db.prepare("SELECT id FROM adapter_corrections WHERE store_id=? AND fact_key=? AND stage!='committed'").get(row.storeId,row.factKey);
      if (pending) throw new Error('同一事实有未完成的更正，请先重试原更正');
      const head = this.db.prepare('SELECT current_id FROM adapter_heads WHERE store_id=? AND fact_key=?').get(row.storeId,row.factKey);
      if (head && head.current_id !== row.oldId) throw new Error('旧版本已变化，请重新召回当前事实再更正');
      this.db.prepare('INSERT OR IGNORE INTO adapter_heads VALUES (?,?,?)').run(row.storeId,row.factKey,row.oldId);
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO adapter_corrections (id,store_id,fact_key,old_id,old_content,old_snapshot,new_content,evidence,reason,stage,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(row.id,row.storeId,row.factKey,row.oldId,row.oldContent,JSON.stringify(row.oldSnapshot),row.newContent,JSON.stringify(row.evidence),row.reason,now,now);
      return this.get(row.id);
    });
  }
  update(id, stage, newId) { this.db.prepare('UPDATE adapter_corrections SET stage=?,new_id=COALESCE(?,new_id),paused=0,last_error=NULL,updated_at=? WHERE id=?').run(stage,newId??null,new Date().toISOString(),id); }
  failure(id,error,paused) { this.db.prepare('UPDATE adapter_corrections SET last_error=?,paused=?,updated_at=? WHERE id=?').run(String(error.message??error).slice(0,1000),paused?1:0,new Date().toISOString(),id); }
  commit(id) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!row?.new_id) throw new Error('更正缺少已验证的新记录');
      const head = this.db.prepare('SELECT current_id FROM adapter_heads WHERE store_id=? AND fact_key=?').get(row.store_id,row.fact_key);
      if (head?.current_id !== row.old_id && head?.current_id !== row.new_id) throw new Error('更正版本发生并发冲突');
      this.db.prepare('UPDATE adapter_heads SET current_id=? WHERE store_id=? AND fact_key=?').run(row.new_id,row.store_id,row.fact_key);
      this.update(id,'committed',row.new_id);
      return this.get(id);
    });
  }
  pending() { return this.db.prepare("SELECT * FROM adapter_corrections WHERE stage!='committed' ORDER BY created_at,rowid").all(); }
  history(store,key,limit=5) { return key===undefined?this.db.prepare('SELECT * FROM adapter_corrections WHERE store_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(store,limit):this.db.prepare('SELECT * FROM adapter_corrections WHERE store_id=? AND fact_key=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(store,key,limit); }
  action(callId,sessionId,tool,succeeded) { this.db.prepare('INSERT OR IGNORE INTO adapter_actions VALUES (?,?,?,?,?)').run(callId,sessionId,tool,succeeded?1:0,new Date().toISOString()); }
  actions(sessionId) { return this.db.prepare('SELECT tool,succeeded,at FROM adapter_actions WHERE session_id=? ORDER BY at DESC,rowid DESC LIMIT 8').all(sessionId); }
  async locked(fn,signal) {
    aborted(signal);
    const file = path.join(this.directory,'correction.lock');
    const token = crypto.randomUUID();
    let owned = false;
    for (let attempt=0;attempt<80;attempt++) {
      aborted(signal);
      try { fs.writeFileSync(file,JSON.stringify({pid:process.pid,token}),{flag:'wx'}); owned=true; break; }
      catch(error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous=JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw new Error('纠错锁状态无法验证，请先排查'); }
        try { process.kill(previous.pid,0); }
        catch(ownerError) { if(ownerError.code==='ESRCH'){ fs.unlinkSync(file); continue; } throw ownerError; }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
    if(!owned)throw new Error('另一个纠错操作正在运行，请稍后重试');
    try { return await fn(); }
    finally { try { if(JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.unlinkSync(file); } catch(error){if(error.code!=='ENOENT')throw error;} }
  }
  close() { this.db.close(); }
}
