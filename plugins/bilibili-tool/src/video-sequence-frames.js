import fs from 'node:fs/promises';import path from 'node:path';import {hash} from './util.js';

/** Decode the requested interval once. select/showinfo retain decoded PTS;
 * unlike an fps filter this does not generate synthetic evidence timestamps. */
export async function captureSequenceFrames({run,ffmpeg,file,inputFlags,range,maxFrames,temp,signal,transport}){
 if(!Number.isSafeInteger(maxFrames)||maxFrames<2||maxFrames>24)throw Error('连续画面采样数量无效');
 const span=range.endSeconds-range.startSeconds,step=Math.max(0.04,span/maxFrames),prefix='sequence-'+Math.round(range.startSeconds*1000)+'-',pattern=path.join(temp,prefix+'%03d.jpg');
 const select="select='lt(t,"+(range.endSeconds-0.000001)+")*gte(t-"+range.startSeconds+",selected_n*"+step+")',scale=w=min(768\\,iw):h=-2,showinfo";
 const log=await run(ffmpeg,['-hide_banner','-nostdin',...inputFlags,'-copyts','-ss',String(range.startSeconds),'-t',String(span),'-i',file,'-an','-frames:v',String(maxFrames),'-vf',select,'-fps_mode','vfr','-q:v','4','-y',pattern],{signal,timeoutMs:45000,maxOutput:262144});
 const times=[...log.matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)].map(m=>Number(m[1])),files=(await fs.readdir(temp)).filter(n=>n.startsWith(prefix)&&/^\d{3}\.jpg$/.test(n.slice(prefix.length))).sort();
 if(!files.length||files.length>maxFrames||times.length!==files.length)throw Error('连续画面与实际时间数量无法核实');
 const out=[];for(let i=0;i<files.length;i++){signal?.throwIfAborted();const seconds=times[i];if(!Number.isFinite(seconds)||seconds<range.startSeconds-0.1||seconds>range.endSeconds+0.1||i&&seconds<=times[i-1])throw Error('连续画面时间越界或非递增');const data=await fs.readFile(path.join(temp,files[i]));if(data.length<4||data.length>750000||data[0]!==0xff||data[1]!==0xd8)throw Error('连续画面原件无效');out.push({id:'frame-'+i,seconds,requestedSeconds:seconds,selection:'uniform decoded sequence; gaps remain unobserved',sha256:hash(data),data,mediaType:'image/jpeg',transport:transport()});}return out;
}
