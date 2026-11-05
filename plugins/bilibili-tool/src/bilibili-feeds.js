import {BilibiliInboxClient} from './bilibili-inbox-client.js';import {signWbi} from '../vendor/dsh-bili-whale/wbi.mjs';
const bv=/^BV[0-9A-Za-z]{10}$/,digits=/^[1-9]\d{0,23}$/,clean=(v,n=300)=>typeof v==='string'?v.slice(0,n):'',id=v=>typeof v==='string'&&digits.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):null;
const iso=v=>{const n=Number(v);return Number.isFinite(n)&&n>0&&n*1000<=8640000000000000?new Date(n*1000).toISOString():null;};
const truth=v=>v===true||v===1||v==='1',types=new Set(['home','following']),ttl=15*60000;
export function decodeFeedCursor(raw,source,account,now=Date.now()){
 if(raw===undefined)return {page:1,seenVideo:[],seenDynamic:[],expiresAt:now+ttl};
 let value;try{if(typeof raw!=='string'||raw.length>4096||!/^[A-Za-z0-9_-]+$/.test(raw))throw Error();value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{throw Error('B站信息流游标格式无效');}
 if(!value||value.v!==1||value.source!==source||value.account!==account||!Number.isInteger(value.page)||value.page<2||value.page>100||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+ttl||Object.keys(value).some(k=>!['v','source','account','page','expiresAt','offset','seenVideo','seenDynamic'].includes(k)))throw Error('信息流游标已过期或不属于当前AI账号与来源，请重新读取首页');
 for(const [key,max,pattern]of [['seenVideo',60,bv],['seenDynamic',30,digits]])if(!Array.isArray(value[key])||value[key].length>max||value[key].some(v=>typeof v!=='string'||!pattern.test(v)))throw Error('信息流去重游标无效');
 if(source==='following'&&(typeof value.offset!=='string'||!value.offset.length||value.offset.length>96||!/^[\x21-\x7e]+$/.test(value.offset))||source==='home'&&value.offset!==undefined)throw Error('信息流分页位置无效');return value;
}
function nextCursor(state,source,account,{offset,hasMore}){if(!hasMore||state.page>=100)return undefined;const value={v:1,source,account,page:state.page+1,expiresAt:state.expiresAt,...source==='following'?{offset}:{},seenVideo:[...new Set(state.seenVideo)].slice(-60),seenDynamic:[...new Set(state.seenDynamic)].slice(-30)},cursor=Buffer.from(JSON.stringify(value)).toString('base64url');if(cursor.length>4096)throw Error('信息流分页记录超出预算');return cursor;}
function video(row,source,extra={}){if(!bv.test(row?.bvid)||!clean(row.title))return null;const duration=row.duration==null?NaN:Number(row.duration);return {bvid:row.bvid,title:clean(row.title),description:clean(row.desc??row.description),description_truncated:typeof(row.desc??row.description)==='string'&&(row.desc??row.description).length>300,author:clean(row.owner?.name,128)||null,author_mid:id(row.owner?.mid),published_at:iso(row.pubdate),duration_seconds:Number.isFinite(duration)&&duration>=0?duration:null,source_url:'https://www.bilibili.com/video/'+row.bvid+'/',access:'unknown',discovery_source:source,...extra};}
function rows(input,label){if(!Array.isArray(input)||input.length>50)throw Error(label+'返回格式或单页大小异常');return input;}
export function normalizeFeed(data,source,account,state){
 if(!types.has(source))throw Error('不支持该B站信息流');const seenVideo=new Set(state.seenVideo),seenDynamic=new Set(state.seenDynamic),videos=[],dynamics=[],counts={raw:0,duplicates:0,skipped:0};
 const addVideo=row=>{if(!row){counts.skipped++;return;}if(seenVideo.has(row.bvid)){counts.duplicates++;return;}if(videos.length>=20){counts.skipped++;return;}seenVideo.add(row.bvid);videos.push(row);};
 let offset,hasMore=false;
 if(source==='home'){
  if(data?.mid!==undefined&&id(data.mid)!==account)throw Error('首页推荐返回的账号与实际AI账号不同');
  const items=rows(data?.item,'首页推荐');counts.raw=items.length;for(const row of items){if(row?.goto!=='av'||truth(row.is_ad)||row.business_info||row.ad_info){counts.skipped++;continue;}addVideo(video(row,source,{is_followed:row.is_followed===undefined?null:truth(row.is_followed)}));}hasMore=items.length>0;
 }else{
  const items=rows(data?.items,'关注动态');counts.raw=items.length;
  for(const row of items){const dynamicId=id(row?.id_str),author=row?.modules?.module_author,dyn=row?.modules?.module_dynamic;if(!dynamicId||!author||!dyn||/AD|LIVE/.test(String(row.type))){counts.skipped++;continue;}if(seenDynamic.has(dynamicId)){counts.duplicates++;continue;}if(dynamics.length>=20){counts.skipped++;continue;}seenDynamic.add(dynamicId);
   const references=[],archives=[{archive:dyn.major?.archive,repost:false},{archive:row.orig?.modules?.module_dynamic?.major?.archive,repost:true}];
   for(const {archive,repost}of archives){if(!archive)continue;const v=video(archive,source,{dynamic_id:dynamicId,dynamic_published_at:iso(author.pub_ts),dynamic_url:'https://t.bilibili.com/'+dynamicId,shared_by:{mid:id(author.mid),name:clean(author.name,128)},repost,author:null,author_mid:null,authorship:'动态发布者/转发者不等于视频作者，尚未核验上传者'});if(v)references.push(v.bvid);addVideo(v);}
   if(dynamics.length<20)dynamics.push({dynamic_id:dynamicId,kind:clean(row.type,80),author_mid:id(author.mid),author:clean(author.name,128),published_at:iso(author.pub_ts),text:clean(dyn.desc?.text,600),text_truncated:typeof dyn.desc?.text==='string'&&dyn.desc.text.length>600,image_count:Array.isArray(dyn.major?.draw?.items)?dyn.major.draw.items.length:Array.isArray(dyn.major?.opus?.pics)?dyn.major.opus.pics.length:null,is_repost:row.type==='DYNAMIC_TYPE_FORWARD'||Boolean(row.orig),referenced_bvids:[...new Set(references)],source_url:'https://t.bilibili.com/'+dynamicId,is_followed:author.following===undefined?null:truth(author.following)});
  }
  if(![true,false,0,1,'0','1'].includes(data.has_more))throw Error('关注动态分页标记无法核验');hasMore=truth(data.has_more);offset=data.offset;if(hasMore&&(typeof offset!=='string'||!offset.length||offset.length>96||offset===state.offset||!/^[\x21-\x7e]+$/.test(offset)))throw Error('关注动态分页未前进或位置无效');
 }
 const cursor=nextCursor({...state,seenVideo:[...seenVideo],seenDynamic:[...seenDynamic]},source,account,{offset,hasMore});
 return {accountUid:account,source,page:state.page,videos,dynamics,counts,...cursor?{next_cursor:cursor}:{},scope:source==='home'?'AI账号首页平台推荐，仅元数据与有界文本摘录，不代表她已看或喜欢；刷新结果不构成稳定的完整分页':'AI账号动态页，仅元数据与有界文本摘录，平台可能混入推荐；转发和引用不证明视频作者归属；图片只记录数量，未理解画面'};
}
/** Read-only native feed adapter, using the same login, WBI and traffic protection as existing Bili operations. */
export class BilibiliFeeds extends BilibiliInboxClient{
 async page(args,signal,{accountUid}={}){signal?.throwIfAborted();if(!types.has(args?.source)||Object.keys(args).some(k=>!['source','cursor'].includes(k)))throw Error('信息流只能读取当前AI账号的首页推荐或关注动态');const api=await this.open(signal);if(accountUid&&api.account!==accountUid)throw Error('读取前AI账号已变化，未使用其他账号的信息流');const state=decodeFeedCursor(args.cursor,args.source,api.account,this.now());let data;
  if(args.source==='home')data=await api.get('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?'+signWbi({ps:20,fresh_type:4,fresh_idx:state.page,fresh_idx_1h:state.page,brush:state.page,feed_version:'V8',homepage_ver:1,web_location:1430650},api.images,this.now()));
  else data=await api.get('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all',{type:'all',platform:'web',timezone_offset:-480,...state.offset?{offset:state.offset}:{}});
  signal?.throwIfAborted();return normalizeFeed(data,args.source,api.account,state);
 }
}
