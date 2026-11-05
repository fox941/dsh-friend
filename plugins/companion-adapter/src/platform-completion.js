import {goalNoSave} from './goals.js';
import {noSecret} from './validation.js';
const actions=new Set(['qq_signature','qq_nickname','qq_avatar','qq_space_publish','qq_space_comment','qq_space_reply']);
const settled=new Set(['confirmed','failed','rejected','unsupported','unconfirmed','observed']);
const asksForResult=text=>!/(?:不要|不必|不用|无需|别).{0,8}(?:告诉|通知|回复|反馈|汇报)/.test(text)&&/(?:改完|完成|执行|操作|设置|更换).{0,16}(?:读|告诉|确认|回|反馈|汇报)|读回|告诉我(?:实际|结果)/.test(text);
export function platformCompletionRequest(adapter,op){
 const qq=adapter.qq,binding=qq?.binding;if(!binding||!qq.store?.db||op.account!==binding.bot_qq||op.source?.kind!=='model_proposal'||op.source.sessionId!==binding.session_id)return null;
 const request=qq.store.db.prepare('SELECT rowid AS ordinal,* FROM qq_inbox WHERE session_id=? AND message_id=? AND binding_id=?').get(binding.session_id,op.source.messageId,binding.id);
 if(!request||['cancelled','superseded','expired','interrupted','failed','unknown'].includes(request.status)||!asksForResult(request.body))return null;
 // /stop cancels pending task reports, without erasing the actual action receipt.
 if(qq.store.db.prepare('SELECT 1 FROM qq_inbox WHERE binding_id=? AND rowid>? AND trim(body)=? LIMIT 1').get(binding.id,request.ordinal,'/stop'))return null;
 return request;
}
/** Only an actual bound-owner QQ request can authorize its completion reply. */
export function platformCompletionSource(adapter,intent){
 if(intent?.kind!=='browse'||intent.status!=='completed'||!intent.payload?.platformActionId)return null;
 const platforms=adapter.platforms,qq=adapter.qq,binding=qq?.binding;if(!platforms?.store||!binding)return null;
 const op=platforms.store.operation(intent.payload.platformActionId);
 if(!op||!actions.has(op.action)||!settled.has(op.status)||op.status!==intent.result?.status||intent.result?.operationId!==op.id||op.account!==binding.bot_qq||op.source?.kind!=='model_proposal'||op.source.sessionId!==binding.session_id)return null;
 const request=platformCompletionRequest(adapter,op);if(!request)return null;
 const db=platforms.store.db;
 if(['qq_signature','qq_nickname','qq_avatar'].includes(op.action)&&db.prepare("SELECT 1 FROM platform_operations WHERE account=? AND action IN ('qq_signature','qq_nickname','qq_avatar') AND rowid>(SELECT rowid FROM platform_operations WHERE id=?) AND dispatched=1 LIMIT 1").get(op.account,op.id))return null;
 const raw=db.prepare('SELECT updated_at FROM platform_operations WHERE id=?').get(op.id),verification=op.verification;
 if(op.status==='confirmed'&&(!op.dispatched||!op.receipt?.apiAccepted||verification?.verified!==true))return null;
 if(op.status==='observed'&&(!['qq_space_comment','qq_space_reply'].includes(op.action)||!op.dispatched||!op.receipt?.apiAccepted||verification?.observed!==true||verification?.verified!==false))return null;
 const text=JSON.stringify({operationId:op.id,action:op.action,status:op.status,requested:op.args,receipt:op.receipt??null,verification:verification??null,verifiedAt:raw.updated_at});noSecret(text);
 if(text.length>8000)return null;
 return {key:'requested-qq-operation:'+op.id,kind:'requested_platform_result',requestedReply:true,requestId:op.id,requestQuote:request.body,learningAllowed:!goalNoSave(request.body),title:'先前QQ账号操作的实际结果',text,scope:'原主用户QQ请求的执行回执；读回是该操作执行后的核验，不是永远有效的实时资料；未确认不能说成功，不修改长期记忆或人格，不代表对方已读或公开可见',status:op.status,originIntentId:intent.id};
}
