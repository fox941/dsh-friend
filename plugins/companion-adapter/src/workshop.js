import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {runWorkshopScript} from './workshop-sandbox.js';

const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const encode=x=>JSON.stringify(x,null,2)+'\n';
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const limits=Object.freeze({fileBytes:128*1024,totalFileBytes:32*1024*1024,files:512,tools:48,codeBytes:64*1024,inputBytes:64*1024,resultBytes:32*1024,writes:8,cases:5,runsPerDay:128,cpuMilliseconds:2000,guestMemoryBytes:16*1024*1024});
export function workshopPath(value){
  if(typeof value!=='string'||!value||value.length>180||value.includes('\\')||value.startsWith('/')||value.split('/').some(s=>!s||s==='.'||s==='..'||s.startsWith('.')||/[<>:"|?*\x00-\x1f]/.test(s)||/[. ]$/.test(s)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))throw Error('文件路径须为工作目录内的相对路径，不支持链接、隐藏目录或设备路径');
  return value;
}
function toolName(n){if(typeof n!=='string'||!/^self_[a-z][a-z0-9_]{1,45}$/.test(n))throw Error('自制工具名称须使用 self_ 开头的小写字母、数字和下划线');return n;}
function verifyDefinition(d){if(!d||!Array.isArray(d.readFiles)||!Array.isArray(d.writeFiles)||d.version!==hash(JSON.stringify({name:d.name,description:d.description,code:d.code,readFiles:d.readFiles,writeFiles:d.writeFiles})))throw Error('工具定义或版本哈希校验失败');toolName(d.name);for(const p of [...d.readFiles,...d.writeFiles])workshopPath(p);return d;}
function boundedText(v,label,max){if(typeof v!=='string'||Buffer.byteLength(v)>max||v.includes('\0'))throw Error(label+'为空、包含空字符或超过字节限制');return v;}
async function noLinks(file){let current=path.resolve(file);while(true){try{if((await fs.lstat(current)).isSymbolicLink())throw Error('工作文件路径不能经过链接或目录联接');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(current);if(parent===current)break;current=parent;}}
async function atomic(file,bytes){await noLinks(file);const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}

/** Files and generated tools are artifacts, never authoritative personality or memory. */
export class Workshop{
  constructor({instance,enabled=()=>true,validate=()=>{},now=()=>new Date(),runner=runWorkshopScript}={}){
    this.root=path.join(instance,'workshop');this.files=path.join(this.root,'files');this.enabled=enabled;this.validate=validate;this.now=now;this.runner=runner;this.tail=Promise.resolve();this.stop=new AbortController();this.closed=false;this.running=null;
    this.ready=this.initialize();
  }
  async initialize(){await noLinks(this.root);for(const p of ['files','versions','receipts'])await fs.mkdir(path.join(this.root,p),{recursive:true});const file=path.join(this.root,'registry.json');await noLinks(file);let state;try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state={schema:'ai-friend/workshop/1',tools:{},budget:{},revision:0};await atomic(file,encode(state));}if(state.schema!=='ai-friend/workshop/1'||!plain(state.tools)||!plain(state.budget)||!Number.isSafeInteger(state.revision))throw Error('工作间注册表无效，未重建或清空');this.state=state;await this.recover();}
  async recover(){const rows=[];for(const name of await fs.readdir(path.join(this.root,'receipts'))){if(!/^[a-f0-9-]{36}\.json$/.test(name))throw Error('工作间回执目录存在未知文件');const file=path.join(this.root,'receipts',name);await noLinks(file);const row=JSON.parse(await fs.readFile(file,'utf8'));rows.push({row,file});if(row.kind!=='file_write'||row.status!=='prepared')continue;let current;try{current=await this.readInternal(row.path);}catch{continue;}row.status=current.version===row.after?'committed':current.version===row.before?'interrupted':'conflict';row.recoveredAt=this.now().toISOString();await atomic(file,encode(row));}for(const {row,file} of rows)if(row.kind==='tool_run'&&row.status==='running'){row.status='interrupted';row.error='进程退出后仅核对文件回执，不重新执行工具';row.fileReceipts=rows.filter(x=>x.row.kind==='file_write'&&x.row.status==='committed'&&x.row.source?.toolRunId===row.id).map(x=>({receiptId:x.row.id,path:x.row.path,version:x.row.after,status:'written'}));await atomic(file,encode(row));}}
  serial(fn){const p=this.tail.then(()=>this.ready).then(async()=>{if(this.closed)throw Error('工作间已关闭');try{return await fn();}catch(e){this.state=JSON.parse(await fs.readFile(path.join(this.root,'registry.json'),'utf8'));throw e;}});this.tail=p.catch(()=>{});return p;}
  writesAllowed(){if(this.closed||!this.enabled())throw Error('当前实例未开放工作间写入和脚本执行');}
  async save(){this.state.revision++;await atomic(path.join(this.root,'registry.json'),encode(this.state));}
  async readInternal(name){workshopPath(name);const file=path.join(this.files,...name.split('/'));await noLinks(file);let handle;try{handle=await fs.open(file,constants.O_RDONLY);const stat=await handle.stat();if(!stat.isFile()||stat.size>limits.fileBytes)throw Error('文件类型或大小不支持');const bytes=await handle.readFile(),content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return {path:name,content,version:hash(bytes),bytes:bytes.length};}catch(e){if(e.code==='ENOENT')return {path:name,content:null,version:'absent',bytes:0};throw e;}finally{await handle?.close();}}
  read(name){return this.serial(()=>this.readInternal(name));}
  async inventory(){const out=[];const walk=async(dir,prefix='')=>{await noLinks(dir);for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('工作目录出现链接，停止读取');const name=prefix+e.name;workshopPath(name);if(e.isDirectory())await walk(path.join(dir,e.name),name+'/');else if(e.isFile()){const s=await fs.stat(path.join(dir,e.name));out.push({path:name,bytes:s.size});if(out.length>limits.files)throw Error('工作文件数超过限制');}else throw Error('工作目录出现不支持的文件类型');}};await walk(this.files);return out.sort((a,b)=>a.path.localeCompare(b.path));}
  list(){return this.serial(async()=>({status:'read',files:await this.inventory(),...this.status()}));}
  status(){return {enabled:this.enabled(),running:this.running,limits,storage:'本实例 workshop；完整实例备份/迁移携带，自制工具不是记忆或人格',registered:this.state?Object.values(this.state.tools).filter(t=>t.active).map(t=>({name:t.name,description:t.active.description,version:t.active.version,readFiles:t.active.readFiles,writeFiles:t.active.writeFiles})):[],drafts:this.state?Object.values(this.state.tools).filter(t=>t.draft).map(t=>({name:t.name,version:t.draft.version,tested:t.draft.test?.passed===true})):[],execution:'QuickJS WASM独立进程，仅JSON输入输出；不提供Node、网络、终端、插件安装或宿主工具调用'};}
  async validateWrite(change){
    if(!plain(change)||Object.keys(change).some(k=>!['path','content','expectedVersion'].includes(k)))throw Error('文件变更字段无效');workshopPath(change.path);boundedText(change.content,'文件内容',limits.fileBytes);this.validate(change.content);
    const before=await this.readInternal(change.path);if(typeof change.expectedVersion!=='string'||before.version!==change.expectedVersion)throw Error('文件已变化，请重新读取后再修改；新文件用 absent');return before;
  }
  async writeInternal(change,source){
    this.writesAllowed();const before=await this.validateWrite(change),bytes=Buffer.from(change.content),after=hash(bytes);if(before.version===after)return {status:'unchanged',path:change.path,version:after};
    const files=await this.inventory(),existing=files.some(f=>f.path.toLowerCase()===change.path.toLowerCase());if(!existing&&files.length>=limits.files||files.reduce((n,f)=>n+f.bytes,0)-before.bytes+bytes.length>limits.totalFileBytes)throw Error('工作间容量不足，未写入');
    for(const [version,content] of [[before.version,before.content],[after,change.content]])if(version!=='absent'){const file=path.join(this.root,'versions',version);await noLinks(file);try{await fs.writeFile(file,content,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(hash(await fs.readFile(file))!==version)throw Error('文件历史校验失败');}}
    const id=crypto.randomUUID(),receipt={id,kind:'file_write',status:'prepared',path:change.path,before:before.version,after,source,at:this.now().toISOString()},file=path.join(this.root,'receipts',id+'.json');await atomic(file,encode(receipt));
    const target=path.join(this.files,...change.path.split('/'));await noLinks(path.dirname(target));await fs.mkdir(path.dirname(target),{recursive:true});if((await this.readInternal(change.path)).version!==before.version)throw Error('提交前文件已变化，未覆盖');
    await atomic(target,bytes);receipt.status='committed';await atomic(file,encode(receipt));return {status:'written',path:change.path,version:after,receiptId:id,previousVersion:before.version};
  }
  write(change,source){return this.serial(()=>this.writeInternal(change,source));}
  history(name){return this.serial(async()=>{workshopPath(name);const rows=[];for(const f of await fs.readdir(path.join(this.root,'receipts'))){await noLinks(path.join(this.root,'receipts',f));const row=JSON.parse(await fs.readFile(path.join(this.root,'receipts',f),'utf8'));if(row.kind==='file_write'&&row.path===name)rows.push({id:row.id,status:row.status,before:row.before,after:row.after,at:row.at});}return {path:name,versions:rows.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,30)};});}
  restore({path:name,version,expectedVersion},source){return this.serial(async()=>{workshopPath(name);if(!/^[a-f0-9]{64}$/.test(version))throw Error('历史版本无效');let approved=false;for(const f of await fs.readdir(path.join(this.root,'receipts'))){const p=path.join(this.root,'receipts',f);await noLinks(p);const r=JSON.parse(await fs.readFile(p,'utf8'));if(r.kind==='file_write'&&r.path===name&&[r.before,r.after].includes(version)&&r.status==='committed')approved=true;}if(!approved)throw Error('该版本不属于此文件');const file=path.join(this.root,'versions',version);await noLinks(file);const content=await fs.readFile(file,'utf8');if(hash(content)!==version)throw Error('历史版本校验失败');return this.writeInternal({path:name,content,expectedVersion},source);});}
  define(args,source){return this.serial(async()=>{
    this.writesAllowed();const {name,description,code,readFiles=[],writeFiles=[],expectedVersion}=args;toolName(name);boundedText(description,'工具说明',1200);if(!description.trim())throw Error('工具说明不能为空');boundedText(code,'工具代码',limits.codeBytes);this.validate(code);this.validate(description);
    if(!Array.isArray(readFiles)||!Array.isArray(writeFiles)||readFiles.length>8||writeFiles.length>8)throw Error('读写文件声明最多各8项');for(const n of [...readFiles,...writeFiles])workshopPath(n);if(new Set(readFiles.map(n=>n.toLowerCase())).size!==readFiles.length||new Set(writeFiles.map(n=>n.toLowerCase())).size!==writeFiles.length)throw Error('文件声明不能重复，包括Windows大小写别名');
    const old=this.state.tools[name];if(expectedVersion!==(old?.draft?.version??old?.active?.version??'absent'))throw Error('工具版本已变化，先读取注册表');if(!old&&Object.keys(this.state.tools).length>=limits.tools)throw Error('自制工具数量达到上限');
    const definition={name,description,code,readFiles,writeFiles},version=hash(JSON.stringify(definition));this.state.tools[name]={...old,name,draft:{...definition,version,source,at:this.now().toISOString()}};await this.save();return {status:'draft',name,version,notice:'草稿已保存，尚未测试和注册；旧正式版本继续有效'};
  });}
  tool(name){return this.serial(()=>{toolName(name);return structuredClone(this.state.tools[name]??null);});}
  async snapshots(def){const files=Object.create(null),versions=Object.create(null);for(const name of [...new Set([...def.readFiles,...def.writeFiles])]){const value=await this.readInternal(name);versions[name]=value.version;if(def.readFiles.includes(name))files[name]=value.content;}return {files,versions};}
  validateOutput(value,def){
    if(!plain(value)||!own(value,'result')||Object.keys(value).some(k=>!['result','writes'].includes(k)))throw Error('main须返回 {result: JSON, writes?: [{path,content}]}');if(Buffer.byteLength(JSON.stringify(value.result))>limits.resultBytes)throw Error('结果超过32KiB');this.validate(JSON.stringify(value));
    const writes=value.writes??[];if(!Array.isArray(writes)||writes.length>limits.writes)throw Error('文件输出数量超限');const seen=new Set();for(const w of writes){if(!plain(w)||Object.keys(w).some(k=>!['path','content'].includes(k))||!def.writeFiles.includes(w.path)||seen.has(w.path.toLowerCase()))throw Error('工具尝试写未声明或重复文件');seen.add(w.path.toLowerCase());boundedText(w.content,'文件输出',limits.fileBytes);}return {result:value.result,writes};
  }
  async execute(def,input,signal){
    verifyDefinition(def);if(!plain(input)||Buffer.byteLength(JSON.stringify(input))>limits.inputBytes)throw Error('input须为不超过64KiB的JSON对象');this.validate(JSON.stringify(input));const snap=await this.snapshots(def);signal?.throwIfAborted();const value=await this.runner({code:def.code,input,files:snap.files},signal);return {...this.validateOutput(value,def),versions:snap.versions};
  }
  async debit(){this.writesAllowed();const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(this.now());if((this.state.budget[day]??0)>=limits.runsPerDay)throw Error('今日自制工具执行额度已用完');this.state.budget[day]=(this.state.budget[day]??0)+1;await this.save();}
  test({name,version,cases},source,signal){return this.serial(async()=>{
    const def=this.state.tools[toolName(name)]?.draft;if(!def||def.version!==version)throw Error('草稿版本已变化');if(!Array.isArray(cases)||!cases.length||cases.length>limits.cases)throw Error('需要1–5个测试用例');
    const id=crypto.randomUUID(),outcomes=[];for(const c of cases){if(!plain(c)||!own(c,'expectedResult')||Object.keys(c).some(k=>!['input','expectedResult','expectedWrites'].includes(k)))throw Error('测试用例字段无效');await this.debit();try{const actual=await this.execute(def,c.input,AbortSignal.any([signal??new AbortController().signal,this.stop.signal]));const passed=isDeepStrictEqual(actual.result,c.expectedResult)&&isDeepStrictEqual(actual.writes,c.expectedWrites??[]);outcomes.push({passed,...passed?{}:{actual:{result:actual.result,writes:actual.writes}}});}catch(e){outcomes.push({passed:false,error:String(e.message).slice(0,350)});}}
    const result={id,name,version,passed:outcomes.every(o=>o.passed),cases:outcomes,source,at:this.now().toISOString(),dryRun:true};await atomic(path.join(this.root,'receipts',id+'.json'),encode({...result,kind:'tool_test',status:'completed'}));def.test=result;await this.save();return {status:result.passed?'tested':'test_failed',...result,notice:'只校验这些用例；未提交文件，不能证明所有输入正确'};
  });}
  publish({name,version,testId},source){return this.serial(async()=>{this.writesAllowed();const tool=this.state.tools[toolName(name)],d=tool?.draft;if(!d||d.version!==version||d.test?.id!==testId||!d.test.passed)throw Error('只能注册当前草稿且全部测试通过的版本');verifyDefinition(d);const stored=path.join(this.root,'versions',version+'.tool.json');await atomic(stored,encode(d));tool.active={...d,publishedAt:this.now().toISOString(),publishedBy:source};delete tool.draft;await this.save();return {status:'registered',name,version,call:'friend_tool_run',notice:'通过统一调用入口复用；不会安装npm包或授予终端、网络权限'};});}
  receipt(id){return this.serial(async()=>{if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw Error('回执ID无效');const file=path.join(this.root,'receipts',id+'.json');await noLinks(file);return JSON.parse(await fs.readFile(file,'utf8'));});}
  run({name,version,input,applyWrites=false},source,signal){return this.serial(async()=>{
    const def=this.state.tools[toolName(name)]?.active;if(!def||def.version!==version)throw Error('正式工具不存在或版本已变化');if(typeof applyWrites!=='boolean')throw Error('applyWrites须为布尔值');await this.debit();
    const id=crypto.randomUUID(),row={id,kind:'tool_run',status:'running',name,version,source,at:this.now().toISOString(),independentEvidence:false};await atomic(path.join(this.root,'receipts',id+'.json'),encode(row));this.running={id,name,version};
    try{const joined=AbortSignal.any([signal??new AbortController().signal,this.stop.signal]),value=await this.execute(def,input,joined);joined.throwIfAborted();row.result=value.result;row.plannedWrites=value.writes.map(w=>({path:w.path,bytes:Buffer.byteLength(w.content)}));row.fileReceipts=[];
      if(applyWrites){for(const w of value.writes)await this.validateWrite({...w,expectedVersion:value.versions[w.path]});for(const w of value.writes){joined.throwIfAborted();row.fileReceipts.push(await this.writeInternal({...w,expectedVersion:value.versions[w.path]},{...source,toolRunId:id}));await atomic(path.join(this.root,'receipts',id+'.json'),encode(row));}}
      row.status=applyWrites?'completed':'previewed';row.filesApplied=applyWrites;await atomic(path.join(this.root,'receipts',id+'.json'),encode(row));return {...row,preview:!applyWrites?value.writes:undefined};
    }catch(e){row.status=row.fileReceipts?.length?'partial':'failed';row.error=String(e.message).slice(0,350);await atomic(path.join(this.root,'receipts',id+'.json'),encode(row));return row;}finally{this.running=null;}
  });}
  async close(){this.closed=true;this.stop.abort();await this.tail;}
}
