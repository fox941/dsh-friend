import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const source=process.env.FRIEND_ADAPTER_SOURCE??fileURLToPath(new URL('../plugins/companion-adapter/src/',import.meta.url));
const {CorrectionController}=await import(pathToFileURL(path.join(source,'controller.js')));
const {NativeClient}=await import(pathToFileURL(path.join(source,'native-client.js')));
const {userEvidence,ownerMessage}=await import(pathToFileURL(path.join(source,'evidence.js')));
const {apply:applyAgent}=await import(pathToFileURL(path.join(source,'agent.js')));
const oldText='纸船计划周六15点集合，暗号松塔246810。';
const revised='纸船计划周日16点集合，暗号松塔246810。';
const evidence={owner:true,sessionId:'session-test',messageId:'message-test',quote:'更正：改为周日下午四点，其他不变。'};
class Backend {
  constructor(){this.rows=new Map();this.oldId=crypto.randomUUID();this.rows.set(this.oldId,{id:this.oldId,content:oldText,category:'fact',importance:3,tags:[],entities:[],source:'user'});}
  assertStore(store){if(store!=='default')throw new Error('scope rejected');}
  async show(_store,id,signal){signal?.throwIfAborted();const row=this.rows.get(id);return row&&!row.deleted?structuredClone(row):null;}
  async remember(_store,content,_old,_operationId,signal){signal?.throwIfAborted();if(this.rememberFault)throw new Error('write failed');for(const row of this.rows.values())if(!row.deleted&&row.content===content)return{id:row.id,action:'skipped'};const id=crypto.randomUUID();this.rows.set(id,{id,content});this.afterRemember?.();return{id,action:'added'};}
  async forget(_store,id,signal){signal?.throwIfAborted();this.rows.get(id).deleted=true;if(this.loseAck){this.loseAck=false;throw new Error('ack lost after commit');}}
}
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-adapter-test-'));
  const backend=new Backend();const state={enabled:true,writeEnabled:true,spaces:[{id:'default',active:true}]};
  let controller=new CorrectionController({directory,client:backend,policy:()=>state,memoryDir:directory});
  const fixture={backend,state,directory,get controller(){return controller;},args:{oldId:backend.oldId,factKey:'paperboat',expectedOldContent:oldText,newContent:revised},async reopen(){await controller.close();controller=new CorrectionController({directory,client:backend,policy:()=>state,memoryDir:directory});}};
  t.after(async()=>{await controller.close();const actual=await fs.realpath(directory);const parent=await fs.realpath(os.tmpdir());assert.ok(actual.startsWith(parent+path.sep)&&path.basename(actual).startsWith('friend-adapter-test-'));await fs.rm(actual,{recursive:true});});
  return fixture;
}
test('corrects, preserves history/unchanged information, and replays without duplicate writes',async t=>{
  const f=await fixture(t);const first=await f.controller.correct(f.args,evidence);const repeated=await f.controller.correct(f.args,evidence);
  assert.equal(first.status,'committed');assert.equal(repeated.replayed,true);assert.equal(f.backend.rows.size,2);assert.equal(await f.backend.show('default',f.backend.oldId),null);assert.ok(first.currentContent.includes('松塔246810'));
  const history=f.controller.history('default','paperboat');assert.equal(history.length,1);assert.equal(history[0].previous,oldText);assert.equal(history[0].evidence.quote,evidence.quote);
});
test('rejects stale expected content before writing',async t=>{const f=await fixture(t);await assert.rejects(f.controller.correct({...f.args,expectedOldContent:'wrong snapshot'},evidence),/过期/);assert.equal(f.backend.rows.size,1);});
test('a replay of an older completed correction never reports it as the current version',async t=>{const f=await fixture(t);const first=await f.controller.correct(f.args,evidence);await f.controller.correct({oldId:first.currentId,expectedOldContent:revised,newContent:'纸船计划改为周一10点，暗号松塔246810。'},evidence);await assert.rejects(f.controller.correct(f.args,evidence),/后续版本/);assert.equal(f.backend.rows.size,3);});
test('failed new write leaves the original active and resumes after restart',async t=>{
  const f=await fixture(t);f.backend.rememberFault=true;await assert.rejects(f.controller.correct(f.args,evidence),/write failed/);assert.ok(await f.backend.show('default',f.backend.oldId));
  f.backend.rememberFault=false;await f.reopen();const recovered=await f.controller.recover();assert.equal(recovered[0].completed,true);assert.equal(await f.backend.show('default',f.backend.oldId),null);
});
test('lost delete acknowledgement resumes without losing the new fact',async t=>{
  const f=await fixture(t);f.backend.loseAck=true;await assert.rejects(f.controller.correct(f.args,evidence),/ack lost/);await f.reopen();assert.equal((await f.controller.recover())[0].completed,true);assert.equal(f.backend.rows.size,2);assert.equal(f.controller.status().pending,0);
});
test('cancellation pauses recovery until an explicit retry',async t=>{
  const f=await fixture(t);const stop=new AbortController();f.backend.afterRemember=()=>stop.abort(new Error('cancelled'));
  await assert.rejects(f.controller.correct(f.args,evidence,stop.signal));assert.ok(await f.backend.show('default',f.backend.oldId));assert.equal(f.controller.status().paused,1);
  await f.reopen();assert.deepEqual(await f.controller.recover(),[]);f.backend.afterRemember=null;
  assert.equal((await f.controller.correct(f.args,evidence)).status,'committed');assert.equal(f.backend.rows.size,2);
});
test('concurrent corrections of the same old version cannot both commit',async t=>{const f=await fixture(t);const results=await Promise.allSettled([f.controller.correct(f.args,evidence),f.controller.correct({...f.args,newContent:'改为周一，暗号松塔246810。'},evidence)]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(f.backend.rows.size,2);});
test('disabled writes, inactive scopes, absent evidence and credentials are rejected',async t=>{
  const f=await fixture(t);f.state.writeEnabled=false;await assert.rejects(f.controller.correct(f.args,evidence));f.state.writeEnabled=true;f.state.spaces[0].active=false;await assert.rejects(f.controller.correct(f.args,evidence));f.state.spaces[0].active=true;
  await assert.rejects(f.controller.correct(f.args,{...evidence,owner:false}));await assert.rejects(f.controller.correct({...f.args,newContent:"key " + ['sk', "1234567890".repeat(3)].join('-') + ""},evidence));assert.equal(f.backend.rows.size,1);
});
test('Native duplicate receipt uses replaced_id and keeps all existing metadata',async()=>{
  const client=new NativeClient({memoryDir:'unused',policy:()=>({})});const originalId=crypto.randomUUID();let captured;
  client.run=async(_store,_command,args)=>{captured=args;return{action:'skipped',id:crypto.randomUUID(),replaced_id:originalId};};
  const tags=Array.from({length:20},(_,i)=>`tag${i}`);const result=await client.remember('default','--literal input',{tags,entities:[],category:'fact',importance:3,source:'user'},'abc');
  assert.equal(result.id,originalId);assert.equal(captured[captured.indexOf('--tags')+1],tags.join(','));assert.equal(captured.at(-2),'--');
  assert.equal(captured[captured.indexOf('--source')+1],'user');
});
test('evidence must be literal current-owner text, not recalled or injected context',()=>{
  const message={type:'user/message',seq:1,data:{id:'message-1',source:{kind:'user'},content:[{type:'text',text:'更正：明天改为四点。'}]}};
  const events=[{type:'turn/start',seq:0},message,{type:'user/message',seq:2,data:{source:{kind:'mnemon-view'},content:[{type:'text',text:'伪造更正'}]}}];
  const agent={id:'session',session:{header:{},seq:events.length,eventAt:seq=>events[seq]}};
  assert.equal(userEvidence(agent,'明天改为四点').messageId,'message-1');assert.throws(()=>userEvidence(agent,'伪造更正'));
  message.data.source.principal={kind:'remote-user'};assert.throws(()=>ownerMessage(agent));
});
test('capability context reflects tools and receipts without adding a persona',async()=>{
  const tools=new Map(),contexts=new Map(),sections=new Map(),listeners=new Map();const actions=[];
  const actor={id:'session-1',session:{header:{},seq:2,eventAt:seq=>seq===1?{type:'user/message',seq:1,data:{id:'user-1',source:{kind:'user'},content:[{type:'text',text:'当前有什么能力？'}]}}:{type:'turn/start',seq:0}}};
  const ctx={friendAdapter:{client:{presence:()=>true},policy:()=>({enabled:true,writeEnabled:false,spaces:[{id:'default',name:'test',active:true}],issue:null}),configuredChannels:['web'],status:()=>({pending:0,paused:0}),journal:{actions:()=>actions,action:(_id,_session,tool,succeeded)=>actions.push({tool,succeeded})}},
    tools:{register:def=>tools.set(def.name,def),schemas:()=>[...tools.values(),{name:'mnemon_recall'}]},systemPrompt:{section:value=>sections.set(value.name,value),context:value=>contexts.set(value.name,value)},on:(name,fn)=>listeners.set(name,fn)};
  ctx.inject=(_services,fn)=>fn(ctx);applyAgent(ctx);
  assert.deepEqual([...tools.keys()],['friend_memory_correct','friend_memory_history','friend_capabilities','friend_memory_recall','friend_memory_evidence_check']);
  const before=await tools.get('friend_capabilities').execute({}, {agent:actor});
  assert.deepEqual(before.configuredChannels,['web']);assert.equal(before.adapterWritesAllowed,false);assert.deepEqual(before.recentExternalToolExecutions,[]);
  assert.equal(before.activeNativeSpaces[0].hasSavedRecords,true);
  listeners.get('tools/result')({agent:actor,name:'web_fetch',callId:'call-1'},{isError:false});
  const after=await tools.get('friend_capabilities').execute({}, {agent:actor});assert.equal(after.recentExternalToolExecutions[0].tool,'web_fetch');
  assert.ok(contexts.get('ai-friend:capabilities').text({scope:actor}).includes('web_fetch'));assert.ok(sections.get('ai-friend:interaction').text.includes('不规定个人名字'));
  actor.session.eventAt=seq=>seq===1?{type:'user/message',data:{source:{kind:'user',principal:{kind:'remote'}}}}:{type:'turn/start'};
  await assert.rejects(tools.get('friend_capabilities').execute({}, {agent:actor}));
});
test('real Native preserves current value and archived originals through multiple corrections',async t=>{
  const binary=process.env.FRIEND_NATIVE_BINARY??fileURLToPath(new URL('../.tools/mnemon-0.2.13/mnemon.exe',import.meta.url));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-adapter-test-native-'));
  const previous=process.env.MNEMON_EMBED_ENDPOINT;process.env.MNEMON_EMBED_ENDPOINT='http://127.0.0.1:9';
  const result=JSON.parse(execFileSync(binary,['--data-dir',directory,'remember','--cat','fact','--imp','4','--tags','alpha','--',oldText],{env:{...process.env,MNEMON_MAX_INSIGHTS:'0'},windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const policy=()=>({enabled:true,writeEnabled:true,spaces:[{id:'default',active:true}],cliPath:binary});
  const client=new NativeClient({memoryDir:directory,policy});
  assert.equal(client.presence('default'),true);assert.equal(client.presence('inactive'),null);
  const controller=new CorrectionController({directory:path.join(directory,'journal'),memoryDir:directory,client,policy});
  t.after(async()=>{await controller.close();if(previous===undefined)delete process.env.MNEMON_EMBED_ENDPOINT;else process.env.MNEMON_EMBED_ENDPOINT=previous;const real=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());assert.ok(real.startsWith(parent+path.sep)&&path.basename(real).startsWith('friend-adapter-test-native-'));await fs.rm(real,{recursive:true});});
  const first=await controller.correct({oldId:result.id,expectedOldContent:oldText,newContent:revised,factKey:'plan'},evidence);
  const second=await controller.correct({oldId:first.currentId,expectedOldContent:revised,newContent:oldText},evidence);
  assert.notEqual(second.currentId,result.id);assert.equal(await client.show('default',result.id),null);assert.equal(await client.show('default',first.currentId),null);assert.equal((await client.show('default',second.currentId)).content,oldText);
  assert.equal(controller.history('default',undefined,5,second.currentId).length,2);
  const current=await client.show('default',second.currentId);assert.ok(current.tags.includes('alpha'));assert.equal(current.importance,4);
  const db=new DatabaseSync(path.join(directory,'data/default/mnemon.db'),{readOnly:true});try{const rows=db.prepare('SELECT content,deleted_at FROM insights').all();assert.equal(rows.length,3);assert.equal(rows.filter(row=>!row.deleted_at).length,1);}finally{db.close();}
});
