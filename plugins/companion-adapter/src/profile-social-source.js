import {socialOriginal,socialScope,socialSourceHash} from '@ai-friend/qq-bridge/social-memory-store';
import {socialPrincipal} from '@ai-friend/qq-bridge/social-principal';
import {spacePrincipal} from '@ai-friend/qq-bridge/qzone-inbox';
import {hash} from './validation.js';
export const explicitGeneral=text=>/(?:通用(?:画像|偏好|称呼|习惯)?|全局|所有平台|各个平台|任何场合)/.test(text);
export const temporaryChange=text=>/(?:这次|本次|临时|仅今天|只今天|暂时)/.test(text);
export const localChange=text=>/(?:这个群|本群|在群[里内]|这个评论区|本评论区|这个帖子|这条说说|在空间里|这里|这儿|仅限|只在|仅在)/.test(text);
export const scopedFamily=(scene,family)=>'scene:'+hash(JSON.stringify([scene,family]));
export function socialEligible(a,e){
 const m=a.platforms?.socialMemory,q=a.qq?.binding;if(!m||!q||!['group','qzone_comment'].includes(e?.kind)||e.account!==q.bot_qq||e.sender!==q.owner_qq||e.raw?.historyRecovery||!m.live(e,{processed:true}))return false;
 const p=e.kind==='group'?socialPrincipal(a.qq,e):spacePrincipal(a.qq,e);return p.verified&&p.isMainUser&&Boolean(socialOriginal(e));
}
export async function socialProfileSource(a,e,seal,signal){
 if(!socialEligible(a,e))return null;const m=a.platforms.socialMemory;if(!await m.validateSource(e,signal,new Map()))return null;const s=socialScope(e),text=socialOriginal(e),local=localChange(text),mode=explicitGeneral(text)&&!local?'person':'scene';
 return seal({key:'qq-social:'+e.id,channel:'qq',transport:'qq-social',eventId:e.id,scene:e.kind==='qzone_comment'?e.thread_key:s.thread,audience:e.kind==='group'?'group':e.raw.postVisibility===1?'public':e.raw.postVisibility===4?'friends':'self',mode,subject:'main-user:'+a.growth.read().identityId,text,occurredAt:e.created_at,proof:{kind:'verified-qq-social-original',rawHash:e.raw_hash,sourceHash:socialSourceHash(e),originThread:e.thread_key,scope:s.thread}});
}
