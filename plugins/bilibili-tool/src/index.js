import {BilibiliToolController} from './controller.js';
import {attachActivityHost} from './activity-host.js';
import {attachBilibiliInboxHost} from './bilibili-inbox-host.js';
import {attachWorkbenchHost} from './workbench-host.js';

export const name='ai-friend-bilibili-tool';
export const version='0.7.0';
export const provide=['friendBilibili'];
export const inject=[];
export function apply(ctx){
  const controllers=new Set();
  const service={
    async create(options){const controller=await BilibiliToolController.create(options);controllers.add(controller);return controller;},
    current(){let found=null;for(const controller of controllers)found=controller;return found;},
    status(){return {plugin:name,version,controllers:[...controllers].map(controller=>controller.status?.()??null)};}
  };
  ctx.provide('friendBilibili',service);
  ctx.effect(()=>async()=>{await Promise.allSettled([...controllers].map(controller=>controller.close()));},'ai-friend: bilibili tool controllers');
  // 宿主装配完成后挂载轮询与驱动循环；工具注册在 /agent 子模块。
  ctx.inject(['friendBilibili','friendAdapter'],bound=>{
    const controller=service.current();if(!controller)return;
    attachActivityHost(ctx,controller);
    attachBilibiliInboxHost(ctx,controller);
  });
  // Reuse DSH's authenticated owner Fetch carrier. No direct webServer or
  // legacy unauthenticated diagnostic route; no RPC fiber dependency.
  ctx.inject(['friendBilibili','friendAdapter'],bound=>{
    const controller=service.current();if(!controller)return;
    attachWorkbenchHost(bound,controller);
  });
}
