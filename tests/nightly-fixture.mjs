import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const project=process.env.AI_FRIEND_PROJECT_ROOT??fileURLToPath(new URL('../',import.meta.url));
const source=process.env.FRIEND_ADAPTER_SOURCE??path.join(project,'plugins/companion-adapter/src');
const module=name=>import(pathToFileURL(path.join(source,name)));
const {CorrectionController}=await module('controller.js'),{GrowthController}=await module('growth.js'),{PreviewController}=await module('preview.js'),{ApplicationController}=await module('apply.js'),{RuntimeWriter}=await module('apply-runtime.js'),{ApplyBackend}=await module('apply-backend.js'),{hash}=await module('validation.js'),{attachApplications}=await module('apply-agent.js');
const require=createRequire(path.join(project,'runtime/dev/dsh-home/profiles/web/package.json'));
const {createRuntimeMemorySource}=await import(pathToFileURL(require.resolve('dsh-mnemon-source-runtime')));
const old='纸桥活动当前约定周六15:00集合，取件暗号松塔246810。',updated='纸桥活动当前约定周日16:00集合，取件暗号松塔246810。';
const message='现在把纸桥活动的集合约定改为周日下午四点，暗号不变。请先生成报告，等我要求应用时再实际写入。';
const time=Date.parse('2026-10-27T03:00:00Z');
class Native{
  constructor(){this.rows=new Map();this.version=0;this.writes=0;this.oldId=crypto.randomUUID();this.rows.set(this.oldId,{id:this.oldId,content:old,category:'context',importance:3,tags:[],entities:[],source:'user',created_at:new Date(time).toISOString()});}
  assertStore(store){if(store!=='default')throw new Error('wrong store');}
  async show(_store,id,signal){signal?.throwIfAborted();const row=this.rows.get(id);return row&&!row.deleted?structuredClone(row):null;}
  showReadOnly(...args){return this.show(...args);}
  findExact(_store,content){return [...this.rows.values()].find(row=>!row.deleted&&row.content===content)?.id??null;}
  readRevision(){return String(this.version);}
  async remember(_store,content,metadata,_step,signal){signal?.throwIfAborted();const existing=this.findExact('default',content);if(existing)return {id:existing,action:'skipped'};const id=crypto.randomUUID();this.rows.set(id,{...metadata,id,content,created_at:new Date(time+this.version+1).toISOString()});this.version++;this.writes++;if(this.addAckLost){this.addAckLost=false;throw new Error('Native add acknowledgment lost');}return {id,action:'added'};}
  async forget(_store,id,signal){signal?.throwIfAborted();this.rows.get(id).deleted=true;this.version++;if(this.forgetAckLost){this.forgetAckLost=false;throw new Error('forget acknowledgment lost');}}
}
function persistence(workspace,sourceText=message){
  const sourceEvent={seq:1,time,data:{id:'source-message',source:{kind:'user'},content:[{type:'text',text:sourceText}]},type:'user/message'};
  const rows=new Map([['source-session',{header:{id:'source-session',createdAt:time,cwd:workspace,agentPreset:'companion',isSeeded:false},events:[{seq:0,time,type:'turn/start',data:{turn:1}},sourceEvent,{seq:2,time:time+1,type:'assistant/message',data:{message:{content:[{type:'text',text:'明白，先把约定变化作为整理依据。'}]}}},{seq:3,time:time+2,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}]}],['command-session',{header:{id:'command-session',createdAt:time+10,cwd:workspace,agentPreset:'companion',isSeeded:false},events:[]}]]);
  return {rows,async flush(){},async list(){return [...rows.values()].map(row=>({header:row.header,eventCount:row.events.length}));},async open(id,mode){assert.equal(mode,'read');const row=rows.get(id);if(!row)throw new Error('missing source');return {header:row.header,read:async(offset,length)=>({events:structuredClone(row.events.slice(offset,offset+length))}),close:async()=>{}};}};
}
async function fixture(t,{self=false,action='temporal_change',applicationConfig={},sourceText=message,critical=false}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'friend-apply-test-')),memoryDir=path.join(directory,'memory'),workspace=path.join(directory,'workspace');await fs.mkdir(workspace);
  const native=new Native(),state={writeEnabled:true,calls:0},clock={now:time};
  const policy=()=>({enabled:true,writeEnabled:state.writeEnabled,previewRuntimeSupported:true,spaces:[{id:'default',active:true,name:'测试空间'}],runtimeLimits:{memoryLimitBytes:10240,userLimitBytes:4096}});
  const persisted=persistence(workspace,sourceText);let correction,growth,preview,runtime,backend,app;
  const open=()=>{
    correction=new CorrectionController({directory,client:native,policy,memoryDir});growth=new GrowthController({journal:correction.journal,serial:(fn,signal)=>correction.serial(fn,signal),now:()=>new Date(clock.now)});
    runtime=new RuntimeWriter({memoryDir,policy,createSource:createRuntimeMemorySource});
    const reader={async token(){return hash(JSON.stringify({entries:(await runtime.snapshot()).entries,native:native.version,growth:growth.store.revision()}));},async read(queries){
      const entries=(await runtime.snapshot()).entries,items=entries.map(row=>({id:`runtime:${row.target}:${hash(row.content)}`,kind:'runtime',target:row.target,importance:row.importance,text:row.content,createdAt:row.created_at,updatedAt:row.updated_at,revision:hash(JSON.stringify(row))}));
      for(const row of native.rows.values())if(!row.deleted)items.push({id:`native:default:${row.id}`,kind:'native',storeId:'default',recordId:row.id,text:row.content,createdAt:row.created_at});
      for(const row of growth.read().states)items.push({id:`self:${row.id}`,kind:'self',key:row.key,text:row.statement,status:row.effectiveStatus});
      return {items,queries,coverage:{native:'sampled',nativeIsComplete:false},notices:[],token:await this.token()};
    }};
    preview=new PreviewController({journal:correction.journal,workspace,memoryReader:reader,now:()=>new Date(clock.now)});backend=new ApplyBackend({runtime,correction,growth});
    app=new ApplicationController({journal:correction.journal,preview,backend,memoryReader:reader,growth,policy,workspace,config:applicationConfig,now:()=>new Date(clock.now)});growth.pendingReviewKeys=()=>app.pendingStateKeys();
  };open();
  await runtime.manage('mutate','mutate',{action:'add',target:'memory',content:old,importance:critical?'critical':'normal'});
  if(self){
    const base=growth.store.put({kind:'trait',key:'trait:纸桥联系时间',statement:'我把纸桥计划的周六15点当作联系时间。',status:'tentative',supports:['original-event'],dependsOn:[],reason:'测试夹具中的旧安排。',batchId:'fixture'});
    growth.store.put({kind:'personal_prompt',key:'personal_prompt:current',statement:'纸桥计划周六下午可以问一下进展。',status:'tentative',supports:['original-event'],dependsOn:[base.id],reason:'测试中的旧安排派生偏好。',batchId:'fixture'});
  }
  const sourceRow={id:`event:${hash('source-session:1:user_message')}`,sessionId:'source-session',seq:1,messageId:'source-message',kind:'user_message',occurredAt:new Date(time).toISOString(),text:sourceText,contentHash:hash(sourceText)};
  const memory=await preview.memoryReader.read([]),refs=memory.items.filter(row=>action==='leave_hot'?row.kind==='runtime':row.kind!=='self').map(row=>row.id);
  const snapshot={protocol:'fixture-preview',sources:{sources:[sourceRow],ranges:[{sessionId:'source-session',from:0,upper:4,nextSeq:4}],excluded:[],notices:[],completedTurns:1},memories:memory};
  const report=preview.store.begin('fixture-report',snapshot,6,false).row;preview.store.finish(report.id,'completed',{decision:{summary:'测试提案',proposals:[{action,summary:'核对纸桥安排。',reason:'原话明确更正，需同步旧副本。',evidence:[{sourceId:sourceRow.id,quote:sourceText}],referenceIds:refs}]}});
  const close=async()=>{await app.close();await preview.close();await growth.close();await correction.close();};
  t.after(async()=>{await close();const actual=await fs.realpath(directory),temp=await fs.realpath(os.tmpdir());assert.ok(actual.startsWith(temp+path.sep)&&path.basename(actual).startsWith('friend-apply-test-'));await fs.rm(actual,{recursive:true});});
  return {directory,workspace,memoryDir,native,state,clock,policy,persistence:persisted,source:sourceRow,reportId:report.id,get app(){return app;},get runtime(){return runtime;},get growth(){return growth;},get preview(){return preview;},get backend(){return backend;},get journal(){return correction.journal;},async reopen(){await close();open();},caller(){return {owner:true,sessionId:'command-session',messageId:'apply-command',seq:1,turnStart:0,quote:'应用这份报告。'};}};
}
function plan(frame,{self=true,onlyRuntime=false}={}){
  const evidence=frame.proposals[0].evidence;const operations=frame.memories.items.filter(row=>['runtime','native'].includes(row.kind)&&row.text===old).filter(row=>!onlyRuntime||row.kind==='runtime').map(row=>({kind:row.kind==='runtime'?'runtime_replace':'native_correct',referenceId:row.id,content:updated,evidence}));
  const state=frame.memories.items.find(row=>row.kind==='self'&&row.key==='trait:纸桥联系时间');if(self&&state)operations.push({kind:'review_self',referenceId:state.id,becauseRefs:[operations[0].referenceId],evidence});
  return {decision:{decisions:[{proposalIndex:0,verdict:'apply',timing:'current',reason:'当前约定已更正，保留暗号，复核确实依赖旧时间的状态。',operations}]},provider:'fixture',model:'fixture',usage:{inputTokens:80,outputTokens:60}};
}
const run=(f,review=frame=>plan(frame),args={},signal)=>f.app.run({reportId:f.reportId,...args},f.caller(),f.persistence,frame=>{f.state.calls++;return review(frame);},signal);

export {fixture,plan,old,updated,message,time,source,module};
