import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';

export function mediaUrl(value){const u=new URL(value);if(u.protocol!=='https:'||u.port||u.username||u.password||!['bilivideo.com','bilivideo.cn'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))throw new Error('视频媒体来源不受支持');return u.href;}
const failure=(code,message)=>Object.assign(new Error(message),{code});
/** A per-session loopback relay. FFmpeg gets no signed CDN URL or account cookie. */
export async function openRangeRelay(input,{fetchImpl=fetch,signal,maxBytes=64*1024*1024,maxRequests=96}={}){
 const source=mediaUrl(input),stop=new AbortController(),stats={mode:'http_range',bytesRead:0,requests:0,maxBytes,maxRequests,totalBytes:null,lastFailure:null};
 const controllers=new Set();let closed=false,server;
 function account(n){if(stats.bytesRead+n>maxBytes)throw failure('MEDIA_READ_BUDGET','视频片段累计读取已达到预算');stats.bytesRead+=n;}
 async function request(range,localSignal){
  if(++stats.requests>maxRequests)throw failure('MEDIA_REQUEST_BUDGET','视频分段请求次数已达到预算');
  let url=source;
  const operation=AbortSignal.any([stop.signal,...signal?[signal]:[],...localSignal?[localSignal]:[],AbortSignal.timeout(20000)]);
  for(let redirect=0;redirect<4;redirect++){
   let response;try{response=await fetchImpl(url,{headers:{range,referer:'https://www.bilibili.com/','user-agent':'Mozilla/5.0','accept-encoding':'identity'},redirect:'manual',signal:operation});}catch{throw failure('MEDIA_RANGE_UNAVAILABLE','视频分段请求未完成');}
   if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();if(redirect===3)throw failure('MEDIA_REDIRECT_LIMIT','视频分段重定向过多');url=mediaUrl(new URL(response.headers.get('location'),url).href);continue;}
   if(response.status!==206){await response.body?.cancel();throw failure('MEDIA_RANGE_UNSUPPORTED','媒体源未提供有效分段响应（HTTP '+response.status+'）');}
   if(response.headers.has('content-encoding')&&response.headers.get('content-encoding')!=='identity'){await response.body?.cancel();throw failure('MEDIA_RANGE_INVALID','视频分段编码不能核实');}
   const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??''),wanted=/^bytes=(\d+)-(\d+)$/.exec(range);
   if(!match||!wanted||!match.slice(1).every(s=>Number.isSafeInteger(Number(s)))||Number(match[1])!==Number(wanted[1])||Number(match[2])!==Number(wanted[2])||Number(match[3])<=Number(match[2])||(stats.totalBytes!==null&&Number(match[3])!==stats.totalBytes)){await response.body?.cancel();throw failure('MEDIA_RANGE_INVALID','视频分段位置或总长度不能核实');}
   const length=Number(match[2])-Number(match[1])+1;if(length<1||!response.body||Number(response.headers.get('content-length')??length)!==length){await response.body?.cancel();throw failure('MEDIA_RANGE_INVALID','视频分段长度不能核实');}
   return {response,length,total:Number(match[3])};
  }throw failure('MEDIA_RANGE_UNAVAILABLE','视频分段请求未完成');
 }
 // The source is larger than the full-download cap; probe only its MP4 header.
 const probe=await request('bytes=0-4095'),parts=[];let probeBytes=0;
 for await(const part of probe.response.body){account(part.length);probeBytes+=part.length;if(probeBytes>4096)throw failure('MEDIA_RANGE_INVALID','视频头部超出读取范围');parts.push(part);}
 if(probeBytes!==4096||!Buffer.concat(parts).subarray(4,8).equals(Buffer.from('ftyp')))throw failure('MEDIA_RANGE_INVALID','媒体不是受支持的MP4文件');stats.totalBytes=probe.total;
 async function serve(req,res){
  if(closed||req.url!==route||!['GET','HEAD'].includes(req.method)){res.writeHead(404);res.end();return;}
  if(req.method==='HEAD'){res.writeHead(200,{'content-length':stats.totalBytes,'content-type':'video/mp4','accept-ranges':'bytes'});res.end();return;}
  const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'bytes=0-');if(!match||!Number.isSafeInteger(Number(match[1]))||match[2]&&!Number.isSafeInteger(Number(match[2]))){res.writeHead(416);res.end();return;}
  const start=Number(match[1]),end=Math.min(match[2]?Number(match[2]):stats.totalBytes-1,stats.totalBytes-1,start+maxBytes-stats.bytesRead-1);
  if(start>end||start<0){if(stats.bytesRead>=maxBytes)stats.lastFailure={code:'MEDIA_READ_BUDGET',message:'视频片段累计读取已达到预算'};res.writeHead(416,{'content-range':'bytes */'+stats.totalBytes});res.end();return;}
  if(controllers.size>=4){res.writeHead(429);res.end();return;}
  const local=new AbortController();controllers.add(local);const onClose=()=>local.abort();res.once('close',onClose);
  try{const {response,length}=await request(`bytes=${start}-${end}`,local.signal);if(res.destroyed){await response.body.cancel();return;}res.writeHead(206,{'content-type':'video/mp4','content-length':length,'content-range':`bytes ${start}-${end}/${stats.totalBytes}`,'accept-ranges':'bytes','cache-control':'no-store'});
   let transferred=0;for await(const part of response.body){if(local.signal.aborted)break;account(part.length);transferred+=part.length;if(transferred>length)throw failure('MEDIA_RANGE_INVALID','视频分段正文超出范围');if(!res.write(part))await once(res,'drain',{signal:local.signal});}if(!local.signal.aborted){if(transferred!==length)throw failure('MEDIA_RANGE_INVALID','视频分段传输未完整');res.end();}
  }catch(error){if(!local.signal.aborted&&!stop.signal.aborted&&!signal?.aborted){stats.lastFailure={code:error.code??'MEDIA_RANGE_UNAVAILABLE',message:error.code?error.message:'视频分段传输未完成'};}if(!res.headersSent&&!res.destroyed)res.writeHead(502);res.destroy();}
  finally{res.removeListener('close',onClose);local.abort();controllers.delete(local);}
 }
 const route='/'+randomBytes(24).toString('hex')+'/video.mp4';
 server=http.createServer((req,res)=>{void serve(req,res).catch(()=>res.destroy());});server.on('clientError',(_error,socket)=>socket.destroy());
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});server.unref();
 const close=async()=>{if(closed)return;closed=true;signal?.removeEventListener('abort',abort);stop.abort();for(const controller of controllers)controller.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
 const abort=()=>{void close();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){await close();signal.throwIfAborted();}
 return {url:'http://127.0.0.1:'+server.address().port+route,stats,close};
}
