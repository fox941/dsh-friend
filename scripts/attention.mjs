import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {instanceRoot} from './paths.mjs';
const require=createRequire(path.join(instanceRoot,'dsh-home/profiles/web/package.json')),api=await import(pathToFileURL(require.resolve('@ai-friend/attention-scheduler/offline')));
console.log(JSON.stringify(api.readAttentionStatus(instanceRoot),null,2));
