import {SelfStateView} from './self-state-view.js';
export function selfStateResponse(view,detail=false){return async request=>{
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
 if(request.method!=='GET')return new Response(null,{status:405,headers:{...headers,allow:'GET'}});
 try{
  const u=new URL(request.url),keys=[...u.searchParams.keys()],allowed=detail?['kind','id']:[];
  if(keys.some(k=>!allowed.includes(k))||new Set(keys).size!==keys.length||request.url.length>1024)return Response.json({error:'查看参数无效'},{status:400,headers});
  request.signal.throwIfAborted();let result;
  if(detail){const kind=u.searchParams.get('kind'),key=u.searchParams.get('id');if(!['state','emotion','source','social','activity','audit-growth','audit-emotion','intent','decision'].includes(kind)||!key||key.length>180)return Response.json({error:'查看参数无效'},{status:400,headers});result=view.detail(kind,key);}
  else result=view.snapshot();
  return result?Response.json(result,{headers}):Response.json({error:'未找到该记录或不在可查看范围内'},{status:404,headers});
 }catch{request.signal.throwIfAborted();return Response.json({error:'自我状态暂不可用，原数据保留'},{status:503,headers});}
};}
export function attachSelfStateHost(ctx,adapter){
 const view=new SelfStateView(adapter);
 ctx.inject(['connection'],bound=>{
  const connection=bound.get?.('connection')??bound.connection;
  bound.effect(()=>connection.fetch.register({path:'/api/ai-friend-self-state',methods:['GET'],requestBody:'buffered',fetch:selfStateResponse(view)}),'ai-friend: owner self-state read view');
  bound.effect(()=>connection.fetch.register({path:'/api/ai-friend-self-state-detail',methods:['GET'],requestBody:'buffered',fetch:selfStateResponse(view,true)}),'ai-friend: owner self-state detail read view');
 });
}
