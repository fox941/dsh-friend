import path from 'node:path';
import {readBiliCredentials,activityDirectory} from './activity-config.js';
import {createTrafficGuard,RISK_DEFAULTS} from '../vendor/dsh-bili-whale/traffic.mjs';
import {parseJsonExact} from '../vendor/dsh-bili-whale/json-exact.mjs';
import {signWbi} from '../vendor/dsh-bili-whale/wbi.mjs';
import {normalizeMessage} from '../vendor/dsh-bili-whale/message.mjs';
export const biliDigits=(value,label='B站ID')=>{const v=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;if(typeof v!=='string'||!/^\d{1,24}$/.test(v))throw new Error(label+'无效或精度不可靠');return v;};
const hasMore=v=>v===true||v===1||v==='1';
export class BilibiliInboxClient{
 constructor(instance,{transport,now=Date.now,sleep,guard}={}){Object.assign(this,{instance,now});this.guard=guard??createTrafficGuard({directory:path.join(activityDirectory(instance),'inbox-traffic'),transport,now,sleep,settings:()=>({...RISK_DEFAULTS,minGapMs:1500,readHourly:180,readDaily:2400})});}
 async open(signal){const c=await readBiliCredentials(this.instance);if(!c)throw new Error('B站账号尚未登录');const headers={'user-agent':'Mozilla/5.0','referer':'https://www.bilibili.com/',cookie:`SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; DedeUserID=${c.dedeuserid}`};
 const get=async(input,params={})=>{signal?.throwIfAborted();const url=new URL(input);if(!['api.bilibili.com','api.vc.bilibili.com'].includes(url.hostname)||url.protocol!=='https:')throw new Error('B站读取目标不受支持');for(const [k,v]of Object.entries(params))url.searchParams.set(k,String(v));const response=await this.guard.fetch(url,{headers,method:'GET',redirect:'error',signal});
 const length=Number(response.headers.get('content-length')??0);if(length>1048576)throw new Error('B站返回超过读取预算');let raw='';const decoder=new TextDecoder();for await(const chunk of response.body){raw+=decoder.decode(chunk,{stream:true});if(raw.length>1048576)throw new Error('B站返回超过读取预算');}raw+=decoder.decode();let body;try{body=parseJsonExact(raw);}catch{throw new Error('B站返回不是可核验JSON');}if(!response.ok||body.code!==0){const code=Number(body.code);throw Object.assign(new Error('B站事件读取失败，HTTP='+response.status+' code='+(Number.isFinite(code)?code:'unknown')),{apiCode:code});}return body.data;};
 const nav=await get('https://api.bilibili.com/x/web-interface/nav');if(!nav?.isLogin||biliDigits(nav.mid)!==c.dedeuserid)throw new Error('B站实际账号与本地绑定不同，未接收事件');
 return {account:c.dedeuserid,get,images:nav.wbi_img,headers};
 }
 async stream(api,kind,state,{maxPages=5,signal}={}){return kind==='private'?this.privateMessages(api,state,{maxPages,signal}):this.notifications(api,kind,state,{maxPages,signal});}
 async privateMessages(api,state,{maxPages,signal}){
  const started=this.now()/1000,sessions=[],seen=new Set();let cursor=null,ended=false;const floor=state?.since??started;
  for(let p=0;p<maxPages;p++){signal?.throwIfAborted();const data=await api.get('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions',{session_type:1,group_fold:1,unfollow_fold:1,sort_rule:2,...cursor?{end_ts:cursor}:{}});if(!Array.isArray(data?.session_list))throw new Error('私信会话列表缺失，保留进度');const rows=data.session_list;
   for(const row of rows){const id=biliDigits(row.talker_id);if(Number(row.session_type??1)!==1)continue;if(!seen.has(id)){seen.add(id);sessions.push(row);}}
   if(!state||!hasMore(data.has_more)||!rows.length||rows.some(row=>Number(row.session_ts)/1e6<floor)){ended=true;break;}
   const next=String(rows.at(-1).session_ts);if(!/^\d+$/.test(next)||next===cursor)throw new Error('私信会话分页未前进，保留进度');cursor=next;
  }
  if(!ended)throw new Error('私信会话积压超过分页预算，保留进度');if(!state)return {baseline:true,events:[],next:{since:started}};
  const events=[];for(const session of sessions){signal?.throwIfAborted();if(Number(session.session_ts)/1e6<floor)continue;const talker=biliDigits(session.talker_id);if(talker===api.account)continue;let cursor='0',complete=false;const all=[],keys=new Set();
   for(let page=0;page<maxPages;page++){const query=signWbi({talker_id:talker,session_type:1,size:30,begin_seqno:cursor},api.images,this.now()),data=await api.get('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?'+query);if(!Array.isArray(data?.messages))throw new Error('私信正文缺失，保留进度');const rows=data.messages.map(normalizeMessage);for(const row of rows)if(!keys.has(row.key)){keys.add(row.key);all.push(row);}
    if(!hasMore(data.has_more)||!rows.length||rows.some(row=>row.ts<floor)){complete=true;break;}const seqs=rows.filter(r=>r.seq).map(r=>BigInt(r.seq));if(!seqs.length)throw new Error('私信历史缺少分页序号');const next=seqs.reduce((a,b)=>a<b?a:b).toString();if(next===cursor||cursor!=='0'&&BigInt(next)>=BigInt(cursor))throw new Error('私信正文分页未前进');cursor=next;
   }if(!complete)throw new Error('私信正文积压超过分页预算，保留进度');const withdrawn=new Set(all.filter(x=>x.type===5).map(x=>x.withdrawn));
   for(const row of all.filter(x=>x.ts>=floor&&x.sender===talker&&!withdrawn.has(x.key)))events.push({key:'private:'+talker+':'+biliDigits(row.key),kind:'private',sender:talker,at:row.ts,text:row.type===1?row.text:'',supported:row.type===1,platformId:row.key,scope:{talkerId:talker,messageType:row.type,...row.type===5&&row.withdrawn?{withdrawn:biliDigits(row.withdrawn)}:{}}});
  }
  // Overlap one second, with durable event keys removing duplicates.
  return {events,next:{since:Math.max(floor,started-60)}};
 }
 async notifications(api,kind,state,{maxPages,signal}){
  if(!['at','reply'].includes(kind))throw new Error('未知B站通知类型');const started=this.now()/1000;let cursor=null,ended=false;const events=[],seen=new Set(),floor=state?.since??started;
  for(let p=0;p<maxPages;p++){signal?.throwIfAborted();const data=await api.get('https://api.bilibili.com/x/msgfeed/'+kind,{platform:'web',build:0,mobi_app:'web',...cursor?{id:cursor.id,[kind==='reply'?'reply_time':'at_time']:cursor.time}:{}});if(!Array.isArray(data?.items))throw new Error('B站通知列表缺失，保留进度');const rows=data.items;
   if(state)for(const row of rows){const at=Number(row.reply_time??row.at_time??0);if(!Number.isFinite(at)||!at)throw new Error('通知时间缺失，保留进度');const id=biliDigits(row.id);if(at<floor||seen.has(id))continue;seen.add(id);const item=row.item??{},sender=biliDigits(row.user?.mid),business=Number(item.business_id),oid=biliDigits(item.subject_id??'0'),rpid=biliDigits(item.source_id??'0'),root=biliDigits(item.root_id??rpid);let text='',verified=false;
    if([1,11,17].includes(business)&&oid!=='0'&&rpid!=='0'){const detail=await api.get('https://api.bilibili.com/x/v2/reply/reply',{type:business,oid,root:root==='0'?rpid:root,ps:20,pn:1});const found=[detail?.root,...detail?.replies??[]].find(x=>x&&biliDigits(x.rpid_str??x.rpid)===rpid&&biliDigits(x.mid)===sender);if(found&&typeof found.content?.message==='string'){text=found.content.message;verified=true;}}
    events.push({key:kind+':'+id,kind,sender,at,text,supported:verified,platformId:id,scope:{business,oid,rpid,root,verified,noticeText:String(item.source_content??'').slice(0,2000)}});
   }
   if(!state||!rows.length||data.cursor?.is_end===true||data.cursor?.is_end===1||rows.some(row=>Number(row.reply_time??row.at_time)<floor)){ended=true;break;}
   const next=data.cursor;if(!next||!next.id||!Number.isFinite(Number(next.time))||cursor&&String(next.id)===String(cursor.id)&&String(next.time)===String(cursor.time))throw new Error('通知分页未前进，保留进度');cursor={id:biliDigits(next.id),time:Number(next.time)};
  }
  if(!ended)throw new Error('通知积压超过分页预算，保留进度');return {baseline:!state,events,next:{since:state?Math.max(floor,started-60):started}};
 }
}
