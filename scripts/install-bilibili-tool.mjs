import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';
import {assertOffline} from './archive.mjs';

async function digest(root){const hash=crypto.createHash('sha256');async function walk(directory,relative=''){for(const entry of(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){const rel=path.join(relative,entry.name);if(entry.isSymbolicLink())throw Error('Bilibili tool source cannot contain links');if(entry.isDirectory())await walk(path.join(directory,entry.name),rel);else if(entry.isFile()){hash.update(rel.split(path.sep).join('/'));hash.update(await fs.readFile(path.join(directory,entry.name)));}}}await walk(root);return hash.digest('hex');}
export async function installBilibiliTool({projectRoot,instanceRoot,sourceDirectory=path.join(projectRoot,'plugins/bilibili-tool')}){
 await assertOffline(instanceRoot);
 try{const owner=JSON.parse(await fs.readFile(path.join(instanceRoot,'host.json'),'utf8'));try{process.kill(owner.pid,0);throw Error('Stop the instance before installing its bilibili-tool');}catch(error){if(error.code!=='ESRCH')throw error;}}catch(error){if(error.code!=='ENOENT')throw error;}
 const profile=path.join(instanceRoot,'dsh-home/profiles/web'),manifest=JSON.parse(await fs.readFile(path.join(sourceDirectory,'package.json'),'utf8')),name=manifest.name,version=manifest.version;
 if(name!=='@ai-friend/bilibili-tool')throw Error('Unexpected bilibili tool package');
 const filename='ai-friend-bilibili-tool-'+version+'.tgz',artifactDir=path.join(profile,'.friend-packages'),artifact=path.join(artifactDir,filename),recordFile=path.join(artifactDir,'bilibili-tool-install.json'),sourceDigest=await digest(sourceDirectory),packageSpec='file:.friend-packages/'+filename;
 const old=JSON.parse(await fs.readFile(recordFile,'utf8').catch(error=>{if(error.code==='ENOENT')return 'null';throw error;})),current=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));
 if(old?.version===version&&old.sourceDigest!==sourceDigest)throw Error('Bilibili tool source changed under an installed version; bump the package version');
 const same=old?.version===version&&old.sourceDigest===sourceDigest&&current.dependencies?.[name]===packageSpec&&await fs.readFile(artifact).then(bytes=>crypto.createHash('sha256').update(bytes).digest('hex')===old.sha256,()=>false);
 if(!same){
  await fs.mkdir(artifactDir,{recursive:true});const node=process.execPath,nodeDir=path.dirname(node),pnpm=path.join(projectRoot,'.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs'),store=path.join(projectRoot,'.work/pnpm-store'),env={...process.env,DSH_HOME:path.join(instanceRoot,'dsh-home'),PATH:[nodeDir,path.join(projectRoot,'.tools/package-manager/node_modules/.bin'),process.env.PATH??''].join(path.delimiter),npm_config_cache:path.join(projectRoot,'.work/npm-cache')};
  const packed=JSON.parse(execFileSync(node,[path.join(nodeDir,'node_modules/npm/bin/npm-cli.js'),'pack','--json','--pack-destination',artifactDir],{cwd:sourceDirectory,env,windowsHide:true,encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']}));if(packed[0]?.filename!==filename)throw Error('Unexpected bilibili tool artifact');
  execFileSync(node,[path.join(projectRoot,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'plugin','--profile','web','add',packageSpec,'--save-exact','--store-dir',store,'--fetch-timeout','60000','--fetch-retries','1'],{cwd:profile,env,windowsHide:true,encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});
  const patched=JSON.parse(await fs.readFile(path.join(profile,'package.json'),'utf8'));let needInstall=patched.dependencies?.[name]!==packageSpec;
  if(needInstall){patched.dependencies??={};patched.dependencies[name]=packageSpec;}
  // The DSH CLI does not maintain dsh.profile.bundles; keep the bundle list explicit and ordered.
  const bundles=patched.dsh?.profile?.bundles;if(Array.isArray(bundles)&&!bundles.includes(name)){bundles.push(name);needInstall=true;}
  if(needInstall){await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(patched,null,2)+'\n');execFileSync(node,[pnpm,'--dir',profile,'install','--no-frozen-lockfile','--store-dir',store,'--config.confirmModulesPurge=false'],{cwd:profile,env,windowsHide:true,encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});}
  await fs.writeFile(recordFile,JSON.stringify({schema:'ai-friend-bilibili-tool-install/1',version,sourceDigest,sha256:crypto.createHash('sha256').update(await fs.readFile(artifact)).digest('hex'),artifact:filename},null,2)+'\n');
 }
 const require=createRequire(await fs.realpath(path.join(projectRoot,'node_modules/@deepseek-ai/dsh/package.json'))),yaml=require('js-yaml'),file=path.join(profile,'cordis.patch.yml'),patches=yaml.load(await fs.readFile(file,'utf8'));
 if(!patches.some(p=>p.id==='friend-bilibili-tool')){patches.unshift({id:'friend-bilibili-tool',name});await fs.writeFile(file,yaml.dump(patches,{noRefs:true,lineWidth:120}));}
 return {name,version,installed:!same,sourceDigest};
}
