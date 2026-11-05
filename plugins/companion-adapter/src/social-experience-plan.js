import {validateGrowthProposals} from './growth.js';
import {noSecret} from './validation.js';
function validate(p,frame,emotions){
 if(!p||Object.keys(p).some(k=>!['growth','emotion','reason'].includes(k))||!Array.isArray(p.growth)||p.growth.length>3||p.growth.some(x=>!['interest','trait','self_description','personal_prompt'].includes(x.kind))||!Array.isArray(p.emotion)||p.emotion.length>4||typeof p.reason!=='string'||p.reason.length>700)throw Error('社交经历提案不符合协议');
 noSecret(JSON.stringify(p));if(p.growth.length)validateGrowthProposals(p.growth,frame.source);if(p.emotion.length)emotions.validate({expectedRevision:frame.feelings.revision,proposals:p.emotion},frame.source);
}
const keyFormatError=error=>['状态键只能使用文字、数字、空格、下划线和连字符','该类型使用 current 作为唯一状态键'].includes(error?.message);
/** One model correction for key syntax only; never approves or rewrites a claim itself. */
export async function reviewSocialPlan({frame,signal,emotions,propose,reserve,validSource,record}){
 let correction;
 for(let attempt=1;attempt<=2;attempt++){
  signal.throwIfAborted();await reserve();const answer=await propose(correction?{...frame,formatCorrection:correction}:frame,signal);signal.throwIfAborted();noSecret(JSON.stringify(answer));
  try{validate(answer.decision,frame,emotions);}catch(error){
   const repairable=keyFormatError(error);await record({attempt,status:'invalid',error:error.message,repairable,review:answer});if(!repairable||attempt===2)throw error;
   if(!await validSource())throw Error('格式纠正前原件、身份或学习许可已变化');
   correction={attempt:1,maximumAttempts:1,error:error.message,previousDecision:answer.decision,instruction:'这是唯一一次状态键语法纠正。保留对实际经历的原意，由你重新输出完整JSON，也可选择零变化。interest/trait的key只含文字、数字、空格、下划线和连字符，最多60字符；不要类型前缀、冒号、斜杠、括号或标点。self_description/personal_prompt用current。不新增授权，不捏造依据，仍须独立审核。'};continue;
  }
  await record({attempt,status:'valid',repairable:false,review:answer});return answer;
 }
 throw Error('社交经历格式纠正未完成');
}
