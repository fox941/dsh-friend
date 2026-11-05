import {BilibiliInboxClient} from './bilibili-inbox-client.js';import {signWbi} from '../vendor/dsh-bili-whale/wbi.mjs';
const bv=/^BV[0-9A-Za-z]{10}$/,clean=(v,n=500)=>typeof v==='string'?v.slice(0,n):'',positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0;
/** Owned compatibility adapter: standard WBI from the already vendored MIT component.
 * Only creator videos/overview use it; no patching of the MCP package or unsigned retries. */
export class BilibiliCatalog extends BilibiliInboxClient{
 async content(args,signal){
  const mid=String(args.mid);if(!/^\d+$/.test(mid)||!positive(mid)||!['videos','overview'].includes(args.section))throw Error('投稿目录参数无效');
  let page=1;if(args.cursor!==undefined){let value;try{value=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));}catch{throw Error('投稿目录游标无效');}if(args.section!=='videos'||!Number.isSafeInteger(value.page)||value.version!==1||String(value.mid)!==mid||value.section!=='videos'||!positive(value.page)||value.page>10000||Object.keys(value).some(k=>!['version','mid','section','page'].includes(k)))throw Error('投稿目录游标不属于此UID或目录');page=value.page;}
  const api=await this.open(signal),signed=(endpoint,params)=>api.get('https://api.bilibili.com'+endpoint+'?'+signWbi(params,api.images,this.now()));
  if(args.section==='overview'){const data=await signed('/x/space/wbi/acc/info',{mid});if(String(data.mid)!==mid)throw Error('UP主资料UID不符');return {mid:Number(mid),section:'overview',name:clean(data.name,128),bio:clean(data.sign),avatar_url:clean(data.face),source_url:'https://space.bilibili.com/'+mid+'/',transport:'existing-wbi-client/1'};}
  const data=await signed('/x/space/wbi/arc/search',{mid,pn:page,ps:20,order:'pubdate',tid:0,keyword:''}),rows=data?.list?.vlist;
  if(!Array.isArray(rows)||rows.length>20)throw Error('投稿目录返回格式异常');const videos=[];
  for(const row of rows){if(!bv.test(row?.bvid)||!clean(row.title)||!positive(row.created??row.create))continue;const timestamp=Number(row.created??row.create)*1000;if(!Number.isFinite(timestamp)||timestamp>8640000000000000)continue;
   const duration=clean(row.length,30).split(':').map(Number);videos.push({bvid:row.bvid,title:clean(row.title),description:clean(row.description,1000),author:clean(row.author,128),...(positive(row.mid)?{author_mid:String(row.mid)}:{}),published_at:new Date(timestamp).toISOString(),duration_seconds:duration.every(Number.isFinite)?duration.reduce((sum,part)=>sum*60+part,0):0,source_url:'https://www.bilibili.com/video/'+row.bvid+'/',access:'unknown'});
  }
  const total=Number(data.page?.count),result={mid:Number(mid),section:'videos',page,videos,skipped_count:rows.length-videos.length,live_state:'live',transport:'existing-wbi-client/1'};if(Number.isSafeInteger(total)&&total>=0)result.videos_total=total;
  if(Number.isSafeInteger(total)?page*20<total:rows.length===20)result.next_cursor=Buffer.from(JSON.stringify({version:1,mid:Number(mid),section:'videos',page:page+1})).toString('base64url');return result;
 }
}
