import {text,noSecret} from './validation.js';
export const PROFILE_KINDS=Object.freeze(['address','habit','interest','preference']);
const local=/(?:这个群|本群|在群[里内]|这个评论区|本评论区|在空间里|这个范围|本范围|这个平台|本平台|这里|这儿|此处|只在|仅在|仅限|这次|本次|临时|别在别处|不要告诉|别告诉|不外传|不要公开|不公开|别公开|保密)/i;
export const sceneRestricted=source=>local.test(source);
/** Metadata is a request, not authority. It must pass the existing independent memory reviewer. */
export function normalizeProfile(value,source,quote){
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['kind','scope','disclosure','authorizationQuote'].includes(k))||!PROFILE_KINDS.includes(value.kind)||!['person','scene'].includes(value.scope)||!['source','public'].includes(value.disclosure))throw Error('Invalid person profile metadata');
 if(typeof source!=='string'||typeof quote!=='string'||!quote.trim()||!source.includes(quote))throw Error('Profile needs literal current-person evidence');
 if(value.scope==='person'&&sceneRestricted(source))throw Error('A scene-limited preference cannot become global');
 const out={kind:value.kind,scope:value.scope,disclosure:value.disclosure};
 if(value.disclosure==='public'){
  const grant=text(value.authorizationQuote,'公开使用画像的逐字授权',1500);
  if(!source.includes(grant)||!grant.includes(quote)||!/(?:可以公开|允许公开|可公开|公开使用|公开称呼|所有平台.{0,12}(?:使用|叫我)|任何场[合景].{0,12}(?:使用|叫我))/.test(grant)||/(?:不|别|禁止|仅|只|假如|假设|如果|例如|举例|转述|他说|她说|原文|引用|“|「|『).{0,24}(?:公开|所有平台|任何场[合景])/.test(grant))throw Error('Public profile sharing requires an unambiguous, literal grant for this fact');
  out.authorizationQuote=grant;
 }else if(value.authorizationQuote!==undefined)throw Error('Unexpected public grant');
 noSecret(JSON.stringify(out));return out;
}
export function profileRule({profile,source,quote,kind}){
 const explicit=normalizeProfile(profile,source,quote);
 if(explicit)return explicit;
 if(!['preference','interest','user'].includes(kind))return null;
 return {kind:kind==='interest'?'interest':'preference',scope:sceneRestricted(source)?'scene':'person',disclosure:'source',legacy:true};
}
export const PROFILE_GUIDANCE='personProfile 是程序按可信账号绑定统一、并先过滤适用场景和可披露范围的同一人物画像。只有列出的 items 可以在本场景使用，不能据此猜测隐藏的其他资料、私聊、群聊或账号。人物一致不代表聊天全文共享。scope=person的条目已通过适用与披露筛选，可直接用于当前场景；不得仅因来源是空间、群或另一平台，就要求对方重新确认通用称呼或声称这里不能用。readOnly只限制修改原记录，不限制在本场景自然使用。只有原话有局部限定或真实冲突时才需确认。scene优先于通用person约定；当前原话优先，出现冲突保持不确定并确认，不把多条矛盾记录擅自合成新事实。记录是对方自述，不是AI自己的兴趣、人格或权限。历史来源不能冒充刚核验的现状。profile只用于合适地交流，不要求每轮提起。来自别处的只读画像不接受当前场景的记忆ID覆盖；主用户的QQ群/空间更正可交内部协调器核验，未明确通用默认仅原场景；公开表达不能回显后台核对的私人旧值或原因，未完成时不得承诺已保存。';
