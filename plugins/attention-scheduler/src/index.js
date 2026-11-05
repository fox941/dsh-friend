import {SchedulerController} from './controller.js';

export const name='ai-friend-attention-scheduler';
export const provide=['friendScheduler'];
export const inject=[];
export function apply(ctx){
 const controllers=new Set();
 const service={
  create(options){const controller=new SchedulerController(options);controllers.add(controller);const close=controller.close.bind(controller);controller.close=async()=>{try{await close();}finally{controllers.delete(controller);}};return controller;},
  status(){return {plugin:'@ai-friend/attention-scheduler',version:'0.3.0',engine:'xstate',engineVersion:'5.33.3',controllers:[...controllers].map(c=>({enabled:c.enabled(),planning:c.planner.status(),admission:c.admissions.status()}))};}
 };
 ctx.provide('friendScheduler',service);
 ctx.effect(()=>async()=>{await Promise.allSettled([...controllers].map(c=>c.close()));},'ai-friend: XState attention scheduler');
}
