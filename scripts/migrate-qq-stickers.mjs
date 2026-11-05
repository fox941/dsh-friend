import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
import {instanceRoot} from './paths.mjs';import {requireMain} from './instances.mjs';import {acquireOfflineLease} from './protection-control.mjs';
requireMain('QQ共用表情迁移');const lease=await acquireOfflineLease(instanceRoot);
try{const require=createRequire(path.join(instanceRoot,'dsh-home/profiles/web/package.json')),{migrateQQStickers}=await import(pathToFileURL(require.resolve('@ai-friend/qq-bridge/sticker-migration')));console.log(JSON.stringify(await migrateQQStickers(instanceRoot,{assertOffline:lease.assertOffline}),null,2));}finally{await lease.close();}
