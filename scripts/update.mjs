import path from 'node:path';import fs from 'node:fs/promises';
import {projectRoot} from './paths.mjs';import {requireMain} from './instances.mjs';
import {createUpdate,verifyUpdate} from './update-package.mjs';import {savePreview,applyUpdate,rollbackUpdate} from './update-core.mjs';import {buildProfile,previewRelease,runtimeHooks,compressBundle} from './update-ops.mjs';import {readJson,json} from './migration-files.mjs';
const [action,...args]=process.argv.slice(2),value=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
try{
 requireMain('代码升级维护');const bundle=value('--bundle');
 if(action==='pack')console.log(json(await createUpdate({project:projectRoot,destination:value('--output')??path.join(projectRoot,'releases/updates'),buildProfile:target=>buildProfile(projectRoot,target),compress:(root,zip)=>compressBundle(projectRoot,root,zip)})));
 else if(action==='verify'&&bundle){const r=await verifyUpdate(bundle);console.log(json({verified:true,id:r.manifest.id,digest:r.digest,containsRuntime:false,files:r.manifest.files.length}));}
 else if(action==='preview'&&bundle)console.log(json(await savePreview({project:projectRoot,bundle,runPreview:v=>previewRelease(projectRoot,v)})));
 else if(action==='apply'&&bundle)console.log(json(await applyUpdate({project:projectRoot,bundle,hooks:runtimeHooks(projectRoot)})));
 else if(action==='rollback')console.log(json(await rollbackUpdate({project:projectRoot,transaction:value('--transaction'),hooks:runtimeHooks(projectRoot)})));
 else if(action==='status'){const optional=async file=>readJson(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});const pending=await optional(path.join(projectRoot,'.update-pending.json')),last=await optional(path.join(projectRoot,'.work/update-last.json'));console.log(json({upgrading:!!pending,pending:pending?{id:pending.id,phase:pending.phase,transaction:pending.transaction}:null,last}));}
 else throw Error('用法：update.mjs pack | verify/preview/apply --bundle <完整解压目录> | status | rollback [--transaction <事务目录>]');
}catch(e){console.error(e.message);console.error('失败时不要删除角色数据或升级检查点；先查看 Update-Status.cmd，同包重试或进行受保护回退。');process.exitCode=1;}
