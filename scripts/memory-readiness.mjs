import fs from 'node:fs/promises';
import path from 'node:path';
const safeError=e=>{const text=String(e?.message??e);return /sk-[A-Za-z0-9]{16,}|token|cookie|authorization/i.test(text)?'记忆服务请求未完成，敏感诊断已省略':text.slice(0,500);};
/** Public Mnemon API only. An empty library is ready; explicit deactivation is retained. */
export async function ensureMemoryReady(client,{orphanStores=[],prior=null,save=async()=>{},label='陪伴记忆'}={}){
 const state={schema:'ai-friend/memory-bootstrap/1',checkedAt:new Date().toISOString()};
 const done=async patch=>{Object.assign(state,patch);await save(state);return state;};
 const read=async(endpoint)=>{const r=await client.rpc('dshMnemon/read',{endpoint,payload:{}});if(!r?.ok)throw Error(r?.error?.message??'记忆读取接口不可用');return r.value;};
 try{
  const status=await read('status');
  if(status.commandFound!==true)return done({status:'native_unavailable',ready:false,reason:'Native 可执行程序不可用；没有重建数据'});
  let directory=await read('body-directory');
  if(!Array.isArray(directory.items))throw Error('记忆空间目录格式无效');
  const active=directory.items.filter(b=>b.active===true);
  if(active.length)return done({status:'ready',ready:true,activeSpaceIds:active.map(b=>b.id),created:false});
  if(directory.items.length){
   const own=prior?.status==='created'&&directory.items.find(b=>b.id===prior.createdSpaceId);
   if(!own)return done({status:'no_active_spaces',ready:false,reason:'已有空间均未激活；保留原选择，请在记忆系统中选择空间',spaceIds:directory.items.map(b=>b.id)});
   state.createdSpaceId=own.id;
  }else{
   if(orphanStores.length)return done({status:'unregistered_stores',ready:false,reason:'发现未注册的原数据库；保留原件，需核对后恢复注册',storeIds:orphanStores});
   if(['creating','creation_unknown'].includes(prior?.status))return done({status:'creation_unknown',ready:false,reason:'前次创建回执不明，不重复创建空间'});
   await done({status:'creating',ready:false});
   let created;
   try{created=await client.rpc('dshMnemon/write',{endpoint:'body-create',payload:{name:label,description:'本实例的长期事实、约定与真实经历；作品、日记和梦须保留来源，不能自动当作事实。'}});}
   catch(e){return done({status:'creation_unknown',ready:false,reason:safeError(e)});}
   if(!created?.ok||typeof created.value?.id!=='string')return done({status:'create_failed',ready:false,reason:created?.error?.message?safeError(created.error.message):'空间创建未返回可核验结果'});
   await done({status:'created',ready:false,createdSpaceId:created.value.id});
  }
  const activated=await client.rpc('dshMnemon/activation',{endpoint:'body',payload:{memoryBodyId:state.createdSpaceId,active:true}});
  if(!activated?.ok)return done({status:'created',ready:false,reason:'新空间已创建，激活尚未完成；保留该空间供下次核对'});
  directory=await read('body-directory');
  if(!directory.items?.some(b=>b.id===state.createdSpaceId&&b.active===true))return done({status:'created',ready:false,reason:'激活未通过独立目录读回，保留原空间'});
  return done({status:'ready',ready:true,activeSpaceIds:directory.items.filter(b=>b.active===true).map(b=>b.id),created:true});
 }catch(e){return done({status:state.createdSpaceId?'created':'service_unavailable',ready:false,reason:safeError(e)});}
}
export async function initializeLocalMemory({root,client,label='陪伴记忆'}={}){
 const file=path.join(root,'operations/memory-bootstrap.json');let prior=null;
 try{prior=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('记忆初始化回执损坏，保留原件');}
 const stores=[];const dir=path.join(root,'memory/data');
 for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){
  if(e.isSymbolicLink())throw Error('记忆存储出现目录联接，未自动初始化');
  if(e.isDirectory()&&await fs.stat(path.join(dir,e.name,'mnemon.db')).then(s=>s.isFile(),e=>{if(e.code==='ENOENT')return false;throw e;}))stores.push(e.name);
 }
 const save=async value=>{await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);};
 return ensureMemoryReady(client,{orphanStores:stores,prior,save,label});
}
