import {BilibiliWorkbenchView,visibleText} from './workbench-view.js';
import {fetchFollowing} from './console.js';
const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
function originMatches(request){try{const u=new URL(request.url),raw=request.headers.get('origin');if(!raw)return false;const o=new URL(raw);if(!['http:','https:'].includes(o.protocol)||o.origin!==raw)return false;return u.hostname==='dsh.internal'?o.host===request.headers.get('host'):o.origin===u.origin;}catch{return false;}}
function query(request,allowed){const u=new URL(request.url),keys=[...u.searchParams.keys()];if(request.url.length>2048||keys.some(k=>!allowed.includes(k))||new Set(keys).size!==keys.length)throw Object.assign(Error('请求参数无效'),{status:400});return u.searchParams;}
function number(value,fallback){if(value===null)return fallback;if(!/^\d{1,6}$/.test(value))throw Object.assign(Error('分页参数无效'),{status:400});return Number(value);}
async function body(request){
 if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw Object.assign(Error('需要JSON请求'),{status:415});
 const reader=request.body?.getReader();if(!reader)throw Object.assign(Error('请求体为空'),{status:400});let size=0;const chunks=[];try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8192){await reader.cancel();throw Object.assign(Error('请求体过大'),{status:413});}chunks.push(r.value);}}finally{reader.releaseLock();}
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(Error('JSON格式无效'),{status:400});}
 const allowed=value?.kind==='settings'?['kind','changes','expectedRevision','requestId']:['kind','id','action','expectedRevision','requestId'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(value,k)))throw Object.assign(Error('操作参数无效'),{status:400});return value;
}
export function workbenchResponse(view,kind='state'){return async request=>{
 const method=kind==='control'?'POST':'GET';if(request.method!==method)return new Response(null,{status:405,headers:{...headers,allow:method}});
 try{
  request.signal.throwIfAborted();
  if(kind==='control'){query(request,[]);if(!originMatches(request))return Response.json({error:'管理操作需要同源页面请求'},{status:403,headers});const command=await body(request);request.signal.throwIfAborted();return Response.json(view.command(command),{headers});}
  if(kind==='detail'){const p=query(request,['id','kind']);return Response.json(view.detail(p.get('id'),p.get('kind')??'task'),{headers});}
  if(kind==='frame'){const p=query(request,['task','observation','sha']),f=await view.frame(p.get('task'),p.get('observation'),p.get('sha'),request.signal);return new Response(f.data,{headers:{...headers,'content-type':f.mediaType}});}
  if(kind==='following'){query(request,[]);const f=await fetchFollowing(view.c.instance,{signal:request.signal});return Response.json({state:f.state,total:f.total,list:f.list?.map(r=>({mid:r.mid,name:visibleText(r.name,80),sign:visibleText(r.sign,150)})),reason:visibleText(f.reason??f.scope,300)},{headers});}
  const p=query(request,['section','offset','limit']);return Response.json(view.snapshot({section:p.get('section')??'overview',offset:number(p.get('offset'),0),limit:number(p.get('limit'),24)}),{headers});
 }catch(error){
  request.signal.throwIfAborted();if(error.replayedResult)return Response.json(error.replayedResult,{headers});
  const status=[400,403,404,409,413,415].includes(error.status)?error.status:error.requestInvalid?400:503;
  return Response.json({error:status===503?'工作台数据暂不可用，原任务与记忆保留':visibleText(error.message,240)||'请求未完成'},{status,headers});
 }
};}
export function attachWorkbenchHost(ctx,controller){
 const view=new BilibiliWorkbenchView(controller);
 ctx.inject(['connection'],bound=>{
  const connection=bound.get('connection');
  for(const [suffix,kind]of [['','state'],['-detail','detail'],['-frame','frame'],['-following','following'],['-control','control']])bound.effect(()=>connection.fetch.register({path:'/api/ai-friend-bilibili-workbench'+suffix,methods:kind==='control'?['POST']:['GET'],requestBody:kind==='control'?'streaming':'buffered',fetch:workbenchResponse(view,kind)}),'bilibili workbench '+kind);
  bound.inject(['attachments'],images=>{view.attachments=images.get('attachments');images.effect(()=>()=>{view.attachments=null;},'bilibili workbench attachment reader');});
 });
 return view;
}
