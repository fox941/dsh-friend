import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolveInstance,readLocalJson,noLinksSync,identityAt,guardDigest,digest,assertTestSafety} from './instances.mjs';
import {assertOffline,createSnapshot,verifySnapshot} from './archive.mjs';
import {acquireOfflineLease} from './protection-control.mjs';
import {copyRecord,readJson,json,sha,verifyRecords} from './migration-files.mjs';
import {runChild} from './migration.mjs';
import {assertNoUpdate} from './update-lock.mjs';
export async function maintenance(descriptor,purpose){
  noLinksSync(descriptor.maintenanceLock);await fs.mkdir(path.dirname(descriptor.maintenanceLock),{recursive:true});const file=descriptor.maintenanceLock,token=crypto.randomUUID();
  const old=await readJson(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(old){if(!Number.isSafeInteger(old.pid)||old.pid<1)throw Error('测试维护锁无效');try{process.kill(old.pid,0);throw Error('另一个测试实例维护命令仍在运行');}catch(e){if(e.code!=='ESRCH')throw e;}await fs.unlink(file);}
  await fs.writeFile(file,json({schema:'ai-friend/test-maintenance/1',pid:process.pid,token,purpose}),{flag:'wx'});
  return {token,close:async()=>{const r=await readJson(file);if(r.token!==token||r.pid!==process.pid)throw Error('测试维护锁变化');await fs.unlink(file);}};
}
// DSH rewrites cordis.yml on boot and teardown; only patch/package/lock are inputs.
const configFiles=['cordis.patch.yml','package.json','pnpm-lock.yaml'];
const write=async(file,value)=>{noLinksSync(file);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='string'?value:json(value));};
export function sanitizeTestPatch(rows,{project,root}){
  const known=new Set(['friend-scheduler','friend-qq-bridge','friend-bilibili-tool','friend-activity-console','system-prompt','agent-preset-registry','agent-default-model','mnemon-bundle','mnemon','mnemon-source-skills','mnemon-source-memory-spaces','ui-settings-general','friend-adapter']);
  const source=structuredClone(rows).filter(r=>known.has(r.id)||r.insert?.some(p=>p.id==='preset-companion'));
  const row=id=>{let r=source.find(p=>p.id===id);if(!r){r={id};source.push(r);}return r;};
  const mnemon=row('mnemon');mnemon.disabled=false;mnemon.config={...mnemon.config,storageScope:'custom',dataDir:path.join(root,'memory'),runtimeUserScope:'storage',cliPath:path.join(project,'.tools/mnemon-0.2.13/mnemon.exe'),syncEnabled:false,embedding:{enabled:false},idleReview:{enabled:false,maxPerSession:0},skills:{evolution:false,allowCreate:false,allowUpdate:false,autoBacktest:false,hints:false,sidebar:false}};
  const friend=row('friend-adapter');friend.config={...friend.config,configuredChannels:['web'],platforms:{enabled:false,groups:[],friends:false,autonomousJoin:false},nightly:{...friend.config?.nightly,enabled:false},attention:{...friend.config?.attention,enabled:false},activities:{...friend.config?.activities,automatic:false},bilibiliInbox:{enabled:false,dailyTurns:0},bilibiliSocial:{enabled:false,outgoing:false,learning:false},video:{...friend.config?.video,enabled:false}};
  row('system-prompt').config={includeHarnessIdentity:false,personaPrefix:'',personaSuffix:''};
  row('mnemon-source-skills').disabled=true;
  row('mnemon-source-memory-spaces').config={providers:[{use:'dsh-mnemon-provider-mnemon-native',instanceId:'mnemon-native'}]};
  const preset=source.flatMap(r=>r.insert??[]).find(p=>p.id==='preset-companion');if(!preset?.config?.plugins)throw Error('未找到陪伴预设，不能创建测试实例');
  for(const r of source)if(r.insert)r.insert=r.insert.filter(p=>p.id==='preset-companion');
  preset.config.name='测试·陪伴（独立身份）';preset.config.description='隔离测试数据与身份；平台和外部工具关闭。';
  const safePreset=new Set(['persona','time-context','compaction','tool-ask-user','friend-interaction']);preset.config.plugins=preset.config.plugins.filter(p=>safePreset.has(p.id));
  const persona=preset.config.plugins.find(p=>p.id==='persona');if(persona)persona.config={prefix:'',suffix:''};
  source.unshift({insert:[{id:'test-isolation',name:pathToFileURL(path.join(project,'plugins/test-isolation/src/index.js')).href}]});return source;
}
export async function setupTest({project,install=true}){
  await assertNoUpdate(project);
  const pendingFile=path.join(project,'runtime/.test-restore.json');noLinksSync(pendingFile);const pending=await readJson(pendingFile).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(pending&&pending.phase!=='ready')throw Error('测试恢复未完成，请用同一快照继续 Restore-Test');
  const descriptor=resolveInstance(project,'test'),main=resolveInstance(project,'main');noLinksSync(descriptor.root);await assertOffline(descriptor.root);const lock=await maintenance(descriptor,'setup');
  try{
    const existing=await fs.readdir(descriptor.root).catch(e=>{if(e.code==='ENOENT')return[];throw e;});let prior=null;
    if(existing.length){prior=readLocalJson(path.join(descriptor.root,'isolation.json'));if(prior.schema!=='ai-friend/test-instance/1'||prior.instance!=='test'||path.resolve(prior.root).toLowerCase()!==descriptor.root.toLowerCase()||prior.identity&&prior.identity!==identityAt(descriptor.root))throw Error('测试目录已有未识别数据，未覆盖');}
    await write(path.join(descriptor.root,'isolation.json'),{...prior,schema:'ai-friend/test-instance/1',instance:'test',root:descriptor.root,phase:'initializing',identity:prior?.identity??null,createdAt:prior?.createdAt??new Date().toISOString()});
    const profile=path.join(descriptor.root,'dsh-home/profiles/web'),source=prior?.identity?profile:path.join(main.root,'dsh-home/profiles/web');noLinksSync(profile);await fs.mkdir(profile,{recursive:true});
    if(!prior?.identity){
      for(const file of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])await fs.copyFile(path.join(source,file),path.join(profile,file));
      await fs.cp(path.join(source,'.friend-packages'),path.join(profile,'.friend-packages'),{recursive:true});
      await fs.copyFile(path.join(source,'cordis.patch.yml'),path.join(profile,'cordis.patch.yml'));
    }
    const pkg=await readJson(path.join(profile,'package.json')),expected=['@ai-friend/attention-scheduler','@ai-friend/companion-adapter','@ai-friend/qq-bridge','@ai-friend/bilibili-tool','dsh-mnemon'];
    if(Object.keys(pkg.dependencies??{}).some(n=>!expected.includes(n))||expected.some(n=>!pkg.dependencies?.[n]))throw Error('测试 profile 存在未审核的依赖，未开放插件或平台');
    const bundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-mnemon','@ai-friend/companion-adapter','@ai-friend/attention-scheduler','@ai-friend/qq-bridge','@ai-friend/bilibili-tool'];
    if(JSON.stringify(pkg.dsh?.profile?.bundles)!==JSON.stringify(bundles))throw Error('测试 profile 的基础 bundle 不匹配');
    const require=createRequire(await fs.realpath(path.join(project,'node_modules/@deepseek-ai/dsh/package.json'))),yaml=require('js-yaml'),rows=yaml.load(await fs.readFile(path.join(profile,'cordis.patch.yml'),'utf8'));
    await write(path.join(profile,'cordis.yml'),'# Isolated test profile: no primary runtime imports.\n[]\n');
    await write(path.join(profile,'cordis.patch.yml'),yaml.dump(sanitizeTestPatch(rows,{project:descriptor.project,root:descriptor.root}),{noRefs:true,lineWidth:120}));
    for(const dir of ['workspace','memory','companion','operations']){noLinksSync(path.join(descriptor.root,dir));await fs.mkdir(path.join(descriptor.root,dir),{recursive:true});}
    const credentials=path.join(descriptor.root,'credentials.local.json');
    if(!await fs.stat(credentials).then(()=>true,()=>false)){const sourceKey=readLocalJson(path.join(main.root,'credentials.local.json'));await write(credentials,{DEEPSEEK_API_KEY:sourceKey.DEEPSEEK_API_KEY});}
    if(typeof install==='function')await install(project,descriptor.root);
    else if(install){await installTestDependencies(project,descriptor.root);const {installAdapter}=await import('./install-adapter.mjs');await installAdapter({projectRoot:project,instanceRoot:descriptor.root});}
    const installed=path.join(profile,'node_modules/@ai-friend/companion-adapter/src'),{Journal}=await import(pathToFileURL(path.join(installed,'journal.js'))),{GrowthStore}=await import(pathToFileURL(path.join(installed,'growth-store.js')));
    const journal=new Journal(path.join(descriptor.root,'companion'));let identity;try{identity=new GrowthStore(journal).meta('identity');}finally{journal.close();}
    let mainIdentity;try{mainIdentity=identityAt(main.root);}catch{}if(identity===mainIdentity)throw Error('测试身份与主实例相同，未开放运行');
    const operationFile=path.join(descriptor.root,'operations/state.json');if(!prior?.identity)await write(operationFile,{schema:'ai-friend/runtime-state/1',identity,desiredRunning:false,attempts:[],nextAttemptAt:0});
    await write(path.join(descriptor.root,'bootstrap.json'),{schema:'ai-friend-bootstrap/1',configuredRoot:descriptor.root,createdAt:prior?.createdAt??new Date().toISOString(),instance:'test'});
    const configHashes={};for(const file of configFiles)configHashes[file]=digest(await fs.readFile(path.join(profile,file)));
    await write(path.join(descriptor.root,'isolation.json'),{schema:'ai-friend/test-instance/1',instance:'test',root:descriptor.root,phase:'ready',identity,guardDigest:guardDigest(project),configHashes,createdAt:prior?.createdAt??new Date().toISOString()});
    assertTestSafety(descriptor,{allowMaintenanceToken:lock.token});return {instance:'test',dataRoot:descriptor.root,identity,url:'http://'+descriptor.host+':'+descriptor.port,realPlatforms:false,mainIdentityUnchanged:true,existing:!!prior};
  }finally{await lock.close();}
}
export async function installTestDependencies(project,root){
  const pnpm=path.join(project,'.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs'),log=path.join(root,'logs/setup-test.log');
  await runChild(process.execPath,[pnpm,'--dir',path.join(root,'dsh-home/profiles/web'),'install','--frozen-lockfile','--store-dir',path.join(project,'.work/pnpm-store'),'--config.confirmModulesPurge=false','--fetch-timeout','60000','--fetch-retries','1'],{cwd:project,log,timeoutMs:900000});
}
export async function restoreTest({project,snapshot,install=installTestDependencies}){
  await assertNoUpdate(project);
  const descriptor=resolveInstance(project,'test');await verifySnapshot(snapshot);const manifest=await readJson(path.join(snapshot,'manifest.json'));
  if(manifest.instance?.id!=='test'||path.resolve(manifest.sourceRoot).toLowerCase()!==descriptor.root.toLowerCase())throw Error('这不是当前项目的测试备份，拒绝将主角色或其他实例导入测试区');
  const saved=readLocalJson(path.join(snapshot,'runtime/isolation.json'));if(saved.instance!=='test'||saved.identity!==identityAt(path.join(snapshot,'runtime')))throw Error('测试备份身份不一致');
  let mainIdentity;try{mainIdentity=identityAt(resolveInstance(project,'main').root);}catch{}if(saved.identity===mainIdentity)throw Error('备份身份与主实例相同，未恢复');
  await assertOffline(descriptor.root);const stateFile=path.join(project,'runtime/.test-restore.json');noLinksSync(stateFile);const lock=await maintenance(descriptor,'restore'),hash=sha(await fs.readFile(path.join(snapshot,'manifest.json'))),copyId=hash.slice(0,36);
  try{
    let state=await readJson(stateFile).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(state?.phase!=='ready'&&state&&state.digest!==hash)throw Error('上次测试恢复未完成，请用同一快照继续');
    if(state?.retired&&(!path.resolve(state.retired).startsWith(descriptor.backupRoot+path.sep)||!path.basename(state.retired).startsWith('retired-')))throw Error('测试恢复的归档路径越界');
    if(state?.retired)noLinksSync(state.retired);
    if(!state||state.phase==='ready'){
      state={digest:hash,identity:saved.identity,snapshot:path.resolve(snapshot),phase:'prepared',createdAt:new Date().toISOString()};
      const exists=await fs.stat(descriptor.root).then(()=>true,()=>false);
      if(exists){assertTestSafety(descriptor,{allowMaintenanceToken:lock.token});const lease=await acquireOfflineLease(descriptor.root);try{const backup=path.join(descriptor.backupRoot,'before-restore-'+crypto.randomUUID());await createSnapshot(descriptor.root,backup,{assertSourceOffline:lease.assertOffline,metadataProjectRoot:project});state.backup=backup;}finally{await lease.close();}}
      state.retired=path.join(descriptor.backupRoot,'retired-'+crypto.randomUUID());await write(stateFile,state);
    }
    if(state.phase==='prepared'){
      const retiredExists=await fs.stat(state.retired).then(()=>true,()=>false);
      if(!retiredExists&&await fs.stat(descriptor.root).then(()=>true,()=>false)){noLinksSync(state.retired);await fs.mkdir(path.dirname(state.retired),{recursive:true});if(!path.resolve(state.retired).startsWith(descriptor.backupRoot+path.sep)||path.resolve(descriptor.root)!==path.resolve(project,'runtime/test'))throw Error('测试恢复移动边界不符');noLinksSync(descriptor.root);await fs.rename(descriptor.root,state.retired);}
      if(retiredExists&&await fs.readdir(descriptor.root).then(r=>r.length>0,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('恢复期间测试目录被其他程序写入，未覆盖');
      await fs.mkdir(descriptor.root,{recursive:true});state.phase='copying';await write(stateFile,state);
    }
    if(state.phase==='copying'){
      for(const r of manifest.files)await copyRecord(path.join(snapshot,'runtime'),descriptor.root,r,{temporaryId:copyId});
      await verifyRecords(descriptor.root,manifest.files);state.phase='installing';await write(stateFile,state);
    }
    if(state.phase!=='installing')throw Error('未知测试恢复阶段，未覆盖数据');
    await install(project,descriptor.root);assertTestSafety(descriptor,{allowMaintenanceToken:lock.token});if(identityAt(descriptor.root)!==saved.identity)throw Error('恢复后测试身份变化');
    state.phase='ready';await write(stateFile,state);return {instance:'test',restored:true,identity:saved.identity,backup:state.backup,retired:state.retired,started:false};
  }finally{await lock.close();}
}
