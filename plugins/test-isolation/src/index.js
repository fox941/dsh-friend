import path from 'node:path';
import {resolveInstance,assertTestSafety} from '../../../scripts/instances.mjs';
export const name='ai-friend-test-isolation';
export const inject=['tools'];
const active=new Map();
export const ALLOWED=new Set(['mnemon_recall','friend_capabilities','friend_memory_history','friend_memory_read','friend_memory_write','friend_memory_write_retry','friend_memory_preview','friend_memory_preview_read','friend_memory_apply','friend_memory_apply_read','friend_memory_changes','friend_state_read','friend_state_history','friend_state_propose','friend_emotion_read','friend_emotion_history','friend_emotion_propose','friend_nightly_read','friend_nightly_control','friend_diagnostics_read','friend_attention_status','friend_goals_read','friend_qq_status','friend_activity_status','friend_proactive_status']);
export function readIsolation(root){return {active:active.has(path.resolve(root).toLowerCase()),scope:'test-local-only',version:'0.1.0',realPlatforms:false};}
export function denial(exec,validate){try{validate();}catch{return '测试隔离配置已变化；请停止测试并运行 Setup-Test，未执行工具。';}return ALLOWED.has(exec.name)?undefined:'隔离测试实例仅允许本地记忆、自我状态及只读诊断；终端、文件、网络、平台操作和自动活动控制均未执行。';}
export function apply(ctx){
  const root=path.resolve(process.env.DSH_HOME??'','..'),project=path.resolve(root,'../..'),descriptor=resolveInstance(project,'test');
  if(root.toLowerCase()!==descriptor.root.toLowerCase()||process.env.AI_FRIEND_INSTANCE!=='test')throw Error('测试工具守卫只能挂载到显式选择的 runtime/test');
  assertTestSafety(descriptor);
  ctx.tools.guard(exec=>denial(exec,()=>assertTestSafety(descriptor)));
  const key=root.toLowerCase();active.set(key,true);ctx.effect(()=>()=>active.delete(key),'test isolation status');
  ctx.inject(['systemPrompt'],bound=>bound.systemPrompt.section({name:'ai-friend:test-isolation',order:100,interpolate:false,text:'当前是独立的隔离测试实例，使用测试会话、测试记忆与测试身份。测试资料不是主实例的真实经历。只允许本地记忆、自我/情绪及诊断工具；不能调用平台、网络、终端、文件或自动活动控制。工具清单出现某项不代表本实例获准执行。此说明是运行边界，不规定你的性格或感受。'}));
}
