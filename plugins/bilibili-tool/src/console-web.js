import {consoleSnapshot,fetchFollowing,applyConfigRequest,configFields,configRequestSchema,writeBilibiliConsole} from './console.js';

const json=(res,code,body)=>{const text=JSON.stringify(body);res.writeHead(code,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(text)});res.end(text);};
const readBody=req=>new Promise((resolve,reject)=>{let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>262144){reject(Error('请求体过大'));req.destroy();}});req.on('end',()=>resolve(raw));req.on('error',reject);});

/** 统一端点分发：HTTP prefix 路由与 Connection RPC 共用同一实现与校验。 */
export function createConsoleApi(controller){
 const instance=controller.instance;
 return async (endpoint,payload,signal)=>{
  if(endpoint==='state')return {ok:true,snapshot:consoleSnapshot(instance)};
  if(endpoint==='following')return {ok:true,following:await fetchFollowing(instance,{signal})};
  if(endpoint==='fields')return {ok:true,schema:configRequestSchema,fields:configFields};
  if(endpoint==='config'){
   const changes=payload?.changes;
   const request={schema:configRequestSchema,requestedAt:new Date().toISOString(),source:'web-ui',changes};
   const result=applyConfigRequest(instance,request,{sourceFile:'web-ui'});
   try{await writeBilibiliConsole(instance,{live:false});}catch{}
   return {ok:true,applied:result.applied,at:result.at,notice:'已应用并记入 config-audit.jsonl；面板数据将在下次生成/刷新时反映'};
  }
  const error=new Error('未知端点：'+endpoint);error.requestInvalid=true;error.notFound=true;throw error;
 };
}

/** HTTP 前缀路由（本机诊断入口）。webServer 的原始路由是否继承浏览器鉴权未做负向验证，
 * 因此这里只开放只读端点；写操作请走 Connection RPC（继承浏览器连接的信任校验）。 */
export function registerConsoleRoutes(webServer,controller){
 const instance=controller.instance,ROUTE='/dsh-bilibili-tool/api',api=createConsoleApi(controller);
 const dispose=webServer.register({
  kind:'prefix',
  path:ROUTE,
  handler:async(req,res)=>{
   try{
    const url=new URL(req.url??'/','http://127.0.0.1'),sub=url.pathname.slice(ROUTE.length).replace(/\/+$/,'')||'/',method=(req.method??'GET').toUpperCase();
    if(method!=='GET')return json(res,405,{ok:false,message:'该路由仅限 GET；写操作走 Connection RPC'});
    if(sub==='/state'){const r=await api('state');return json(res,200,r);}
    if(sub==='/fields'){const r=await api('fields');return json(res,200,r);}
    if(sub==='/following'){const r=await api('following',undefined,req.signal??undefined);return json(res,200,r);}
    return json(res,404,{ok:false,message:'未知端点：GET '+sub});
   }catch(error){return json(res,error.requestInvalid?400:500,{ok:false,message:String(error?.message??error).slice(0,300)});}
  }
 });
 return dispose;
}

/** Connection RPC 通道：应用内「B站面板」设置标签的数据与受控写入口。 */
export function registerConsoleRpc(connection,controller){
 return connection.rpc.handle('/ai-friend-bili-console',async (endpoint,payload,signal)=>{
  if(!['state','fields','following','config'].includes(endpoint)){const error=new Error('未知端点：'+endpoint);error.requestInvalid=true;throw error;}
  return createConsoleApi(controller)(endpoint,payload,signal);
 });
}

