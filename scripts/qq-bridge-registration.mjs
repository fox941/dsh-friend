import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
/** Called by the offline installer and by a new host before it takes ownership. */
export async function ensureQQBridgeRegistration({project,profile,yaml}){
 const pkg=await fs.readFile(path.join(profile,'package.json'),'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
 if(!pkg?.dependencies?.['@ai-friend/qq-bridge'])return {required:false,changed:false};
 if(!yaml){const require=createRequire(await fs.realpath(path.join(project,'node_modules/@deepseek-ai/dsh/package.json')));yaml=require('js-yaml');}
 const file=path.join(profile,'cordis.patch.yml'),raw=await fs.readFile(file,'utf8'),patches=yaml.load(raw);
 if(!Array.isArray(patches))throw Error('QQ bridge registration requires an array profile patch');
 const rows=patches.flatMap(p=>[p,...(p.insert??[])]);
 if(rows.some(p=>p.name==='@ai-friend/qq-bridge'))return {required:true,changed:false};
 if(rows.some(p=>p.id==='friend-qq-bridge'))throw Error('QQ bridge registration ID is already occupied');
 patches.unshift({id:'friend-qq-bridge',name:'@ai-friend/qq-bridge'});
 const temporary=file+'.qq-bridge-'+crypto.randomUUID()+'.tmp';
 try{await fs.writeFile(temporary,yaml.dump(patches,{noRefs:true,lineWidth:120}),{flag:'wx'});if(await fs.readFile(file,'utf8')!==raw)throw Error('Profile changed during QQ bridge registration');await fs.rename(temporary,file);}finally{await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 return {required:true,changed:true};
}
