import {sameEpisodeScope} from './space-episode-scope.js';
import {sealObservationSource} from './activity-source.js';
import {hash,noSecret} from './validation.js';
export const singleRecord=j=>({eventId:j.eventId,sourceId:j.sourceId,rawHash:j.rawHash,account:j.account,sender:j.sender,...j.mediaProof?{mediaProof:j.mediaProof}:{},...j.spaceEpisodeProtocol===1?{spaceEpisodeProtocol:1,spaceEpisodeBranch:j.spaceEpisodeBranch}:{}});
export function knownEpisodeContext(a,job,known){
 if(!job.episodeLink?.accepted)return true;const current=a.platforms.store.event(job.eventId),members=job.episodeLink.members;
 return Boolean(current&&Array.isArray(members)&&members.length<=3&&members.every(m=>{const e=a.platforms.store.event(m.eventId);return m.eventId!==job.eventId&&known(a,m)&&(!a.socialExperience?.episodes.superseded(m.sourceId)||job.episodeLink.corrections.some(c=>c.eventId===m.eventId))&&sameEpisodeScope(current,e)&&(!(current.kind==='qzone_comment')||job.spaceEpisodeProtocol===1&&m.spaceEpisodeProtocol===1)&&a.journal.db.prepare('SELECT rowid n FROM platform_events WHERE id=?').get(e.id).n<a.journal.db.prepare('SELECT rowid n FROM platform_events WHERE id=?').get(current.id).n&&Date.parse(e.created_at)<=Date.parse(current.created_at)&&Date.parse(current.created_at)-Date.parse(e.created_at)<=20*60000;}));
}
export async function episodeExperienceSource(a,job,current,signal,readSingle){
 if(!current||job.episodeProtocol!==1)return current;if(job.episodeLink?.sourceProtocol===1&&hash(JSON.stringify(current))!==job.episodeLink.currentSourceHash)return null;
 const sources=[];if(job.episodeLink?.accepted)for(const member of job.episodeLink.members){const s=await readSingle(a,member,signal);if(!s||job.episodeLink.sourceProtocol===1&&hash(JSON.stringify(s))!==job.episodeLink.memberSourceHashes?.[member.eventId])return null;sources.push({record:member,source:s});}
 const corrections=job.episodeLink?.corrections??[],parts=[...sources.map(({record,source})=>({id:record.eventId,source,old:true})),{id:job.eventId,source:current,old:false}],allowance=Math.floor((12000-parts.length*180)/parts.length);
 const content=parts.map(p=>{const replaced=corrections.some(c=>c.eventId===p.id),text=p.source.content.slice(0,allowance);return '【'+(p.old?'同话题先前原件':'本次新原件')+' '+p.id+(replaced?'；含已被后续原话纠正的内容，不能再按旧解释当作当前依据':'')+'】\n'+text+(text.length<p.source.content.length?'\n【本原件有截断，缺失部分不代表没有反例】':'');}).join('\n\n');noSecret(content);
 const context=parts.flatMap(p=>p.source.context.map(c=>({...c,content:c.content.slice(0,1000),eventId:p.id}))).slice(-6),evidenceKeys=[...new Set(parts.flatMap(p=>p.source.origin.evidenceKeys??[]))];
 return sealObservationSource({...current,content,context,origin:{...current.origin,...evidenceKeys.length?{evidenceKeys}: {},experienceWindowKey:job.episodeWindow.id,experienceContext:{protocol:1,independenceUncertain:job.episodeWindow.independenceUncertain===true,windowStartedAt:job.episodeWindow.startedAt,linkedEvents:sources.map(p=>p.record.eventId),corrections,parts:parts.map(p=>({eventId:p.id,earlier:p.old,truncated:p.source.content.length>allowance,sourceCharacters:p.source.content.length,presentedCharacters:Math.min(p.source.content.length,allowance)})),boundary:'同发送者同话题的有界原件组合；纠正是该发送者当前说法，不证明客观事实。时间窗只限制取材和独立证据计数，不自动证明语义相关；同一短对话不重复累积人格支持'}}});
}
export function repeatedSocialExperience(event,previous){
 const origin=event.origin;if(origin?.experienceContext?.protocol!==1)return false;
 if(origin.experienceContext.independenceUncertain&&previous.length)return true;
 const keys=new Set((origin.evidenceKeys??[]).filter(k=>/^(image|audio):[a-f0-9]{64}$/.test(k)));
 return previous.some(p=>p&&((p.origin?.experienceContext?.protocol===1&&p.origin.experienceWindowKey===origin.experienceWindowKey)||(p.origin?.evidenceKeys??[]).some(k=>keys.has(k))));
}
