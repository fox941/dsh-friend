import path from 'node:path';
import {projectRoot,selectedInstance} from './paths.mjs';
import {setupTest,restoreTest} from './test-instance.mjs';
import {runChild} from './migration.mjs';
const [action,arg]=process.argv.slice(2);
try{
  if(action==='describe'){console.log(JSON.stringify({...selectedInstance},null,2));}
  else{
    if(selectedInstance.id!=='test')throw Error('测试维护命令必须显式选择 test，不会修改主实例');
    await runChild(process.execPath,[path.join(projectRoot,'scripts/runtime.mjs'),'stop'],{cwd:projectRoot,timeoutMs:45000});
    if(action==='setup')console.log(JSON.stringify(await setupTest({project:projectRoot}),null,2));
    else if(action==='restore'&&arg)console.log(JSON.stringify(await restoreTest({project:projectRoot,snapshot:path.resolve(arg)}),null,2));
    else throw Error('用法：instance.mjs describe | setup | restore <测试备份目录>');
  }
}catch(error){console.error(error.message);console.error('操作对象：'+selectedInstance.label+' '+selectedInstance.root+'。未操作其他实例。');process.exitCode=1;}
