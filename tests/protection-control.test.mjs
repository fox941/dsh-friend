import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const project=process.env.AI_FRIEND_PROJECT_ROOT??fileURLToPath(new URL('../',import.meta.url)),scripts=process.env.FRIEND_PROTECTION_SCRIPTS??path.join(project,'scripts');
const {acquireOfflineLease,assertNoPendingUndo}=await import(pathToFileURL(path.join(scripts,'protection-control.mjs')));
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'friend-control-test-'));t.after(()=>fs.rm(dir,{recursive:true}));return dir;}
test('offline maintenance and managed Host share one exclusive lock',async t=>{const root=await temp(t),lease=await acquireOfflineLease(root);try{await lease.assertOffline();await assert.rejects(acquireOfflineLease(root),/仍在运行/);assert.equal(JSON.parse(await fs.readFile(path.join(root,'host.lock'))).pid,process.pid);}finally{await lease.close();}await assert.rejects(fs.stat(path.join(root,'host.lock')),/ENOENT/);});
test('offline CLI refuses a running Host before opening the memory journal',async t=>{const root=await temp(t);await fs.writeFile(path.join(root,'host.json'),JSON.stringify({pid:process.pid}));await assert.rejects(acquireOfflineLease(root),/先运行 Stop-Dev/);await assert.rejects(fs.stat(path.join(root,'companion')),/ENOENT/);});
test('an interrupted undo blocks Host startup until the durable receipt is completed',async t=>{const root=await temp(t);await fs.mkdir(path.join(root,'companion'));const db=new DatabaseSync(path.join(root,'companion/companion.sqlite'));try{db.exec("CREATE TABLE protection_undos(status TEXT);INSERT INTO protection_undos VALUES('partial')");await assert.rejects(assertNoPendingUndo(root),/撤销尚未完成/);db.exec("UPDATE protection_undos SET status='completed'");await assertNoPendingUndo(root);}finally{db.close();}});
