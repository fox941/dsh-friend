import {attachActivities} from './activity-agent.js';
import {attachBilibiliInbox} from './bilibili-inbox-agent.js';

export const name='ai-friend-bilibili-interaction';
export const inject=['tools','systemPrompt'];
export function apply(ctx){
  ctx.inject(['friendBilibili','friendAdapter'],bound=>{
    const adapter=bound.friendBilibili?.current?.();
    if(!adapter)return;
    attachActivities(ctx,adapter);
    attachBilibiliInbox(ctx,adapter);
  });
}
