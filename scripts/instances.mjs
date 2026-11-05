import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
export function resolveInstance(project,selection='main'){
  const name=String(selection).toLowerCase(),id=name==='dev'?'main':name;
  if(!['main','test'].includes(id))throw Error('实例必须为 main 或 test；未退回默认实例');
  const directory=id==='main'?'dev':'test',root=path.resolve(project,'runtime',directory);
  return Object.freeze({id,directory,label:id==='main'?'主实例':'隔离测试实例',root,project:path.resolve(project),host:id==='main'?'127.0.0.1':'127.0.0.2',port:id==='main'?3080:3081,backupRoot:path.resolve(project,'backups',directory),maintenanceLock:path.resolve(project,'runtime','.test-maintenance.lock')});
}
export const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
export function noLinksSync(file){let current=path.resolve(file);while(true){try{if(fs.lstatSync(current).isSymbolicLink())throw Error('实例数据和安全配置不能经过目录联接或符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(current);if(parent===current)break;current=parent;}}
export function readLocalJson(file){noLinksSync(file);const s=fs.statSync(file);if(!s.isFile()||s.size>1024*1024)throw Error('实例控制文件无效');return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\ufeff/,''));}
export function guardDigest(project){return digest(['package.json','src/index.js'].map(file=>fs.readFileSync(path.join(project,'plugins/test-isolation',file))).reduce((a,b)=>Buffer.concat([a,b]),Buffer.alloc(0)));}
export function identityAt(root){noLinksSync(root);const db=new DatabaseSync(path.join(root,'companion/companion.sqlite'),{readOnly:true,timeout:1000});try{return db.prepare("SELECT value FROM growth_meta WHERE key='identity'").get()?.value;}finally{db.close();}}
export function assertTestSafety(descriptor,{allowMaintenanceToken}={}){
  if(descriptor.id!=='test')return null;
  let maintaining=false;
  noLinksSync(descriptor.root);
  for(const directory of ['memory','companion','workspace','dsh-home','channels','operations'])noLinksSync(path.join(descriptor.root,directory));
  if(fs.existsSync(descriptor.maintenanceLock)){
    const lock=readLocalJson(descriptor.maintenanceLock);
    if(!allowMaintenanceToken||lock.token!==allowMaintenanceToken||lock.pid!==process.pid)throw Error('测试实例正在初始化或恢复，未启动；主实例不受影响');
    maintaining=true;
  }
  const restoreFile=path.join(descriptor.project,'runtime/.test-restore.json');
  if(fs.existsSync(restoreFile)&&readLocalJson(restoreFile).phase!=='ready'&&!maintaining)throw Error('测试恢复未完成，请用同一快照继续 Restore-Test；主实例不受影响');
  const marker=readLocalJson(path.join(descriptor.root,'isolation.json'));
  if(marker.schema!=='ai-friend/test-instance/1'||marker.instance!=='test'||marker.phase!=='ready'||path.resolve(marker.root).toLowerCase()!==descriptor.root.toLowerCase()||marker.identity!==identityAt(descriptor.root))throw Error('测试实例身份或初始化状态不符，请运行 Setup-Test');
  if(marker.guardDigest!==guardDigest(descriptor.project))throw Error('测试隔离守卫源码已变化，请停止测试并重新运行 Setup-Test');
  noLinksSync(path.join(descriptor.root,'dsh-home/profiles/web/cordis.yml'));
  for(const [file,hash]of Object.entries(marker.configHashes??{})){
    const configFile=path.join(descriptor.root,'dsh-home/profiles/web',file);noLinksSync(configFile);
    if(!['cordis.patch.yml','package.json','pnpm-lock.yaml'].includes(file)||digest(fs.readFileSync(configFile))!==hash)throw Error('测试配置已变化，请停止测试并通过 Setup-Test 重新验证');
  }
  if(Object.keys(marker.configHashes??{}).length!==3)throw Error('测试配置校验清单不完整');
  for(const file of ['channels/qq/config.local.json','channels/bilibili/credentials.local.json','channels/bilibili/web-session.local.json','channels/bilibili/social.local.json'])if(fs.existsSync(path.join(descriptor.root,file)))throw Error('测试实例出现真实平台配置或凭据，保持关闭；不会连接账号');
  const credentials=readLocalJson(path.join(descriptor.root,'credentials.local.json'));
  if(Object.keys(credentials).some(k=>k!=='DEEPSEEK_API_KEY')||typeof credentials.DEEPSEEK_API_KEY!=='string'||!credentials.DEEPSEEK_API_KEY.trim())throw Error('测试实例需要自己的模型凭据文件，不读取主实例回退');
  return marker;
}
export function requireMain(operation,selection=process.env.AI_FRIEND_INSTANCE??'main'){
  if(resolveInstance('.',selection).id!=='main')throw Error(operation+' 仅限主实例；测试实例禁止平台连接或主角色迁移');
}
