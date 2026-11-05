import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
import {instanceRoot} from './paths.mjs';
const require=createRequire(path.join(instanceRoot,'dsh-home/profiles/web/package.json')),{inspectSocialMemory,inspectSocialChanges}=await import(pathToFileURL(require.resolve('@ai-friend/qq-bridge/social-memory-inspect'))),{readQQSettings,qqId}=await import(pathToFileURL(require.resolve('@ai-friend/qq-bridge/config')));
const [action='status',value]=process.argv.slice(2);try{
if(['changes','undo'].includes(action)){
 if(value&&!/^[a-f0-9-]{36}$/i.test(value))throw Error('Need a complete batch ID');
 if(action==='changes')console.log(JSON.stringify(inspectSocialChanges(path.join(instanceRoot,'companion/companion.sqlite'),value),null,2));
 else{
  if(!value)throw Error('Need a complete batch ID');
  const {acquireOfflineLease}=await import('./protection-control.mjs'),lease=await acquireOfflineLease(instanceRoot);
  let journal;try{
   const base=path.dirname(require.resolve('@ai-friend/companion-adapter')),
    {Journal}=await import(pathToFileURL(path.join(base,'journal.js'))),{PlatformStore}=await import(pathToFileURL(path.join(base,'platform-store.js'))),
    {createSocialSnapshot}=await import(pathToFileURL(path.join(base,'social-snapshot.js'))),{QQSocialMemory}=await import(pathToFileURL(require.resolve('@ai-friend/qq-bridge/social-memory')));
   journal=new Journal(path.join(instanceRoot,'companion'));const config=await readQQSettings(instanceRoot),memory=new QQSocialMemory({journal,eventStore:new PlatformStore(journal),enabled:()=>false,currentAccount:()=>config.botQQ});memory.host={capture:createSocialSnapshot({journal})};
   try{await lease.assertOffline();console.log(JSON.stringify(await memory.lifecycle.undo(value,AbortSignal.timeout(60000)),null,2));}finally{await memory.close();}
  }finally{journal?.close();await lease.close();}
 }
}else{let options={};if(['group','friend'].includes(action)){const config=await readQQSettings(instanceRoot);if(!config.configured)throw Error('QQ is not configured');options.thread=(action==='group'?'qq-group:':'qq-private:')+config.botQQ+':'+qqId(value);}else if(action==='note'){if(!/^[a-f0-9-]{36}$/i.test(value??''))throw Error('Need a complete note ID');options.noteId=value;}else if(action!=='status')throw Error('Usage: social-memory.mjs status | group <QQ group> | friend <QQ ID> | note <note ID> | changes [batch ID] | undo <batch ID>');console.log(JSON.stringify(inspectSocialMemory(path.join(instanceRoot,'companion/companion.sqlite'),options),null,2));}}catch(e){console.error(e.message);process.exitCode=1;}
