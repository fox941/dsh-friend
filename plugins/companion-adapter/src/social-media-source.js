import {qqSegments} from '@ai-friend/qq-bridge/media';
import {noSocialLearning} from '@ai-friend/qq-bridge/social-memory-store';
import {hash,noSecret} from './validation.js';
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const forbidden=v=>noSocialLearning(v)||/(?:不许|不准|禁止|不可以|不能|勿).{0,8}(?:保存|记录|学习|记住|记忆)/.test(v);
const ownText=e=>(e.raw.message??[]).filter(s=>s.type==='text'&&typeof s.data?.text==='string').map(s=>s.data.text).join('');
const scopeMatches=(scope,e)=>scope?.account===e.account&&scope.peer===e.sender&&scope.thread===e.thread_key&&String(scope.groupId??'')===(e.kind==='group'?String(e.raw.group_id):'');
function excerpts(parts){
 const marker='\n【本段有截断，其余内容未纳入本次评价】',reserve=parts.reduce((n,p)=>n+p.label.length+marker.length+3,0);let remaining=12000-reserve;
 const coverage=[],out=parts.map((p,i)=>{const size=Math.min(p.text.length,Math.floor(remaining/(parts.length-i)));remaining-=size;coverage.push({kind:p.kind,originalChars:p.text.length,includedChars:size,truncated:size<p.text.length});return p.label+'\n'+p.text.slice(0,size)+(size<p.text.length?marker:'');});
 return {content:out.join('\n\n'),excerpts:coverage};
}
export function mediaLearningBlocked(a,e,text){
 if(forbidden(text))return true;
 if(/(?:可以|允许|恢复).{0,6}(?:保存|记住|学习|记录)/.test(text))return false;
 const since=new Date(Date.parse(e.created_at)-120000).toISOString();return a.journal.db.prepare('SELECT body FROM platform_events WHERE thread_key=? AND sender=? AND rowid<(SELECT rowid FROM platform_events WHERE id=?) AND created_at>=? ORDER BY rowid DESC LIMIT 3').all(e.thread_key,e.sender,e.id,since).some(r=>forbidden(r.body)&&/(?:接下来|这张|这条|图片|照片|语音|媒体|发图)/.test(r.body));
}
/** Read verified existing observations only. Never invokes vision, ASR or downloads. */
export function socialMediaBasis(a,e,{existing=false,historical=false,allowQueued=false}={}){try{
 if(!e||!['group','friend'].includes(e.kind)||e.raw.historyRecovery||!(allowQueued?['queued','sent','ignored']:['sent','ignored']).includes(e.status))return null;
 const m=a.platforms.socialMemory;if(!m||!historical&&(m.closed||!m.enabled(e))||m.currentAccount()!==e.account)return null;
 const segments=qqSegments(e.raw);if(!segments.some(s=>['image','record'].includes(s.type))||segments.some(s=>['reply','forward'].includes(s.type)))return null;
 if(!existing){const cutoff=Number(a.journal.db.prepare("SELECT value FROM social_experience_meta WHERE key='media-cutoff'").get()?.value??Number.MAX_SAFE_INTEGER),row=a.journal.db.prepare('SELECT rowid n FROM platform_events WHERE id=?').get(e.id);if(!row||row.n<=cutoff)return null;}
 const store=a.platforms.store,inputRow=store.db.prepare('SELECT id,value_hash FROM platform_media WHERE event_key=?').get('input:social:'+e.id);if(!inputRow)return null;const input=store.media(inputRow.id);if(input.kind!=='input'||!scopeMatches(input.scope,e)||JSON.stringify(input.segments)!==JSON.stringify(segments))return null;
 const readRow=store.db.prepare('SELECT id,value_hash FROM platform_media WHERE event_key=?').get('read:'+input.id);if(!readRow)return null;const observation=store.media(readRow.id);
 if(observation.kind!=='observation'||observation.observationVersion!==2||observation.inputId!==input.id||!scopeMatches(observation.scope,e)||observation.inputFingerprint!==hash(JSON.stringify([input.id,input.scope,input.segments]))||!Number.isFinite(Date.parse(observation.observedAt)))return null;
 const caption=ownText(e);if(mediaLearningBlocked(a,e,caption))return null;
 const images=observation.images??[],records=observation.records??[];if(!Array.isArray(images)||images.length>4||!Array.isArray(records)||records.length>2)return null;
 const keys=[],parts=[],assets=[];if(caption.trim()){parts.push({kind:'caption',label:'【本轮发送者原始文字】',text:caption});keys.push('caption:'+hash(caption.normalize('NFKC').replace(/\s+/g,' ').trim()));}
 if(images.length){const v=observation.visualInterpretation;if(v?.source!=='model_visual_interpretation'||v.uncertain!==true||typeof v.text!=='string'||!v.text.trim()||v.text.length>6000)return null;
  for(const image of images){const asset=store.media(image.assetId);if(image.origin!=='incoming'||!digest(image.sha256)||asset.kind!=='image'||asset.sha256!==image.sha256||!scopeMatches(asset.scope,e))return null;keys.push('image:'+image.sha256);assets.push(image.assetId);}
  const gifCoverage=images.filter(i=>i.mediaType==='image/gif'&&i.visualSampling).map(i=>({sha256:i.sha256,frameCount:i.visualSampling.frameCount,timestamps:i.visualSampling.timestamps,complete:false}));if(gifCoverage.length)parts.push({kind:'gif_coverage',label:'【GIF实际采样范围：未证明完整动画】',text:JSON.stringify(gifCoverage)});
  parts.push({kind:'image',label:'【实际读取的图片观察：'+images.length+'张；模型解读存在推断，不是发送者原话】',text:v.text});
 }
 for(const record of records){if(record.origin!=='incoming'||record.source!=='local_asr'||record.uncertain!==true||!digest(record.sha256)||typeof record.text!=='string'||!record.text.trim()||record.text.length>6000||record.maxSeconds!==180)return null;if(forbidden(record.text))return null;keys.push('audio:'+record.sha256);parts.push({kind:'audio',label:'【实际语音转写：本地ASR、可能误识别，未验证实际讲话者，最多前180秒；不是已核实的逐字自述或授权】',text:record.text});}
 if(!images.length&&!records.length)return null;const {content,excerpts:included}=excerpts(parts);noSecret(content);const evidenceKeys=[...new Set(keys)].sort(),proof={observationId:readRow.id,observationHash:readRow.value_hash,inputId:inputRow.id,inputHash:inputRow.value_hash,evidenceFingerprint:hash(JSON.stringify(evidenceKeys))};
 return {content,proof,evidenceKeys,assets,imageCount:images.length,audioCount:records.length,coverage:{observedAt:observation.observedAt,excerpts:included,notices:observation.notices??[],complete:false,meaning:'仅本次已保存的有界媒体观察；不证明全部媒体、全部语音或所有画面已读完'}};
 }catch{return null;}}
export function blockedSocialMedia(a,e){try{if(!['group','friend'].includes(e?.kind)||!qqSegments(e.raw).some(s=>['image','record'].includes(s.type)))return false;if(mediaLearningBlocked(a,e,ownText(e)))return true;const input=a.platforms.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('input:social:'+e.id),read=input&&a.platforms.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('read:'+input.id),observation=read&&a.platforms.store.media(read.id);return Boolean(observation?.records?.some(r=>forbidden(r.text??'')));}catch{return true;}}
export function knownSocialMedia(a,record){if(!record.mediaProof)return true;const e=a.platforms.store.event(record.eventId),basis=socialMediaBasis(a,e,{existing:true,historical:true,allowQueued:record.queuedSource===true});return Boolean(basis&&JSON.stringify(basis.proof)===JSON.stringify(record.mediaProof));}
