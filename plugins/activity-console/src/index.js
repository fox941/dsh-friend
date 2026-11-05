import {ActivityRegistry,activityResponse,activityControlResponse} from './registry.js';
export const name='ai-friend-activity-console';
export const provide=['friendActivityConsole'];
export const inject=[];
export function apply(ctx){
 const registry=new ActivityRegistry();ctx.provide('friendActivityConsole',registry);
 ctx.inject(['connection'],bound=>{const connection=bound.get('connection');bound.effect(()=>connection.fetch.register({path:'/api/ai-friend-activity-control',methods:['POST'],requestBody:'streaming',fetch:activityControlResponse(registry)}),'activity settings control');for(const [suffix,detail]of [['',false],['-detail',true]])bound.effect(()=>connection.fetch.register({path:'/api/ai-friend-activity'+suffix,methods:['GET'],requestBody:'buffered',fetch:activityResponse(registry,detail)}),'activity console read view');});
 ctx.effect(()=>()=>registry.readers.clear(),'activity console readers');
}
