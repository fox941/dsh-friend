import { text, noSecret } from './validation.js';
import {ownerIdentity,QQ_SOURCE} from './source-identity.js';

export function ownerMessage(agent) {
  if (!agent?.session || agent.session.header.origin === 'subagent') throw new Error('更正工具仅供主用户的直接会话使用');
  const session = agent.session;
  for (let seq=session.seq-1;seq>=Math.max(0,session.seq-500);seq--) {
    const event=session.eventAt(seq);
    if (event?.type==='turn/start') break;
    if (event?.type!=='user/message' || !['user',QQ_SOURCE].includes(event.data.source?.kind)) continue;
    if (!ownerIdentity(event,session.header)) throw new Error('当前来源不是已核验的主用户原话');
    return event;
  }
  throw new Error('没有找到本轮主用户的更正依据');
}
export function userEvidence(agent, quote) {
  const wanted=text(quote,'用户原话',2000);noSecret(wanted);
  const event=ownerMessage(agent);
  const value=(event.data.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
  if(!value.includes(wanted))throw new Error('更正依据必须逐字引用本轮主用户原话');
  return {owner:true,sessionId:agent.id,messageId:event.data.id,seq:event.seq,quote:wanted};
}
