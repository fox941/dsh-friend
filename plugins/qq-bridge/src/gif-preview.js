import fs from 'node:fs/promises';
import path from 'node:path';
import {hash} from './validation.js';

export const GIF_SAMPLING_VERSION='gif-temporal-v2';
const png=Buffer.from([137,80,78,71,13,10,26,10]);
export function gifDuration(log){const m=String(log).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);if(!m)return null;const n=Number(m[1])*3600+Number(m[2])*60+Number(m[3]);return n>0&&Number.isFinite(n)?n:null;}
export function gifFrameTimes(log){return [...String(log).matchAll(/\[Parsed_showinfo_[^\]]+\]\s+n:\s*(\d+)\s+pts:\s*[-\d]+\s+pts_time:([-+\d.e]+)/g)].map(m=>({index:Number(m[1]),timeSeconds:Number(m[2])}));}

/** Decode actual selected frames, not interpolated FPS frames. All GIF loops
 * are ignored. Time/size/frames are bounded; outputs are disposable PNGs. */
export async function sampleGif({bytes,input,root,ffmpeg,run,signal}){
 signal?.throwIfAborted();if(hash(await fs.readFile(input))!==hash(bytes))throw Error('GIF原件校验失败');
 const directory=await fs.mkdtemp(path.join(root,'gif-sample-'));
 const common=['-hide_banner','-nostdin','-loglevel','info','-protocol_whitelist','file,pipe','-ignore_loop','1','-i',input];
 const extract=async(select,count)=>{
  const filter="trim=duration=12,select='"+select+"',scale=512:512:force_original_aspect_ratio=decrease,showinfo";
  const log=await run(ffmpeg,[...common,'-an','-vf',filter,'-frames:v',String(count),'-fps_mode','vfr','-threads','1','-filter_threads','1','-y',path.join(directory,'frame-%02d.png')],{signal,timeoutMs:15000,maxOutput:65536});
  const times=gifFrameTimes(log).filter(t=>Number.isFinite(t.timeSeconds)&&t.timeSeconds>=0&&t.timeSeconds<12);
  if(!times.length||times.length>count||times.some((t,i)=>t.index!==i||i&&t.timeSeconds<=times[i-1].timeSeconds))throw Error('GIF采样时间未核对');
  const frames=[];for(let i=0;i<times.length;i++){const data=await fs.readFile(path.join(directory,'frame-'+String(i+1).padStart(2,'0')+'.png'));if(data.length>3*1024*1024||!data.subarray(0,8).equals(png))throw Error('GIF采样图异常');frames.push({data,mediaType:'image/png',timeSeconds:times[i].timeSeconds});}return frames;
 };
 try{
  let durationSeconds=null;try{const probe=await run(ffmpeg,[...common,'-an','-frames:v','1','-f','null','-'],{signal,timeoutMs:10000,maxOutput:65536});durationSeconds=gifDuration(probe);}catch{signal?.throwIfAborted();}
  const rangeSeconds=Math.min(durationSeconds??1,12),interval=Math.max(rangeSeconds/3,0.01);let frames,fallback=false;
  try{frames=await extract('isnan(prev_selected_t)+gte(t-prev_selected_t,'+interval.toFixed(6)+')',3);}catch{signal?.throwIfAborted();fallback=true;frames=await extract('eq(n,0)',1);}
  return {frames,coverage:{version:GIF_SAMPLING_VERSION,kind:frames.length>1?'sampled-frames':'first-frame-only',frameCount:frames.length,durationSeconds,maxScanSeconds:12,timestamps:frames.map(f=>f.timeSeconds),complete:false,...fallback?{notice:'多帧提取未完成，仅首帧可用'}:{}}};
 }finally{for(let n=1;n<=3;n++)await fs.unlink(path.join(directory,'frame-'+String(n).padStart(2,'0')+'.png')).catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.rmdir(directory);}
}
