import {videoCoverage,sequenceDescription,languageExcerpts} from './video-coverage.js';
import {hash,noSecret} from './util.js';
import {videoRange,frameDescriptions} from './video-media.js';
import {videoConfig,effectiveVideoConfig,batchVideoConfig} from './video-config.js';
export {videoConfig} from './video-config.js';

export function videoFailure(error,stage){
 const known={MEDIA_SOURCE_UNSUPPORTED:'平台未返回受支持的媒体地址，未扩大来源权限',MEDIA_DOWNLOAD_LIMIT:'完整视频超过本地下载预算',MEDIA_READ_BUDGET:'片段累计读取已达到预算',MEDIA_REQUEST_BUDGET:'片段请求次数已达到预算',MEDIA_RANGE_UNSUPPORTED:'媒体源不支持所需的分段读取',MEDIA_RANGE_INVALID:'媒体分段位置、格式或长度无法核实',MEDIA_RANGE_UNAVAILABLE:'媒体分段传输未完成',MEDIA_REDIRECT_LIMIT:'媒体分段重定向过多'};
 let code=Object.hasOwn(known,error?.code)?error.code:null;if(code)return {stage:'media',code,message:known[code]};
 if(stage==='attachment')return {stage,code:/额度/.test(error?.message??'')?'IMAGE_EVIDENCE_BUDGET':'IMAGE_STORAGE_UNAVAILABLE',message:/额度/.test(error?.message??'')?'图片证据额度不足，未新增画面':'图片附件保存未完成'};
 if(stage==='vision')return {stage,code:'VISION_MODEL_UNAVAILABLE',message:'图片理解请求或返回内容未通过核验'};
 return {stage:'frames',code:'FRAME_CAPTURE_FAILED',message:'画面采样或解码未完成'};
}

