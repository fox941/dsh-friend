import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const companion=process.env.FRIEND_ADAPTER_SOURCE??path.resolve(import.meta.dirname,'../plugins/companion-adapter/src'),scheduler=process.env.FRIEND_SCHEDULER_SOURCE??path.resolve(companion,'../../attention-scheduler/src'),load=(root,file)=>import(pathToFileURL(path.join(root,file)));
const {SerialExecutor,DecisionRunner}=await load(scheduler,'runtime.js'),{AttentionStore}=await load(scheduler,'store.js'),{Journal}=await load(companion,'journal.js'),plugin=await load(scheduler,'index.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise(r=>setTimeout(r,1));
async function journal(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'friend-scheduler-')),j=new Journal(dir);t.after(()=>{j.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('friend-scheduler-'));return fs.rm(dir,{recursive:true});});return j;}

test('XState admission mailbox serializes independent callers and continues after a failed admission',async()=>{
 const queue=new SerialExecutor(),gate=deferred(),order=[];let concurrent=0,maximum=0;
 const tasks=Array.from({length:20},(_,i)=>queue.run(async()=>{concurrent++;maximum=Math.max(maximum,concurrent);order.push(i);try{if(i===0)await gate.promise;if(i===5)throw Error('fixture');return i;}finally{concurrent--;}}));
 const results=Promise.allSettled(tasks);await settle();assert.deepEqual(order,[0]);gate.resolve();const settled=await results;assert.equal(maximum,1);assert.deepEqual(order,Array.from({length:20},(_,i)=>i));assert.equal(settled[5].status,'rejected');assert.equal(settled[19].value,19);await queue.idle();assert.deepEqual(queue.status(),{phase:'idle',queued:0});queue.close();
});
test('XState shutdown aborts the active admission and rejects queued work without starting it',async()=>{
 const queue=new SerialExecutor(),entered=deferred();let next=0,aborted=false;
 const active=queue.run(signal=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});entered.resolve();})),queued=queue.run(()=>next++),results=Promise.allSettled([active,queued]);await entered.promise;queue.close();assert.ok((await results).every(r=>r.status==='rejected'));assert.equal(next,0);assert.equal(aborted,true);await assert.rejects(queue.run(()=>{}),/关闭/);
});
test('XState decision actor coalesces callers, forwards errors and allows the next decision',async()=>{
 const runner=new DecisionRunner(),gate=deferred();let calls=0;
 const promises=Array.from({length:10},()=>runner.run(async()=>{calls++;return gate.promise;}));assert.ok(promises.every(p=>p===promises[0]));await settle();assert.equal(runner.status(),'working');gate.resolve('rest');assert.deepEqual(await Promise.all(promises),Array(10).fill('rest'));assert.equal(calls,1);await assert.rejects(runner.run(()=>{throw Error('model failed');}),/model failed/);assert.equal(await runner.run(()=>42),42);assert.equal(runner.status(),'idle');runner.close();
});
test('closing an uncooperative decision cannot leave a ghost planning actor or restart the model',async()=>{
 const runner=new DecisionRunner(),entered=deferred();let aborted=false,calls=0;
 const promise=runner.run(signal=>{calls++;signal.addEventListener('abort',()=>aborted=true,{once:true});entered.resolve();return new Promise(()=>{});});const failed=assert.rejects(promise,/关闭/);await entered.promise;runner.close();await failed;assert.equal(aborted,true);assert.equal(calls,1);assert.equal(runner.status(),'closed');
});
test('terminal intents cannot be resurrected by a late callback; explicit reconciliation preserves the original ID',async t=>{
 const j=await journal(t),store=new AttentionStore(j),row=store.offer({key:'receipt',kind:'browse',summary:'真实原任务'});store.patch(row.id,'completed',{result:{status:'sent',messageId:'original'}});assert.throws(()=>store.patch(row.id,'running'),/状态转换/);assert.throws(()=>store.patch(row.id,'pending'),/状态转换/);assert.equal(store.get(row.id).result.messageId,'original');store.patch(row.id,'pending',{reconcile:true});assert.equal(store.get(row.id).id,row.id);assert.equal(store.get(row.id).status,'pending');store.patch(row.id,'cancelled');assert.throws(()=>store.patch(row.id,'pending',{reconcile:true}),/状态转换/);
});
test('a rolled-back state transition leaves no actor snapshot able to overwrite the committed row',async t=>{
 const j=await journal(t),store=new AttentionStore(j),row=store.offer({key:'rollback',kind:'message',summary:'原输入'});assert.throws(()=>j.transaction(()=>{store.patch(row.id,'completed');throw Error('rollback');}),/rollback/);assert.equal(store.get(row.id).status,'pending');store.patch(row.id,'selected');store.patch(row.id,'admitting');assert.equal(store.get(row.id).status,'admitting');
});
test('restoring the existing tables recovers task identity and checkpoints without invoking any tool',async t=>{
 const j=await journal(t),store=new AttentionStore(j),row=store.offer({key:'resume',kind:'browse',summary:'未完观察'});store.patch(row.id,'running');store.checkpoint('activity:old',{observationId:'old-evidence',nativeId:'old-receipt'});const before=j.db.prepare('SELECT count(*) n FROM attention_intents').get().n,reopened=new AttentionStore(j);assert.equal(reopened.get(row.id).status,'pending');assert.deepEqual(reopened.readCheckpoint('activity:old'),{observationId:'old-evidence',nativeId:'old-receipt'});assert.equal(reopened.byKey('resume').id,row.id);assert.equal(j.db.prepare('SELECT count(*) n FROM attention_intents').get().n,before);
});
test('DSH plugin exposes a separate service and disposes its controllers without owning the journal',async t=>{
 const j=await journal(t),effects=[];let service;const ctx={provide(name,value){assert.equal(name,'friendScheduler');service=value;},effect(fn){effects.push(fn());}};plugin.apply(ctx);assert.deepEqual(plugin.provide,['friendScheduler']);const controller=service.create({journal:j,validateDecision:()=>{throw Error('no model');}});assert.equal(service.status().controllers.length,1);assert.equal(controller.status().engine.library,'xstate');await effects[0]();assert.equal(service.status().controllers.length,0);assert.equal(j.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
});

test('a late freshness callback after scheduler disposal cannot commit or touch the closed journal',async t=>{
 const j=await journal(t),{SchedulerController}=await load(scheduler,'controller.js'),gate=deferred(),entered=deferred();
 const controller=new SchedulerController({journal:j,validateDecision:v=>({...v,updates:[],suggestions:[]})});controller.offer({key:'old',kind:'message',summary:'关闭前的原消息'});controller.bind({snapshot:async()=>({}),review:async()=>({decision:{action:'rest',targetId:null,reason:'休息'}}),fresh:async()=>{entered.resolve();return gate.promise;}});
 const choosing=controller.choose(),result=Promise.allSettled([choosing]);await entered.promise;await controller.close();await result;assert.equal(j.db.prepare('SELECT status FROM attention_decisions ORDER BY rowid DESC LIMIT 1').get().status,'interrupted');let late=0;for(const name of ['finish','meta','get'])controller.store[name]=()=>{late++;throw Error('late DB access');};gate.resolve(true);await settle();await settle();assert.equal(late,0);
});
