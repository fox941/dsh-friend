import path from 'node:path';
import {withMemoryStorageLock} from 'dsh-mnemon/extension-sdk';
import {createRuntimeMemorySource} from 'dsh-mnemon-source-runtime';
import {policyReader} from './policy.js';
import {NativeClient} from './native-client.js';
import {CorrectionController} from './controller.js';
import {GrowthController} from './growth.js';
import {RuntimeWriter} from './apply-runtime.js';
import {ApplyBackend} from './apply-backend.js';
import {ApplicationController} from './apply.js';
import {ProtectionController} from './protection.js';
export {undoBatch} from './protection-undo.js';
export async function openProtection(instance,{assertOffline,config={}}={}){
  if(typeof assertOffline!=='function')throw new Error('离线保护入口缺少停机核验');await assertOffline();
  const memoryDir=path.join(instance,'memory'),directory=path.join(instance,'companion'),policy=policyReader({home:path.join(instance,'dsh-home'),memoryDir}),client=new NativeClient({memoryDir,policy});
  const correction=new CorrectionController({directory,client,policy,memoryDir,lock:withMemoryStorageLock}),growth=new GrowthController({journal:correction.journal,serial:(fn,signal)=>correction.serial(fn,signal)}),runtime=new RuntimeWriter({memoryDir,policy,createSource:createRuntimeMemorySource}),backend=new ApplyBackend({runtime,correction,growth});
  const applications=new ApplicationController({journal:correction.journal,backend,growth,policy,workspace:path.join(instance,'workspace'),preview:{config:{},store:{get:()=>null}}});
  const protection=new ProtectionController({journal:correction.journal,applications,backend,memoryDir,directory,config});applications.protection=protection;
  return {protection,async close(){await applications.close();await growth.close();await correction.close();}};
}
