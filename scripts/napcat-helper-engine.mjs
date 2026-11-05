import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {noLinks} from './migration-files.mjs';

export const ENGINE_SHA256='7c66d0239d7effe73ab6e4920eddef732a8066fb47cd19539541c72055c5f0aa';
const anchor='  "napcat-plugin-qce"\n]), gge = [';
const replacement='  "napcat-plugin-qce",\n  "ai-friend-social-helper"\n]), gge = [';
const workerAnchor='return OL.endsWith(".mjs") ? xe.join(oE, "napcat.mjs") : xe.join(oE, "napcat.js");';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

export function compileHelperEngine(bytes,expectedDigest=ENGINE_SHA256){
  if(sha(bytes)!==expectedDigest)throw Error('NapCat original engine differs from the pinned 4.18.41 build; helper compatibility needs review');
  const source=bytes.toString('utf8');
  if(source.split(anchor).length!==2||source.split(workerAnchor).length!==2)throw Error('NapCat helper compatibility anchor is not unique');
  // Keep NapCat's own worker restart mechanism on this same derived entry.
  return Buffer.from(source.replace(anchor,replacement).replace(workerAnchor,'return OL;'));
}

export async function installHelperEngine(engineDirectory,{expectedDigest=ENGINE_SHA256}={}){
  const original=path.join(engineDirectory,'napcat.mjs'),entry=path.join(engineDirectory,'napcat.ai-friend.mjs'),record=path.join(engineDirectory,'ai-friend-helper-engine.json');
  for(const file of [original,entry,record])await noLinks(file);
  const source=await fs.readFile(original),compiled=compileHelperEngine(source,expectedDigest);
  const existing=await fs.readFile(entry).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(existing&&sha(existing)!==sha(compiled))throw Error('Existing NapCat helper engine differs; preserved without overwriting');
  if(!existing)await fs.writeFile(entry,compiled,{flag:'wx'});
  const metadata={schema:'ai-friend/napcat-helper-engine/1',napcatVersion:'4.18.41',original:'napcat.mjs',originalSha256:sha(source),entry:path.basename(entry),compiledSha256:sha(compiled),addedPlugin:'ai-friend-social-helper',workerUsesSameEntry:true,originalPreserved:true};
  const previous=await fs.readFile(record,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
  if(previous&&JSON.stringify(previous)!==JSON.stringify(metadata))throw Error('Existing NapCat helper engine record differs');
  if(!previous)await fs.writeFile(record,JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
  return {entry,...metadata};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const project=path.resolve(import.meta.dirname,'..');
  try{const result=await installHelperEngine(path.join(project,'.tools/napcat-v4.18.41'));console.log(JSON.stringify({entry:path.join(project,'.tools/napcat-v4.18.41',result.entry),originalPreserved:result.originalPreserved}));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
