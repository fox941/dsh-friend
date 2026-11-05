import {hash} from './util.js';

const finite=n=>typeof n==='number'&&Number.isFinite(n);
export function mergeRanges(ranges,duration){
 const sorted=ranges.map(([a,b])=>[Math.max(0,a),Math.min(duration,b)]).filter(([a,b])=>finite(a)&&finite(b)&&b>a).sort((a,b)=>a[0]-b[0]),out=[];
 for(const r of sorted){const last=out.at(-1);if(last&&r[0]<=last[1]+0.001)last[1]=Math.max(last[1],r[1]);else out.push([...r]);}return out;
}
export function missingRanges(ranges,duration){const gaps=[];let end=0;for(const [a,b]of mergeRanges(ranges,duration)){if(a>end+0.001)gaps.push([end,a]);end=b;}if(end<duration-0.001)gaps.push([end,duration]);return gaps;}
export function videoCoverage(info,segments){
 if(!finite(info.durationSeconds)||info.durationSeconds<=0)throw Error('视频时长无效');
 for(const s of segments)if(s.bvid!==info.bvid||s.page!==info.page||String(s.cid)!==String(info.cid)||!finite(s.startSeconds)||!finite(s.endSeconds)||s.startSeconds<0||s.endSeconds>info.durationSeconds+0.001||s.endSeconds<=s.startSeconds)throw Error('连续观察来源或区间不一致');
 const ranges=mergeRanges(segments.filter(s=>s.language?.text||s.frames?.length).map(s=>[s.startSeconds,s.endSeconds]),info.durationSeconds),gaps=missingRanges(ranges,info.durationSeconds),text=mergeRanges(segments.filter(s=>s.language?.text&&!s.language.truncated).map(s=>[s.startSeconds,s.endSeconds]),info.durationSeconds),visual=mergeRanges(segments.filter(s=>s.frames?.length).map(s=>[s.startSeconds,s.endSeconds]),info.durationSeconds),points=[...new Set(segments.flatMap(s=>s.frames??[]).map(f=>f.seconds).filter(finite))].sort((a,b)=>a-b);
 const visualGaps=missingRanges(visual,info.durationSeconds),languageGaps=missingRanges(text,info.durationSeconds),temporalGaps=segments.filter(s=>s.frames?.length&&!s.sequence).map(s=>[s.startSeconds,s.endSeconds]);
 return {protocol:'ai-friend/video-coverage/1',durationSeconds:info.durationSeconds,processedRanges:ranges,unprocessedRanges:gaps,continuousUntilSeconds:ranges[0]?.[0]===0?ranges[0][1]:0,processedSeconds:ranges.reduce((n,[a,b])=>n+b-a,0),rangeCoverageComplete:gaps.length===0,languageRanges:text,languageGaps,visualSampleRanges:visual,visualGaps,frameCount:segments.reduce((n,s)=>n+(s.frames?.length??0),0),uniqueFrameCount:new Set(segments.flatMap(s=>s.frames??[]).map(f=>f.sha256)).size,maxVisualSampleGapSeconds:points.length?Math.max(points[0],info.durationSeconds-points.at(-1),...points.slice(1).map((v,i)=>v-points[i])):null,hasSourceGaps:languageGaps.length>0||visualGaps.length>0,temporalGaps,hasInterpretationGaps:temporalGaps.length>0,exhaustiveFrameUnderstanding:false,nativeAudioUnderstanding:false,scope:'覆盖仅表示相应区间取得了实际文字或抽样画面；不是逐帧理解，也未直接理解声音语气与配乐。缺口、截断和采样间隔单独保留。'};
}

export function languageExcerpts(text){return [...text.matchAll(/[\s\S]{1,240}/gu)].map((m,i)=>({id:'language-'+i,text:m[0]}));}
export function sequenceDescription(value,meta,language,range,describeFrames){
 if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['frames','sequence'].includes(k)))throw Error('时序画面输出字段无效');
 const frames=describeFrames({frames:value.frames},meta),s=value.sequence;
 if(!s||typeof s!=='object'||Object.keys(s).some(k=>!['summary','events','unresolved'].includes(k))||typeof s.summary!=='string'||!s.summary.trim()||s.summary.length>1000||!Array.isArray(s.events)||s.events.length>8||!Array.isArray(s.unresolved)||s.unresolved.length>4||s.unresolved.some(v=>typeof v!=='string'||!v.trim()||v.length>250))throw Error('片段时序理解格式无效');
 const ids=new Set(frames.map(f=>f.id)),passages=new Map(languageExcerpts(language.text).map(p=>[p.id,p.text]));
 const events=s.events.map(e=>{if(!e||Object.keys(e).some(k=>!['description','frameIds','languageIds'].includes(k))||typeof e.description!=='string'||!e.description.trim()||e.description.length>500||!Array.isArray(e.frameIds)||e.frameIds.length>meta.length||new Set(e.frameIds).size!==e.frameIds.length||e.frameIds.some(id=>!ids.has(id))||!Array.isArray(e.languageIds)||e.languageIds.length>4||new Set(e.languageIds).size!==e.languageIds.length||e.languageIds.some(id=>!passages.has(id))||!e.frameIds.length&&!e.languageIds.length)throw Error('时序事件缺少本段真实画面或语言依据');const times=e.frameIds.map(id=>frames.find(f=>f.id===id).seconds);return {...e,frameIds:[...e.frameIds],languageIds:[...e.languageIds],startSeconds:times.length?Math.min(...times):range.startSeconds,endSeconds:times.length?Math.max(...times):range.endSeconds,timeBasis:times.length?'referenced_sample_points':'language_window',languageQuotes:e.languageIds.map(id=>({id,text:passages.get(id),source:language.source}))};});
 return {frames,sequence:{summary:s.summary.trim(),events,unresolved:s.unresolved,evidenceKind:'derived_multimodal_interpretation',sampledOnly:true,nativeAudioUnderstanding:false,languageSource:language.source,languageHash:hash(language.text)}};
}
