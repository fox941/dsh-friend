import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { uuid, STORE, aborted } from './validation.js';

export class NativeClient {
  constructor({ memoryDir, policy, timeoutMs = 10000 }) { Object.assign(this, { memoryDir, policy, timeoutMs }); }
  assertStore(store, write = false) {
    const policy = this.policy();
    if (!policy.enabled || (write && !policy.writeEnabled)) throw new Error('当前记忆配置不允许此操作');
    if (!STORE.test(store ?? '') || !policy.spaces.some(space => space.id === store && space.active)) throw new Error('只能操作当前已激活的本地 Native 空间');
    const expected = path.resolve(this.memoryDir, 'data', store);
    const actual = fs.realpathSync(expected);
    if (path.resolve(actual).toLowerCase() !== expected.toLowerCase()) throw new Error('记忆空间目录不能重定向到其他位置');
    if (!fs.existsSync(path.join(actual, 'mnemon.db'))) throw new Error('该空间尚未初始化');
    return policy;
  }
  async run(store, command, args, { signal, write = false } = {}) {
    aborted(signal);
    const policy = this.assertStore(store, write);
    const env = { ...process.env, MNEMON_MAX_INSIGHTS: '0' };
    delete env.DEEPSEEK_API_KEY;
    const childArgs = ['--data-dir', this.memoryDir, '--store', store, command, ...args];
    return new Promise((resolve, reject) => {
      execFile(policy.cliPath, childArgs, { env, windowsHide: true, signal, timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          if (error.name === 'AbortError' || signal?.aborted) { reject(signal?.reason ?? error); return; }
          if (command === 'show' && error.code === 1 && /^Error: sql: no rows in result set\r?\n/.test(stderr)) { resolve(null); return; }
          reject(new Error(`Native ${command} 未完成（${error.killed ? '超时' : error.code ?? '执行失败'}），保留操作状态供重试`)); return;
        }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Native ${command} 返回了无法核验的结果`)); }
      });
    });
  }
  show(store, id, signal) { return this.run(store, 'show', [uuid(id)], { signal }); }
  showReadOnly(store,id,signal){return this.run(store,'show',['--readonly',uuid(id)],{signal});}
  findExact(store,content){
    this.assertStore(store);const db=new DatabaseSync(path.join(this.memoryDir,'data',store,'mnemon.db'),{readOnly:true});
    try{const rows=db.prepare('SELECT id FROM insights WHERE deleted_at IS NULL AND content=? LIMIT 2').all(content);if(rows.length>1)throw new Error('长期条目存在重复身份，需先核对');return rows[0]?.id??null;}finally{db.close();}
  }
  readRevision(store){
    this.assertStore(store);const db=new DatabaseSync(path.join(this.memoryDir,'data',store,'mnemon.db'),{readOnly:true});
    try{return String(db.prepare('SELECT coalesce(max(id),0) AS revision FROM oplog').get().revision);}finally{db.close();}
  }
  presence(store) {
    let db;
    try {
      this.assertStore(store);
      db=new DatabaseSync(path.join(this.memoryDir,'data',store,'mnemon.db'),{readOnly:true,timeout:1000});
      return Boolean(db.prepare('SELECT EXISTS(SELECT 1 FROM insights WHERE deleted_at IS NULL LIMIT 1) AS present').get().present);
    } catch { return null; }
    finally { db?.close(); }
  }
  async remember(store, content, old, operationId, signal, tagPrefix = 'friend-correction') {
    const tags = [...new Set(old.tags ?? [])];
    if (tags.length < 20) tags.push(`${tagPrefix}:${operationId.slice(0,20)}`);
    const entities = old.entities ?? [];
    if ([...tags, ...entities].some(value => typeof value !== 'string' || value.includes(','))) throw new Error('此条目的标签或实体无法通过 Native CLI 无损传递');
    // A direct owner correction is a new user assertion; the prior provenance remains in the journal.
    const args = ['--cat', old.category, '--imp', String(old.importance), '--source', 'user', '--tags', tags.join(',')];
    if (entities.length) args.push('--entities', entities.join(','));
    args.push('--', content);
    const result = await this.run(store, 'remember', args, { signal, write: true });
    // A skipped write has an unused new id; only replaced_id refers to its existing row.
    const id = result.action === 'skipped' ? result.replaced_id : result.action === 'added' ? result.id : undefined;
    return { id: uuid(id), action: result.action };
  }
  async forget(store, id, signal) {
    if (await this.show(store, id, signal) === null) return;
    await this.run(store, 'forget', [uuid(id)], { signal, write: true });
  }
}
