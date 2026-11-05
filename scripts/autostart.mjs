import path from 'node:path';import {projectRoot} from './paths.mjs';import {requireMain} from './instances.mjs';import {enableAutostart,disableAutostart,runAutostart,readConfig,taskName,files} from './autostart-core.mjs';import {machineContext,taskAction,startupHooks} from './autostart-ops.mjs';import {readJson,json} from './migration-files.mjs';
try{
 requireMain('Windows主实例自启');const action=process.argv[2]??'status',context=await machineContext(projectRoot),task=(a,c)=>taskAction(projectRoot,a,c);
 if(action==='enable')console.log(json(await enableAutostart({project:projectRoot,context,task})));
 else if(action==='disable')console.log(json(await disableAutostart({project:projectRoot,context,task})));
 else if(action==='run')console.log(json(await runAutostart({project:projectRoot,context,hooks:startupHooks(projectRoot)})));
 else if(action==='status'){
  const c=readConfig(projectRoot),local=c?.machineKey===context.machineKey&&c.ownerSid===context.ownerSid,plan={projectRoot,ownerSid:context.ownerSid,machineKey:context.machineKey,taskName:taskName(projectRoot,context.ownerSid)};let scheduler;try{scheduler=await task('status',plan);}catch{scheduler={available:false,reason:'Windows任务状态未读取成功'};}
  const last=await readJson(files(projectRoot).status).catch(e=>{if(e.code==='ENOENT')return null;throw e;});console.log(json({configured:!!c,enabled:Boolean(c?.enabled&&local),paused:c?.paused??false,machineMatches:!!local,scheduler,lastRun:last,scope:'仅Main；迁移到其他电脑需在当地重新启用'}));
 }else throw Error('用法：autostart.mjs enable|disable|status|run');
}catch(e){console.error('自启操作未完成：'+e.message);process.exitCode=1;}
