import {text,noSecret} from './util.js';
const bv=/^BV[0-9A-Za-z]{10}$/;
export function creatorUid(value){if(typeof value!=='string'||!/^\d{1,16}$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)throw Error('需要精确的B站UID字符串，不按昵称猜账号');return String(Number(value));}
function cursor(value,limit=256){if(value===undefined)return undefined;if(typeof value!=='string'||!value.length||value.length>limit||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('发现游标无效，请使用同一账号与目录的原样next_cursor');return value;}
export function discoveryRequest(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('需要明确的发现来源');
 const source=input.source;if(!['search','creator','favorites','home','following'].includes(source))throw Error('不支持该发现来源');
 const result={source};if(input.cursor!==undefined)result.cursor=cursor(input.cursor,['home','following'].includes(source)?4096:256);
 if(['home','following'].includes(source)&&['mid','query','section','containerId','selection','ownerBound'].some(k=>input[k]!==undefined))throw Error('首页推荐与关注动态仅属于AI当前登录账号，不接受其他UID或目录参数');
 if(source==='search'){if(result.cursor||input.mid!==undefined||input.section!==undefined||input.containerId!==undefined)throw Error('UP主搜索只接受关键词');result.query=text(input.query,'UP主搜索词',80);}
 if(source==='creator'){
  result.mid=creatorUid(input.mid);result.section=input.section??'videos';if(!['overview','videos','collections','series','dynamics'].includes(result.section))throw Error('不支持该UP主目录');
  if(input.containerId!==undefined){if(!['collections','series'].includes(result.section))throw Error('只有合集或系列允许containerId');result.containerId=creatorUid(input.containerId);}
  if(input.selection!==undefined){if(!['latest','choose'].includes(input.selection)||result.section!=='videos'||result.cursor)throw Error('观看选片仅支持投稿首页');result.selection=input.selection;}
  if(input.ownerBound!==undefined){if(input.ownerBound!==true)throw Error('主用户绑定标记无效');result.ownerBound=true;}
 }
 if(source==='favorites'&&(input.mid!==undefined||input.section!==undefined||input.containerId!==undefined||input.ownerBound!==undefined))throw Error('收藏来源仅为AI当前登录账号，不能指定用户收藏');
 noSecret(JSON.stringify(result));return result;
}
function bounded(value,depth=0){
 if(depth>7)return null;if(typeof value==='string')return value.slice(0,1000);if(Array.isArray(value))return value.slice(0,20).map(v=>bounded(v,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,40).map(([k,v])=>[k,bounded(v,depth+1)]));return value;
}
export async function discoverPage(rpc,input,{accountUid,now=()=>new Date()}={}){
 const request=discoveryRequest(input);let data;
 if(['home','following'].includes(request.source))data=await rpc.call('get_bilibili_feed',{source:request.source,...request.cursor?{cursor:request.cursor}:{}});
 else if(request.source==='search')data=await rpc.call('search_bilibili_creators',{query:request.query});
 else if(request.source==='creator')data=await rpc.call('get_bilibili_creator_content',{mid:Number(request.mid),section:request.section,...request.cursor?{cursor:request.cursor}:{},...request.containerId?{container_id:Number(request.containerId)}:{}});
 else data=await rpc.call('list_bilibili_favorite_videos',request.cursor?{cursor:request.cursor}:{});
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('B站发现结果格式异常');
 if(request.source==='creator'&&(String(data.mid)!==request.mid||data.section!==request.section))throw Error('B站目录返回的UID或类型与请求不一致');
 if(['home','following'].includes(request.source)&&(!data.accountUid||data.source!==request.source||accountUid&&data.accountUid!==accountUid))throw Error('信息流返回的账号或来源与请求不一致');
 const value={status:'discovered',retrievedAt:now().toISOString(),source:request,accountUid:data.accountUid??accountUid??null,attribution:request.source==='home'?'AI账号的平台首页推荐，不是主用户推荐，也不代表角色喜欢':request.source==='following'?'AI账号的动态页，可能混入平台推荐；转发者不等于视频作者，不代表主用户关注':request.source==='favorites'?'AI当前登录账号的收藏，不是主用户的收藏':request.source==='creator'?'指定UID的空间目录，可能包含联合投稿、转发及引用；不能据此认定唯一作者':'昵称可能重名，必须用候选UID确认身份',scope:'仅取得一页元数据，未观看视频或理解画面；不代表完整、实时或独占作者归属；没有写入经历、兴趣或情绪',data:bounded(data)};
 if(data.next_cursor!==undefined)value.data.next_cursor=cursor(data.next_cursor,['home','following'].includes(request.source)?4096:256);
 if(JSON.stringify(value).length>48000)throw Error('B站目录结果超出单页预算，请缩小读取范围');noSecret(JSON.stringify(value));return value;
}
export function discoveredVideos(page){const seen=new Set();return (page.data.videos??[]).filter(row=>row&&bv.test(row.bvid)&&!seen.has(row.bvid)&&seen.add(row.bvid));}
export function latestVideo(page){
 if(page.source.source!=='creator'||page.source.section!=='videos'||page.source.cursor)throw Error('最新投稿只能从指定UID的投稿首页确定');
 const videos=discoveredVideos(page);if(!videos.length)return null;
 if(videos.some(row=>typeof row.published_at!=='string'||!Number.isFinite(Date.parse(row.published_at))))throw Error('投稿时间不完整，无法确定本页最新视频');
 return [...videos].sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at))[0];
}
