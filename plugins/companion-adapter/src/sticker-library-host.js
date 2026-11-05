import {StickerLibraryView} from '@ai-friend/qq-bridge/sticker-management';
import {viewText} from './view-text.js';
const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
const fail=(status,message)=>Response.json({error:message},{status,headers});
// The pinned DSH HTTP bridge uses dsh.internal as a synthetic Fetch origin.
// Its admission step authenticates the cookie and checks the real Host/Origin.
// Match that real authority here; never trust forwarded headers or waive Origin.
function sameOrigin(request){try{const u=new URL(request.url),raw=request.headers.get('origin');if(!raw)return false;const o=new URL(raw);if(!['http:','https:'].includes(o.protocol)||o.origin!==raw)return false;return u.hostname==='dsh.internal'?o.host===request.headers.get('host'):o.origin===u.origin;}catch{return false;}}
function params(request,allowed){const u=new URL(request.url),keys=[...u.searchParams.keys()];if(request.url.length>1024||keys.some(k=>!allowed.includes(k))||new Set(keys).size!==keys.length)throw Object.assign(Error('参数无效'),{status:400});return u.searchParams;}
function integer(value,fallback){if(value===null)return fallback;if(!/^\d{1,6}$/.test(value))throw Object.assign(Error('分页参数无效'),{status:400});return Number(value);}
async function command(request){const mime=request.headers.get('content-type')?.split(';')[0].trim();if(mime!=='application/json')throw Object.assign(Error('需要JSON请求'),{status:415});const reader=request.body?.getReader();if(!reader)throw Object.assign(Error('请求为空'),{status:400});const chunks=[];let length=0;try{while(true){const r=await reader.read();if(r.done)break;length+=r.value.length;if(length>2048){await reader.cancel();throw Object.assign(Error('请求过大'),{status:413});}chunks.push(r.value);}}finally{reader.releaseLock();}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(Error('JSON无效'),{status:400});}const allowed=['stickerId','enabled','expectedRevision','requestId'];if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(value,k)))throw Object.assign(Error('操作参数无效'),{status:400});return value;}
export function stickerLibraryResponse(view,kind='list'){return async request=>{
 const method=kind==='control'?'POST':'GET';if(request.method!==method)return new Response(null,{status:405,headers:{...headers,allow:method}});
 try{request.signal.throwIfAborted();
  if(kind==='control'){
   params(request,[]);if(!sameOrigin(request))return fail(403,'管理操作需要同源页面请求');const value=await command(request);request.signal.throwIfAborted();return Response.json(view.set(value),{headers});
  }
  if(kind==='image'){const p=params(request,['id']),asset=await view.image(p.get('id'),request.signal);return new Response(asset.bytes,{headers:{...headers,'content-type':asset.row.mediaType,'content-disposition':'inline; filename="qq-sticker.'+({['image/gif']:'gif',['image/png']:'png',['image/jpeg']:'jpg',['image/webp']:'webp'}[asset.row.mediaType])+'"'}});}
  const p=params(request,['query','filter','offset','limit']);return Response.json(view.snapshot({query:p.get('query')??'',filter:p.get('filter')??'all',offset:integer(p.get('offset'),0),limit:integer(p.get('limit'),24)}),{headers});
 }catch(error){request.signal.throwIfAborted();const status=[400,403,404,409,413,415].includes(error.status)?error.status:503;return fail(status,({400:'参数无效，请刷新后重试',403:'当前没有管理权限',404:'表情不存在或暂不可查看',409:'状态已变化或来源不可用，请刷新后查看',413:'请求超出大小范围',415:'需要JSON请求'})[status]??'表情库暂不可用，原图与历史保留');}
};}
export function attachStickerLibraryHost(ctx,adapter){const view=new StickerLibraryView(adapter.platforms.stickers,{text:viewText,writeEnabled:()=>adapter.writeEnabled===true});ctx.inject(['connection'],bound=>{const connection=bound.get?.('connection')??bound.connection;for(const [path,kind,methods]of [['/api/ai-friend-stickers','list',['GET']],['/api/ai-friend-sticker-image','image',['GET']],['/api/ai-friend-sticker-control','control',['POST']]])bound.effect(()=>connection.fetch.register({path,methods,requestBody:kind==='control'?'streaming':'buffered',fetch:stickerLibraryResponse(view,kind)}),'ai-friend: owner sticker library '+kind);});}
