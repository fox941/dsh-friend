import {normalizeComments,mergeQzonePost} from './qzone-comments.js';
import {parseFeeds3CommentsScoped} from '../vendor/qzone/qzone/feeds3Parser.js';
import {parseFeeds3Items} from '../vendor/qzone/qzone/feeds3Parser.js';
import {qqId} from './qq-config.js';
const MAX_BYTES=2*1024*1024;
const validTid=value=>typeof value==='string'&&/^[-\w]{1,128}$/.test(value);
// Decode string data only; never execute the feed's callback or JavaScript.
export function decodeFeedString(value){
 return value.replace(/\\(?:x([\da-f]{2})|u([\da-f]{4})|([\s\S]))/gi,(_m,x,u,c)=>x||u?String.fromCharCode(parseInt(x??u,16)):({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'}[c]??c));
}
const attr=(tag,name)=>tag.match(new RegExp('\\b'+name+'=["\x27]([^"\x27]*)["\x27]','i'))?.[1]??null;
function normalize(item,html,decoded){
 const feeds=[...html.matchAll(/<[^>]*\bname=["']feed_data["'][^>]*>/gi)].map(m=>m[0]);
 const single=decoded&&feeds.length===1&&attr(feeds[0],'data-uin')===String(item.uin);
 // A permission marker is trusted only inside one independently scoped post.
 const rights=single?[...new Set([...html.matchAll(/\bdata-accessright=["'](\d+)["']/gi)].map(m=>Number(m[1])))]:[];
 const right=rights.length===1&&[1,4,16,64,128].includes(rights[0])?rights[0]:null;
 const contentAvailable=Boolean(single&&/class=["'][^"']*\b(?:f-info|txt-box(?:-title)?)\b/i.test(html));
 const imageCountAvailable=Boolean(single&&Array.isArray(item.pic));
 const comments=single?normalizeComments(parseFeeds3CommentsScoped(html).get(item.tid)??[]):[],commentsAvailable=Boolean(single&&(/class=["'][^"']*\b(?:mod-comments|comments-box|comments-list)\b/.test(html)||comments.length));
 return {comments,uin:String(item.uin),tid:item.tid,content:String(item.content??'').slice(0,6000),createdTime:Number.isSafeInteger(item.created_time)?item.created_time:null,pic:imageCountAvailable?item.pic.map(()=>({})):null,ugc_right:right,readback:{commentsAvailable,commentsAmbiguous:false,commentsComplete:false,commentsLimit:50,source:single?'feeds3_html':'feeds3_metadata',contentAvailable,imageCountAvailable,visibilityAvailable:right!==null,visibilitySource:right===null?null:'data-accessright'}};
}
export function parseQzonePage(body,uin){
 qqId(uin);if(typeof body!=='string'||Buffer.byteLength(body)>MAX_BYTES)throw Error('空间页面超出本次范围');
 const fragments=[...body.matchAll(/(?:\bhtml|["']html["'])\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)];
 if(fragments.length>100)throw Error('空间页面片段过多');
 const pages=fragments.length?fragments.map(m=>decodeFeedString(m[1]??m[2])):[body],items=new Map();
 for(const html of pages){const decoded=fragments.length>0||html.trimStart().startsWith('<');for(const item of parseFeeds3Items(html,uin,'311',20)){
  if(String(item.uin)!==uin||!validTid(item.tid))continue;
  const value=normalize(item,html,decoded),old=items.get(value.tid),score=v=>Number(v.readback.contentAvailable)+Number(v.readback.imageCountAvailable)+Number(v.readback.visibilityAvailable);
  items.set(value.tid,mergeQzonePost(old,value));
 }}
 return [...items.values()].sort((a,b)=>(b.createdTime??0)-(a.createdTime??0)).slice(0,20);
}
async function bodyText(response,signal){
 if(!response.ok)throw Error('空间页面暂不可读取，HTTP '+response.status);
 const decoder=new TextDecoder();let bytes=0,text='';
 for await(const chunk of response.body){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>MAX_BYTES)throw Error('空间页面超出本次范围');text+=decoder.decode(chunk,{stream:true});}
 return text+decoder.decode();
}
export async function qzoneList(client,session,uin){
 qqId(uin);const pages=[],items=new Map();
 for(const scope of [1,0]){
  session.signal?.throwIfAborted();const query=new URLSearchParams({uin:scope===1?uin:session.account,scope:String(scope),view:'1',flag:'1',filter:'all',applist:'all',refresh:'1',aisortEndTime:'0',aisortOffset:'0',getAisort:'0',aisortBeginTime:'0',pagenum:'1',firstGetGroup:'0',icServerTime:'0',mixnocache:'0',scene:'0',begintime:'',dayspac:'5',sidomain:'qzonestyle.gtimg.cn',useutf8:'1',outputhtmlfeed:'1',g_tk:String(session.gtk),format:'json',count:'20',...scope===0?{uinlist:uin}:{}});
  const response=await client.request('https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?'+query,{headers:session.headers,redirect:'error',signal:session.signal});
  const parsed=parseQzonePage(await bodyText(response,session.signal),uin);pages.push(scope);
  for(const item of parsed){const old=items.get(item.tid),score=v=>Number(v.readback.contentAvailable)+Number(v.readback.imageCountAvailable)+Number(v.readback.visibilityAvailable);items.set(item.tid,mergeQzonePost(old,item));}
 }
 const result=[...items.values()].sort((a,b)=>(b.createdTime??0)-(a.createdTime??0)).slice(0,20);
 return {items:result,source:'feeds3',pages,complete:false,...!result.length?{notice:'本次页面未取得可核验说说，不代表空间为空或旧内容不存在'}:{}};
}
export async function qzoneGet(client,session,uin,tid,_options,responseJson){
 qqId(uin);if(!validTid(tid))throw Error('平台资源ID无效');
 const recent=await qzoneList(client,session,uin),found=recent.items.find(v=>v.tid===tid);
 if(found?.readback.source==='feeds3_html')return found;
 // Legacy detail is bounded and cooled down after failure; a partial feed is not
 // upgraded into a verified body or inferred visibility.
 if((client.zoneDetailCooldownUntil??0)>Date.now()){if(found)return found;throw Error('空间详情接口暂不可用，当前页面也未定位到目标说说');}
 try{const url=new URL('https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_getdetailv6');for(const[k,v]of Object.entries({g_tk:session.gtk,uin,hostuin:session.account,tid,format:'json'}))url.searchParams.set(k,String(v));
  const value=await responseJson(await client.request(url,{headers:session.headers,redirect:'error',signal:session.signal}));if(Number(value.code)!==0)throw Error('空间原件暂时不可读取');const result=value.data??value;
  if(result.uin!==undefined&&String(result.uin)!==uin||result.tid!==undefined&&String(result.tid)!==tid)throw Error('空间详情原件身份不匹配');return result;
 }catch(error){session.signal?.throwIfAborted();client.zoneDetailCooldownUntil=Date.now()+300000;if(found)return found;throw error;}
}
