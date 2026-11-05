import path from 'node:path';
export const QQ_SOURCE='ai-friend:qq';
const authorities=new Map();
const biliAuthorities=new Map();
const key=value=>typeof value==='string'?path.resolve(value).toLowerCase():null;
/** Installed only by the trusted root channel, never inferred from message text. */
export function registerQQAuthority(workspace,verify,{assistant,pending}={}){
  const id=key(workspace);if(!id||authorities.has(id)||typeof verify!=='function')throw new Error('QQ来源核验器不能重复注册');
  const entry={verify,assistant,pending};authorities.set(id,entry);return ()=>{if(authorities.get(id)===entry)authorities.delete(id);};
}
export function ownerIdentity(event,header){
  if(event?.type!=='user/message'||event.sourceEventSeqs?.length)return null;
  const source=event.data?.source;
  if(source?.kind!=='user')return null;
  if(source.principal==null)return {channel:'dsh-direct',principal:'main-user'};
  if(source.principal.kind!==QQ_SOURCE)return null;
  if(!header||header.agentPreset!=='companion'||header.origin||header.isSeeded||header.parentSession||header.delegationDepth)return null;
  return authorities.get(key(header.cwd))?.verify(event,header)??null;
}
export const originalOwnerEvent=(event,header)=>{const identity=ownerIdentity(event,header);return Boolean(identity&&!identity.qq?.recovery);};
export function registerBilibiliAuthority(workspace,verify){const id=key(workspace);if(!id||biliAuthorities.has(id)||typeof verify!=='function')throw new Error('B站事件发布核验器不能重复注册');biliAuthorities.set(id,verify);return ()=>{if(biliAuthorities.get(id)===verify)biliAuthorities.delete(id);};}
/** A stored assistant draft is not evidence of a QQ message being delivered. */
export function assistantResponseDelivered(event,header){
  if(event?.type!=='assistant/message'||event.data.interrupted)return false;
  const result=authorities.get(key(header?.cwd))?.assistant?.(event,header);
  if(typeof result==='boolean')return result;
  const bili=biliAuthorities.get(key(header?.cwd))?.(event,header);
  return typeof bili==='boolean'?bili:true;
}
export function assistantPublicationPending(event,header){return event?.type==='assistant/message'&&!event.data.interrupted&&authorities.get(key(header?.cwd))?.pending?.(event,header)===true;}
