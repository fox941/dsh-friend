import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJson,json,noLinks,walk} from './migration-files.mjs';
import {assertOffline} from './archive.mjs';
export async function initializeFresh(project,id){
 project=path.resolve(project);const root=path.join(project,'runtime/dev'),state=await readJson(path.join(project,'.fresh-install.json'));
 if(state.schema!=='ai-friend/fresh-install/1'||state.id!==id||state.target!==project||!['installing','install_failed'].includes(state.phase))throw Error('只允许在本次空白安装流程初始化新身份');
 await assertOffline(root);await noLinks(root);const origin=path.join(root,'fresh-origin.json');
 const existing=await readJson(origin).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(existing&&existing.packageId!==id)throw Error('目标有其他来源的角色，未初始化');
 const dbFile=path.join(root,'companion/companion.sqlite');
 if(!existing&&await fs.stat(dbFile).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('目标已经有身份数据库，未重建角色');
 for(const name of ['memory','workspace','channels','dsh-home/sessions']){const dir=path.join(root,name);await noLinks(dir);const files=await fs.stat(dir).then(()=>walk(dir),e=>{if(e.code==='ENOENT')return [];throw e;});if(files.length)throw Error('空白初始化发现已有记忆、会话、资料或平台凭据，未清除任何文件');}
 await fs.mkdir(root,{recursive:true});if(!existing)await fs.writeFile(origin,json({schema:'ai-friend/fresh-origin/1',packageId:id,createdAt:new Date().toISOString()}),{flag:'wx'});
 const {Journal}=await import(pathToFileURL(path.join(project,'plugins/companion-adapter/src/journal.js'))),{GrowthStore}=await import(pathToFileURL(path.join(project,'plugins/companion-adapter/src/growth-store.js')));
 const journal=new Journal(path.join(root,'companion'));let identity;
 try{
  const growth=new GrowthStore(journal);for(const table of ['growth_events','growth_versions','growth_batches','growth_heads'])if(journal.db.prepare('SELECT count(*) n FROM '+table).get().n)throw Error('目标有已有成长记录，拒绝将其标为空白');
  if(growth.revision()!==0)throw Error('目标已有状态版本，未覆盖');identity=growth.meta('identity');
 }finally{journal.close();}
 for(const name of ['memory','workspace'])await fs.mkdir(path.join(root,name),{recursive:true});
 return {identity,blank:true,started:false};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{console.log(JSON.stringify(await initializeFresh(path.resolve(import.meta.dirname,'..'),process.argv[2])));}
 catch{console.error('空白身份初始化未完成；保留本次安装目录和原包，不清除数据。');process.exitCode=1;}
}