export class VideoStore{
 constructor(journal){this.db=journal.db;this.db.exec(`CREATE TABLE IF NOT EXISTS activity_video_sessions(run_id TEXT PRIMARY KEY,state_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS activity_video_frames(sha256 TEXT PRIMARY KEY,bytes INTEGER NOT NULL,attachment_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS activity_video_segments(run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,bvid TEXT NOT NULL,page INTEGER NOT NULL,start_seconds REAL NOT NULL,end_seconds REAL NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,ordinal));`);}
 state(id){const row=this.db.prepare('SELECT state_json FROM activity_video_sessions WHERE run_id=?').get(id);return row?JSON.parse(row.state_json):{plans:[],complete:false};}
 save(id,state){noSecret(JSON.stringify(state));this.db.prepare('INSERT INTO activity_video_sessions VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET state_json=excluded.state_json').run(id,JSON.stringify(state));}
 segments(id){return this.db.prepare('SELECT payload_json FROM activity_video_segments WHERE run_id=? ORDER BY ordinal').all(id).map(r=>JSON.parse(r.payload_json));}
 segment(id,ordinal,payload){noSecret(JSON.stringify(payload));this.db.prepare('INSERT INTO activity_video_segments VALUES(?,?,?,?,?,?,?)').run(id,ordinal,payload.bvid,payload.page,payload.startSeconds,payload.endSeconds,JSON.stringify(payload));}
 frame(sha){const row=this.db.prepare('SELECT * FROM activity_video_frames WHERE sha256=?').get(sha);return row?{...row,attachment:JSON.parse(row.attachment_json)}:null;}
 frameBytes(){return this.db.prepare('SELECT COALESCE(sum(bytes),0) n FROM activity_video_frames').get().n;}
 saveFrame(sha,ref){this.db.prepare('INSERT OR IGNORE INTO activity_video_frames VALUES(?,?,?)').run(sha,ref.bytes,JSON.stringify(ref));}
 progress(bvid,page,cid){const rows=this.db.prepare(`SELECT s.start_seconds,s.end_seconds FROM activity_video_segments s LEFT JOIN activity_video_sessions v ON v.run_id=s.run_id WHERE s.bvid=? AND s.page=? ${cid===undefined?'':"AND CAST(coalesce(json_extract(s.payload_json,'$.cid'),json_extract(v.state_json,'$.info.cid')) AS TEXT)=?"} ORDER BY s.rowid`).all(bvid,page,...cid===undefined?[]:[String(cid)]),ranges=[];for(const r of [...rows].sort((a,b)=>a.start_seconds-b.start_seconds)){const last=ranges.at(-1);if(last&&r.start_seconds<=last[1])last[1]=Math.max(last[1],r.end_seconds);else ranges.push([r.start_seconds,r.end_seconds]);}const continuousUntilSeconds=ranges[0]?.[0]===0?ranges[0][1]:0;return {nextSeconds:continuousUntilSeconds,continuousUntilSeconds,latestEndSeconds:rows.at(-1)?.end_seconds??0,coveredSeconds:ranges.reduce((n,[a,b])=>n+b-a,0),observedRanges:ranges.slice(-12),rangesTruncated:ranges.length>12,segments:rows.length,scope:'只表示实际采样观察区间并集，不证明逐秒理解；跳看末尾不等于看完整片'};}
}
export function makeVideoObservation(info,segments,{mode='sample'}={}){
 if(!segments.length)throw new Error('没有实际视频观察');
 const rangeText=segments.map(s=>`${s.startSeconds.toFixed(2)}–${s.endSeconds.toFixed(2)}秒`).join('、'),parts=[];
 for(const s of segments){parts.push(`【片段 ${s.startSeconds.toFixed(2)}–${s.endSeconds.toFixed(2)}秒】`);if(s.language.text)parts.push(`【${{subtitle:'平台字幕',ai_subtitle:'平台AI字幕，可能误识别',asr:'本地语音转写，可能误识别'}[s.language.source]}】\n${s.language.text}`);for(const f of s.frames)parts.push(`【画面模型解读，推断而非字幕；${f.seconds.toFixed(2)}秒；帧${f.sha256.slice(0,12)}】${f.description}`);if(!s.language.text)parts.push('本片段未取得可用语言文字；不能据此推断完整声音、语气或音乐。');}
 const raw=parts.join('\n'),body=mode==='continuous'?continuousText(segments):Array.from(raw).slice(0,12000).join(''),frames=segments.flatMap(s=>s.frames),scope=`视频抽样区间为第${info.page}P的${rangeText}；实际解读${frames.length}张抽样画面；语言来源逐段标注，平台字幕按相交完整句获取，可能包含边界上下文，转写时间为估计；画面解读为模型推断；未逐帧观看，不能代表片段间遗漏内容或完整视听`;
 const payload={protocol:'ai-friend/video-observation/1',bvid:info.bvid,page:info.page,url:`https://www.bilibili.com/video/${info.bvid}/?p=${info.page}`,title:info.title,scope,dataSource:'multimodal',text:body,truncated:body!==raw,returnedTextHash:hash(raw),video:{cid:info.cid,durationSeconds:info.durationSeconds,segments,...mode==='continuous'?{mode,coverage:videoCoverage(info,segments)}:{}}};
 noSecret(JSON.stringify(payload));return payload;
}
function continuousText(segments){
 const budget=Math.floor(12000/segments.length)-100;
 return segments.map(s=>{const out=['【片段 '+s.startSeconds.toFixed(2)+'–'+s.endSeconds.toFixed(2)+'秒】'];
 if(s.language.text)out.push('【'+({subtitle:'平台字幕',ai_subtitle:'平台AI字幕，可能误识别',asr:'本地语音转写，可能误识别'}[s.language.source])+'】\n'+s.language.text.slice(0,1000)+(s.language.text.length>1000?'\n【此处文字仅节选；完整本段保存在原件】':''));
 const per=Math.max(30,Math.min(180,Math.floor((budget-1550)/Math.max(1,s.frames.length))-100));for(const f of s.frames)out.push('【画面模型解读，推断而非字幕；'+f.seconds.toFixed(2)+'秒；帧'+f.sha256.slice(0,12)+'】'+f.description.slice(0,per));
 if(s.sequence)out.push('【跨帧暂时理解，仅解释采样点；不是原字幕或逐帧事实】'+s.sequence.summary.slice(0,350));
 if(!s.language.text)out.push('本片段未取得可用语言文字；不能据此推断完整声音、语气或音乐。');return out.join('\n').slice(0,budget);
 }).join('\n');
}
export class VideoObserver{
 constructor({journal,media,config={}}){this.media=media;this.baseConfig=Object.freeze(videoConfig(config));this.store=new VideoStore(journal);}
 get config(){return effectiveVideoConfig(this.store.db,this.baseConfig);}
 async available(){return this.config.enabled&&(await this.media.readiness()).ready;}
 async observe({id,target,request,rpc,context,previous,call,checkpoint,host,signal}){
  const state=this.store.state(id),continuous=request.viewMode==='continuous',config=batchVideoConfig(state.samplingConfig??request.videoConfigSnapshot??this.config);if(request.viewMode!==undefined&&!['sample','continuous'].includes(request.viewMode))throw Error('观看模式无效');if(!state.samplingConfig){state.samplingConfig=config;this.store.save(id,state);}let session;
  try{session=await this.media.open(target,signal);const info=session.info;state.info??=info;if(request.expectedVideo&&(String(info.cid)!==String(request.expectedVideo.cid)||info.durationSeconds!==request.expectedVideo.durationSeconds))throw Error('连续视频版本已变化，未混用旧内容');if(state.info.cid!==info.cid||state.info.durationSeconds!==info.durationSeconds)throw new Error('视频分P已变化，未接续旧观察');const prior=previous?.(info)??[];
   for(let ordinal=0;ordinal<config.maxWindows&&!state.complete;ordinal++){
    const existing=this.store.segments(id);if(existing[ordinal])continue;
    if(!state.plans[ordinal]){await checkpoint('video:choose-window');let plan;if(continuous)plan={action:'observe',startSeconds:existing.at(-1)?.endSeconds??request.startSeconds??0,durationSeconds:ordinal===0?(request.durationSeconds??config.windowSeconds):config.windowSeconds,reason:'当前选择的连续观看批次，按时间接续'};else if(ordinal===0&&request.startSeconds!==undefined)plan={action:'observe',startSeconds:request.startSeconds,durationSeconds:request.durationSeconds??config.windowSeconds,reason:'本次请求选定的观察区间'};else plan=(await call('watch',{...context,previousObservations:prior,video:info,progress:this.store.progress(target.bvid,target.page,info.cid),observed:existing.map(s=>({range:[s.startSeconds,s.endSeconds],language:s.language.text.slice(0,1500),frames:s.frames.map(f=>({seconds:f.seconds,description:f.description})),failures:s.failures??[]})),limits:{windowSeconds:config.windowSeconds,remainingWindows:config.maxWindows-ordinal},request:{origin:request.origin??'unknown',explicitVideo:typeof request.video==='object',topic:request.query??null}},signal)).decision;
     if(!plan||!['observe','stop'].includes(plan.action)||typeof plan.reason!=='string'||!plan.reason.trim()||plan.reason.length>600)throw new Error('视频观看选择格式异常');if(plan.action==='stop'){state.complete=true;state.stopReason=plan.reason;this.store.save(id,state);break;}if(ordinal===0&&request.durationSeconds!==undefined)plan={...plan,durationSeconds:request.durationSeconds};
     const range=videoRange(plan,info.durationSeconds,config.windowSeconds);if(existing.some(s=>s.startSeconds===range.startSeconds&&s.endSeconds===range.endSeconds))throw new Error('本次已观察这个片段，未循环重复');state.plans[ordinal]={...range,reason:plan.reason};this.store.save(id,state);}
    const range=state.plans[ordinal];await checkpoint('video:language');let language={source:'none',text:'',truncated:false},notices=[];
    try{const t=await rpc.call('get_video_transcript',{bvid_or_url:target.bvid,page:target.page,include_timestamps:true,start_seconds:range.startSeconds,end_seconds:range.endSeconds,fallback_to_description:false,fallback_to_asr:false,force_asr:false});if(t.bvid!==target.bvid||t.page!==target.page||!['subtitle','ai_subtitle'].includes(t.data_source)||typeof t.transcript!=='string')throw new Error('视频文字身份无法核实');language={source:t.data_source,text:t.transcript.slice(0,3500),truncated:t.transcript.length>3500||t.truncated===true};}catch(e){signal?.throwIfAborted();if(!String(e.message).includes('SUBTITLE_UNAVAILABLE'))throw e;try{const result=await session.transcribe(range);const text=result.segments.map(s=>`[${s.from.toFixed(2)}–${s.to.toFixed(2)}] ${s.content}`).join('\n');language={source:'asr',language:result.language??null,text:text.slice(0,3500),truncated:text.length>3500,...result.transport?{transport:result.transport}:{}};}catch{signal?.throwIfAborted();notices.push('本地语音转写未完成，未将缺失声音当作已理解');}}
    await checkpoint('video:frames');let frames=[],sequence,stage='frames';const failures=[];
    try{const captured=await session.frames(range,continuous?config.continuousFrames:config.maxFrames,{sequence:continuous}),images=[],meta=[];stage='attachment';let total=this.store.frameBytes();for(const f of captured){let ref=this.store.frame(f.sha256)?.attachment;if(!ref){if(total+f.data.length>config.evidenceLimitBytes)throw new Error('持久画面证据额度已用完');if(!host.saveImage)throw new Error('当前宿主没有图片附件服务');ref=await host.saveImage({data:f.data,mediaType:f.mediaType,filename:'bilibili-frame.jpg'});if(total+ref.bytes>config.evidenceLimitBytes)throw new Error('持久图片额度不足');this.store.saveFrame(f.sha256,ref);total+=ref.bytes;}const {data,mediaType,...item}=f;meta.push({...item,attachment:ref});images.push(ref);}
     await checkpoint('video:vision');stage='vision';const snapshot={...context,video:info,range,frames:meta.map(({attachment,...f})=>f),imageAttachments:images,...continuous?{alignedLanguage:{...language,excerpts:languageExcerpts(language.text)},previousObservations:prior,precedingWindows:existing.slice(-2).map(s=>({range:[s.startSeconds,s.endSeconds],sequence:s.sequence??null,frames:s.frames.slice(-2).map(f=>({seconds:f.seconds,description:f.description}))}))}:{} };let result;try{result=await call(continuous?'sequence':'vision',snapshot,signal);}catch(error){if(!continuous||signal?.aborted||error.code!=='STRUCTURED_JSON_INVALID'||!error.repairable||state.sequenceRepairs?.[ordinal])throw error;state.sequenceRepairUsed=true;state.sequenceRepairs={...state.sequenceRepairs,[ordinal]:true};this.store.save(id,state);result=await call('sequence',{...snapshot,formatCorrection:{maximumAttempts:1,error:'上一份输出不是合法JSON，仅修正同一图片和原文下的结构',previousOutput:String(error.rawOutput??'').slice(0,6000)}},signal,{phase:'sequence_repair'});}let described;if(continuous){described={frames:frameDescriptions({frames:result.decision?.frames},meta)};try{described=sequenceDescription(result.decision,meta,language,range,frameDescriptions);}catch(error){failures.push({stage:'sequence',code:'SEQUENCE_EVIDENCE_INVALID',message:'跨帧解释的引用未通过校验，保留逐帧观察'});notices.push('跨帧解释引用未通过校验；逐帧可见内容单独保留，不能当作动作结论');}}else described={frames:frameDescriptions(result.decision,meta)};sequence=described.sequence;frames=described.frames.map(f=>({...f,interpretedBy:{provider:result.provider??null,model:result.model??null}}));
    }catch(e){signal?.throwIfAborted();const failure=videoFailure(e,stage);failures.push(failure);notices.push(failure.message+'（'+failure.code+'）');}
    if(!language.text&&!frames.length)throw new Error('片段既无可用文字也无成功解读的画面');
    const payload={...target,cid:info.cid,...range,language,frames,...sequence?{sequence}:{},failures,...session.transport?{transport:session.transport()}:{},notices:[...notices,...session.notices]};this.store.segment(id,ordinal,payload);await checkpoint('video:segment-saved');
    if(range.endSeconds>=info.durationSeconds||ordinal+1===config.maxWindows)state.complete=true;this.store.save(id,state);
   }
   const segments=this.store.segments(id);return segments.length?{payload:makeVideoObservation(info,segments,{mode:continuous?'continuous':'sample'}),progress:this.store.progress(target.bvid,target.page,info.cid)}:{rested:true,reason:state.stopReason??'这次选择不观察视频'};
  }finally{await session?.cleanup();}
 }
}
