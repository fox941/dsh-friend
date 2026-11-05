import {QQController} from './qq.js';
import {QQMedia} from './qq-media.js';
export {QQController,qqInbound,replyParts} from './qq.js';
export {QQMedia} from './qq-media.js';
export {QQAccountClient} from './accounts.js';
export {QQSocialController} from './social.js';
export const name='ai-friend-qq-bridge';
export const provide=['friendQQBridge'];
export const inject=[];
export function apply(ctx){
 const channels=new Set();let closed=false;
 ctx.provide('friendQQBridge',{
  createChannel(options){if(closed)throw Error('QQ bridge is disposed');if([...channels].some(c=>!c.closed&&c.workspace===options.workspace))throw Error('QQ workspace already has a channel');const c=new QQController({...options,createConnection:options.createConnection??(async settings=>{const {OneBotConnection}=await import('../vendor/dsh-onebot/connection.js');return new OneBotConnection(settings);})});channels.add(c);const close=c.close.bind(c);c.close=async()=>{try{await close();}finally{channels.delete(c);}};return c;},
  createMedia(options){if(closed)throw Error('QQ bridge is disposed');return new QQMedia(options);},
  status(){return {plugin:'@ai-friend/qq-bridge',version:'0.20.0',channels:[...channels].map(c=>c.status())};}
 });
 ctx.effect(()=>async()=>{closed=true;await Promise.allSettled([...channels].map(c=>c.close()));},'ai-friend: independent QQ bridge');
}
