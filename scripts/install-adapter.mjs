import {installActivityConsole} from './install-activity-console.mjs';
import {installQQBridge} from './install-qq-bridge.mjs';
import {installBilibiliTool} from './install-bilibili-tool.mjs';
import {installScheduler} from './install-scheduler.mjs';
import {assertOffline} from './archive.mjs';
import fs from 'node:fs/promises';
import {installQQHelper} from './install-qq-helper.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

async function digest(root) {
  const hash=crypto.createHash('sha256');
  async function walk(directory,relative=''){
    for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
      const rel=path.join(relative,entry.name);
      if(entry.isSymbolicLink())throw new Error('Plugin source cannot contain links');
      if(entry.isDirectory())await walk(path.join(directory,entry.name),rel);
      else if(entry.isFile()){hash.update(rel.split(path.sep).join('/'));hash.update(await fs.readFile(path.join(directory,entry.name)));}
    }
  }
  await walk(root);return hash.digest('hex');
}
export async function installAdapter({projectRoot,instanceRoot,sourceDirectory=path.join(projectRoot,'plugins/companion-adapter')}) {
  await assertOffline(instanceRoot);
  const control=path.join(instanceRoot,'host.json');
  try{const owner=JSON.parse(await fs.readFile(control,'utf8'));try{process.kill(owner.pid,0);throw new Error('Stop the instance before installing its adapter');}catch(error){if(error.code!=='ESRCH')throw error;}}catch(error){if(error.code!=='ENOENT')throw error;}
  const profile=path.join(instanceRoot,'dsh-home/profiles/web');
  const manifest=JSON.parse(await fs.readFile(path.join(sourceDirectory,'package.json'),'utf8'));
  const name=manifest.name,version=manifest.version;
  const filename=`${name.replace(/^@/,'').replaceAll('/','-')}-${version}.tgz`;
  const artifactDir=path.join(profile,'.friend-packages'),artifact=path.join(artifactDir,filename),recordFile=path.join(artifactDir,'adapter-install.json');
  const sourceDigest=await digest(sourceDirectory);
  const old=JSON.parse(await fs.readFile(recordFile,'utf8').catch(error=>{if(error.code==='ENOENT')return'null';throw error;}));
  const currentPackage=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));
  if(old?.version===version&&old.sourceDigest!==sourceDigest)throw new Error('Adapter source changed under an installed version; bump its package version before updating');
  const packageSpec=`file:.friend-packages/${filename}`;
  const same=old?.sourceDigest===sourceDigest&&old?.version===version&&currentPackage.dependencies?.[name]===packageSpec&&await fs.readFile(artifact).then(bytes=>crypto.createHash('sha256').update(bytes).digest('hex')===old.sha256,()=>false);
  const node=process.execPath,nodeDir=path.dirname(node);
  const pnpm=path.join(projectRoot,'.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs');
  const env={...process.env,DSH_HOME:path.join(instanceRoot,'dsh-home'),PATH:[nodeDir,path.join(projectRoot,'.tools/package-manager/node_modules/.bin'),process.env.PATH??''].join(path.delimiter),npm_config_cache:path.join(projectRoot,'.work/npm-cache')};
  const store=path.join(projectRoot,'.work/pnpm-store');
  const activityConsole=await installActivityConsole({projectRoot,instanceRoot,sourceDirectory:path.join(path.dirname(sourceDirectory),'activity-console')});
  const scheduler=await installScheduler({projectRoot,instanceRoot,sourceDirectory:path.join(path.dirname(sourceDirectory),'attention-scheduler')});
  const qqBridge=await installQQBridge({projectRoot,instanceRoot,sourceDirectory:path.join(path.dirname(sourceDirectory),'qq-bridge')});
  const bilibiliTool=await installBilibiliTool({projectRoot,instanceRoot,sourceDirectory:path.join(path.dirname(sourceDirectory),'bilibili-tool')});
  if(!same){
    await fs.mkdir(artifactDir,{recursive:true});
    const packed=JSON.parse(execFileSync(node,[path.join(nodeDir,'node_modules/npm/bin/npm-cli.js'),'pack','--json','--pack-destination',artifactDir],{cwd:sourceDirectory,env,encoding:'utf8',windowsHide:true,timeout:60000,stdio:['ignore','pipe','pipe']}));
    if(packed[0]?.filename!==filename)throw new Error('Unexpected packed adapter artifact');
    const cli=path.join(projectRoot,'node_modules/@deepseek-ai/dsh/lib/bin.js');
    execFileSync(node,[cli,'plugin','--profile','web','add',packageSpec,'--save-exact','--store-dir',store,'--fetch-timeout','60000','--fetch-retries','1'],{cwd:profile,env,encoding:'utf8',windowsHide:true,timeout:180000,stdio:['ignore','pipe','pipe']});
    const profilePackage=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));
    // Keep the artifact path relative to the profile, so instance backups remain relocatable.
    if(profilePackage.dependencies[name]!==packageSpec){
      profilePackage.dependencies[name]=packageSpec;
      await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(profilePackage,null,2)+'\n');
      execFileSync(node,[pnpm,'--dir',profile,'install','--no-frozen-lockfile','--store-dir',store,'--config.confirmModulesPurge=false'],{cwd:profile,env,encoding:'utf8',windowsHide:true,timeout:180000,stdio:['ignore','pipe','pipe']});
    }
    const bytes=await fs.readFile(artifact);
    await fs.writeFile(recordFile,JSON.stringify({schema:'ai-friend-adapter-install/1',version,sourceDigest,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),artifact:filename},null,2)+'\n');
  }
  const require=createRequire(await fs.realpath(path.join(projectRoot,'node_modules/@deepseek-ai/dsh/package.json')));
  const yaml=require('js-yaml'),patchFile=path.join(profile,'cordis.patch.yml');
  const patches=yaml.load(await fs.readFile(patchFile,'utf8'));
  const preset=patches.flatMap(row=>row.insert??[]).find(row=>row.id==='preset-companion');
  if(!preset?.config?.plugins)throw new Error('Companion preset was not found; existing presets were not replaced');
  let presetChanged=false;
  if(!preset.config.plugins.some(row=>row.id==='friend-interaction')){
    preset.config.plugins.push({id:'friend-interaction',name:name+'/agent'});presetChanged=true;
  }
  if(!preset.config.plugins.some(row=>row.id==='friend-bilibili-interaction')){
    preset.config.plugins.push({id:'friend-bilibili-interaction',name:'@ai-friend/bilibili-tool/agent'});presetChanged=true;
  }
  if(["空白个人描述与本地记忆；情绪和成长模块尚待开发。","空白起点、本地记忆、自我成长与只读记忆整理预演。","空白起点、本地记忆、自我成长、整理预演与可恢复提案应用。"].includes(preset.config.description)){preset.config.description="空白起点、本地记忆、自我成长与可恢复的夜间增量整理。";presetChanged=true;}
  let friend=patches.find(row=>row.id==='friend-adapter');
  if(!friend){friend={id:'friend-adapter',config:{}};patches.push(friend);}
  friend.config??={};
  if(friend.config.nightly===undefined){friend.config.nightly={enabled:true,time:'02:00',timeZone:'Asia/Shanghai'};presetChanged=true;}
  if(friend.config.bilibiliInbox===undefined){friend.config.bilibiliInbox={enabled:true};presetChanged=true;}
  if(friend.config.bilibiliInbox?.dailyTurns===undefined){friend.config.bilibiliInbox.dailyTurns=0;presetChanged=true;}
  if(friend.config.bilibiliSocial===undefined){friend.config.bilibiliSocial={enabled:true,outgoing:true,learning:true};presetChanged=true;}
  const mnemon=patches.find(row=>row.id==='mnemon');
  if(mnemon?.config?.memoryView?.strategyTypeId==='default-three-tier'){
    mnemon.config.memoryView.strategyTypeId='friend-three-tier';presetChanged=true;
  }
  if(presetChanged)await fs.writeFile(patchFile,yaml.dump(patches,{lineWidth:120,noRefs:true}));
  const qqHelper=await installQQHelper({projectRoot,instanceRoot});
  return {name,version,installed:!same,sourceDigest,profile,scheduler,qqBridge,bilibiliTool,activityConsole,qqHelper};
}
if(pathToFileURL(path.resolve(process.argv[1]??'')).href===import.meta.url){
  const {projectRoot,instanceRoot}=await import('./paths.mjs');
  console.log(JSON.stringify(await installAdapter({projectRoot,instanceRoot})));
}
