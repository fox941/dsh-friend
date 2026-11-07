import { connectDev } from './dev-client.mjs';
import {selectedInstance,instanceRoot} from './paths.mjs';
import {initializeLocalMemory} from './memory-readiness.mjs';

const client = await connectDev();
const result=await initializeLocalMemory({root:instanceRoot,client,label:selectedInstance.id==='test'?'隔离测试记忆':'陪伴记忆'});
console.log(JSON.stringify(result,null,2));
if(!result.ready)process.exitCode=1;
