const ID=/^[a-z][a-z0-9_-]{0,59}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(status,message)=>Object.assign(Error(message),{status});
export class ActivityRegistry {
 constructor(){this.readers=new Map();this.sourceMap=new Map([['qq','QQ'],['bilibili','B站'],['web','Web聊天'],['internal','内部活动'],['unknown','来源未分类']].map(([id,label])=>[id,{id,label}]));}
 sources(){return [...this.sourceMap.values()].map(({id,label})=>({id,label}));}
 registerSource(id,label){if(!ID.test(id)||typeof label!=='string'||!label.trim()||label.length>80||this.sourceMap.has(id))throw Error('活动来源定义无效或已注册');const entry={id,label:label.trim()};this.sourceMap.set(id,entry);return ()=>{if(this.sourceMap.get(id)===entry)this.sourceMap.delete(id);};}
 register(id,reader){
  if(!ID.test(id)||!reader||typeof reader.snapshot!=='function'||typeof reader.detail!=='function')throw Error('活动读取接口无效');
  if(this.readers.has(id))throw Error('活动读取接口已经注册');
  const entry={reader};this.readers.set(id,entry);return ()=>{if(this.readers.get(id)===entry)this.readers.delete(id);};
 }
 get(id='companion'){if(!ID.test(id))throw fail(400,'读取来源无效');const r=this.readers.get(id);if(!r)throw fail(503,'活动读取服务尚未就绪');return r.reader;}
}
export function activityResponse(registry,detail=false){return async request=>{
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
 if(request.method!=='GET')return new Response(null,{status:405,headers:{...headers,allow:'GET'}});
 try{
  request.signal.throwIfAborted();const u=new URL(request.url),keys=[...u.searchParams.keys()],allowed=detail?['provider','kind','id']:['provider','section','source','kind','status','limit','offset','refKind','refId'];
  if(request.url.length>2048||new Set(keys).size!==keys.length||keys.some(k=>!allowed.includes(k)))throw fail(400,'查看参数无效');
  const p=u.searchParams,reader=registry.get(p.get('provider')??'companion');let result;
  if(detail){const kind=p.get('kind'),id=p.get('id');if(!['intent','decision'].includes(kind)||!UUID.test(id??''))throw fail(400,'详情参数无效');result=reader.detail(kind,id);if(!result)throw fail(404,'未找到该活动记录');}
  else{
   const section=p.get('section')??'overview';if(!['overview','tasks','choices','resources','settings'].includes(section))throw fail(400,'栏目无效');
   const options={section};for(const k of ['source','kind','status']){const v=p.get(k)??'all';if(v!=='all'&&!ID.test(v))throw fail(400,'筛选参数无效');options[k]=v;}
   for(const [k,fallback,max]of [['limit',24,48],['offset',0,10000]]){const v=p.get(k);if(v!==null&&!/^\d{1,6}$/.test(v))throw fail(400,'分页参数无效');options[k]=v===null?fallback:Number(v);if(options[k]>max||options[k]<(k==='limit'?1:0))throw fail(400,'分页参数无效');}
   if(p.has('refKind')||p.has('refId')){if(!['run','reading','event'].includes(p.get('refKind'))||!UUID.test(p.get('refId')??''))throw fail(400,'关联参数无效');options.refKind=p.get('refKind');options.refId=p.get('refId');}
   result=section==='settings'?{schema:'ai-friend/activity-console/1',available:true,section,generatedAt:new Date().toISOString(),settings:reader.settings?.()??{available:false,notice:'当前实例没有可编辑的活动配置'}}:reader.snapshot(options);
  }
  request.signal.throwIfAborted();return Response.json(result,{headers});
 }catch(error){request.signal.throwIfAborted();const status=[400,404,503].includes(error.status)?error.status:503;return Response.json({error:status===400?'查看参数无效':status===404?'未找到该活动记录':'活动中心暂不可用，原任务和记忆保留'},{status,headers});}
};}

function originMatches(request){try{const u=new URL(request.url),raw=request.headers.get('origin');if(!raw)return false;const o=new URL(raw);return ['http:','https:'].includes(o.protocol)&&o.origin===raw&&(u.hostname==='dsh.internal'?o.host===request.headers.get('host'):o.origin===u.origin);}catch{return false;}}
async function readCommand(request){
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw fail(415,'需要JSON配置请求');const reader=request.body?.getReader();if(!reader)throw fail(400,'配置请求为空');let bytes=0;const chunks=[];try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>8192){await reader.cancel();throw fail(413,'配置请求过大');}chunks.push(r.value);}}finally{reader.releaseLock();}
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'配置请求不是有效JSON');}const keys=['kind','requestId','expectedRevision','changes'];if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k))||value.kind!=='settings'||!UUID.test(value.requestId??'')||!/^[a-f0-9]{64}$/.test(value.expectedRevision??''))throw fail(400,'配置请求参数无效');return value;
}
export function activityControlResponse(registry){return async request=>{
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};if(request.method!=='POST')return new Response(null,{status:405,headers:{...headers,allow:'POST'}});
 try{request.signal.throwIfAborted();const u=new URL(request.url);if(u.search||request.url.length>2048)throw fail(400,'配置请求参数无效');if(!originMatches(request))throw fail(403,'配置修改需要同源页面');const command=await readCommand(request),reader=registry.get();if(typeof reader.configure!=='function')throw fail(503,'活动配置尚不可用');request.signal.throwIfAborted();return Response.json(reader.configure(command),{headers});}
 catch(error){request.signal.throwIfAborted();const status=[400,403,409,413,415,503].includes(error.status)?error.status:error.requestInvalid?400:503;return Response.json({error:status===409?'配置版本或请求冲突，请刷新后重新确认':status===400?'配置修改未通过校验':status===403?'当前页面或实例不允许修改活动配置':status===413?'配置请求过大':status===415?'配置请求必须为JSON':'配置结果暂不可确认，请刷新核对，不会自动重试'},{status,headers});}
};}
