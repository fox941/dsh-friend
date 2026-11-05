import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {instanceRoot,projectRoot,applyEnvironment} from './paths.mjs';
import {acquireOfflineLease} from './protection-control.mjs';

const [action,id]=process.argv.slice(2);
if(!['check','undo','report','verify'].includes(action)||!/^[-0-9a-f]{36}$/i.test(id??''))throw new Error('用法：protection.mjs check|undo|report|verify <应用批次 UUID>；请先停止实例。');
let lease,controller;
try{
  applyEnvironment();lease=await acquireOfflineLease(instanceRoot);
  const profile=path.join(instanceRoot,'dsh-home/profiles/web'),require=createRequire(path.join(profile,'package.json'));
  const yaml=createRequire(await fs.realpath(path.join(projectRoot,'node_modules/@deepseek-ai/dsh/package.json')))('js-yaml');
  const patches=yaml.load(await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8'));
  const config=patches.find(row=>row.id==='friend-adapter')?.config?.protection??{};
  const {openProtection,undoBatch}=await import(pathToFileURL(require.resolve('@ai-friend/companion-adapter/protection-offline')));
  controller=await openProtection(instanceRoot,{assertOffline:lease.assertOffline,config});
  const {protection}=controller;let result;
  if(action==='undo')result=await undoBatch(protection,id,{kind:'explicit-local-cli',requestedAt:new Date().toISOString()},{assertOffline:lease.assertOffline});
  else if(action==='check')result=await protection.eligibility(id);
  else if(action==='report')result=await protection.changes(id,{includeSources:true,checkUndo:true,html:true});
  else{await protection.snapshots.verify(id);result={verified:true,applicationId:id,...protection.summary(id)};}
  console.log(JSON.stringify(result,null,2));
  if(action==='undo'&&result.status!=='completed')process.exitCode=2;
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await controller?.close();await lease?.close();}
