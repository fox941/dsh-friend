import fs from 'node:fs/promises';
import path from 'node:path';
/** Legacy path remains readable for old update/migration bundles. */
export async function qqHelperSource(project){
 const current=path.join(project,'plugins/qq-bridge/napcat/qq-social-helper'),legacy=path.join(project,'plugins/qq-social-helper');
 const exists=async p=>fs.lstat(p).then(s=>{if(s.isSymbolicLink()||!s.isDirectory())throw Error('QQ helper source must be a real directory');return true;},e=>{if(e.code==='ENOENT')return false;throw e;});
 const [hasCurrent,hasLegacy]=await Promise.all([exists(current),exists(legacy)]);
 if(hasCurrent&&hasLegacy)throw Error('QQ helper has two source directories; keep only one authoritative copy');
 return hasCurrent?current:hasLegacy?legacy:null;
}
