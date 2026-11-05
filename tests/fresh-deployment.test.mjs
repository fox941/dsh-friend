import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {spawn} from 'node:child_process';
import {createFresh,verifyFresh,installFresh,cleanToolPath} from '../scripts/fresh-core.mjs';
import {initializeFresh} from '../scripts/fresh-initialize.mjs';
import {assertNoMigration} from '../scripts/migration-lock.mjs';
import {readJson,json} from '../scripts/migration-files.mjs';
import {runChild} from '../scripts/migration.mjs';
const scripts=path.resolve(import.meta.dirname,'../scripts'),plugins=path.resolve(import.meta.dirname,'../plugins');
async function put(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='string'?value:json(value));}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'friend-fresh-')),project=path.join(root,'source'),target=path.join(root,'home');
 t.after(async()=>{const real=await fs.realpath(root),tmp=await fs.realpath(os.tmpdir());assert(real.startsWith(tmp+path.sep)&&path.basename(real).startsWith('friend-fresh-'));await fs.rm(real,{recursive:true,force:true});});
 await put(project+'/package.json',{name:'fresh-fixture',private:true,type:'module'});
 for(const name of ['Setup.ps1','pnpm-lock.yaml','pnpm-workspace.yaml','scripts/fresh.mjs','scripts/fresh-initialize.mjs','.tools/node-v24.22.1-win-x64/node.exe','.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs','.tools/mnemon-0.2.13/mnemon.exe','.tools/napcat-v4.18.41/napcat.mjs','.tools/napcat-v4.18.41/NapCatWinBootMain.exe','.tools/napcat-v4.18.41/node_modules/library/index.js','.tools/video/ffmpeg.exe','.tools/video/asr/models/model.bin'])await put(project+'/'+name,'fixture '+name);
 for(const name of ['companion-adapter','attention-scheduler','qq-bridge','bilibili-tool','activity-console'])await put(project+'/plugins/'+name+'/package.json',{name:'@ai-friend/'+name,version:'1.0.0',type:'module'});
 for(const name of ['journal.js','growth-store.js','validation.js'])await fs.copyFile(plugins+'/companion-adapter/src/'+name,await (async()=>{const f=project+'/plugins/companion-adapter/src/'+name;await fs.mkdir(path.dirname(f),{recursive:true});return f;})());
 for(const name of ['runtime/dev/companion/companion.sqlite','runtime/dev/memory/runtime/memories.json','runtime/dev/channels/qq/config.local.json','runtime/dev/credentials.local.json','runtime/test/private.json','backups/old.json','.work/cache.json','.git/config','node_modules/cache','.tools/napcat-v4.18.41/config/webui.json','.tools/napcat-v4.18.41/guild1.db','.tools/napcat-v4.18.41/guild1.db-shm','.tools/napcat-v4.18.41/guild1.db-wal','.tools/video/cache/private.bin'])await put(project+'/'+name,'PRIVATE_SOURCE_SENTINEL');
 await put(project+'/runtime/dev/host.json',{pid:process.pid});
 await put(project+'/.tools/node-v24.22.1-win-x64/node_modules/npm/node_modules/make-fetch-happen/lib/cache/index.js','export const dependencySource=true;');
 await put(project+'/.npmrc','//private.registry/:_authToken=PRIVATE_SOURCE_SENTINEL\n');
 const f={root,project,target,pack:options=>createFresh({project,destination:root+'/packages',...options}),install:async bundle=>installFresh({bundle,target,install:async(p,{id})=>{await put(p+'/runtime/dev/bootstrap.json',{configuredRoot:p+'/runtime/dev'});return initializeFresh(p,id);}})};return f;
}
test('fresh package carries code and clean tools, with no runtime, private data, logins or source identity',async t=>{
 const f=await fixture(t),before=await fs.readFile(f.project+'/runtime/dev/host.json'),r=await f.pack(),v=await verifyFresh(r.bundle),paths=v.manifest.files.map(r=>r.path);
 assert.equal(v.manifest.containsRuntime,false);assert.equal(v.manifest.containsCredentials,false);assert.equal(v.manifest.newIdentityOnTarget,true);assert.equal(v.manifest.identity,undefined);
 assert(paths.includes('project/.tools/package-manager/node_modules/pnpm/bin/pnpm.mjs'));assert(paths.includes('project/.tools/napcat-v4.18.41/node_modules/library/index.js'));
 assert(paths.includes('project/.tools/node-v24.22.1-win-x64/node_modules/npm/node_modules/make-fetch-happen/lib/cache/index.js'));
 assert(!paths.some(n=>/runtime\/|backups\/|\/config\/webui|guild1\.db|\.work\/|\.git\//.test(n)));
 for(const record of v.manifest.files)assert(!(await fs.readFile(path.join(r.bundle,record.path))).includes('PRIVATE_SOURCE_SENTINEL'));
 assert.deepEqual(await fs.readFile(f.project+'/runtime/dev/host.json'),before);assert.equal(r.sourceNotStopped,true);
 assert.equal(await fs.readFile(r.bundle+'/project/.npmrc','utf8'),'registry=https://registry.npmjs.org\n');
});
test('clean tools exclude NapCat databases/config and include only declared engine runtime files',()=>{
 for(const p of ['.tools/napcat-v4.18.41/guild1.db','.tools/napcat-v4.18.41/guild1.db-shm','.tools/napcat-v4.18.41/config/webui.json','.tools/napcat-v4.18.41/napcat.ai-friend.mjs','.tools/video/.cache/token','.tools/voice/credentials.local.json'])assert.equal(cleanToolPath(p),false,p);
 for(const p of ['.tools/napcat-v4.18.41/napcat.mjs','.tools/napcat-v4.18.41/native/library.dll','.tools/video/asr/models/model.bin','.tools/node-v24.22.1-win-x64/node_modules/npm/node_modules/make-fetch-happen/lib/cache/index.js'])assert.equal(cleanToolPath(p),true,p);
 assert.throws(()=>cleanToolPath('.tools/../runtime/private'));assert.throws(()=>cleanToolPath('D:/outside'));
});
test('extra files and false fresh flags are rejected instead of silently importing old data',async t=>{
 const f=await fixture(t),r=await f.pack();await put(r.bundle+'/runtime/dev/memory/old.json','old');await assert.rejects(verifyFresh(r.bundle),/额外文件/);
 const second=await f.pack(),manifest=await readJson(second.bundle+'/fresh.json');manifest.containsRuntime=true;await put(second.bundle+'/fresh.json',manifest);await assert.rejects(verifyFresh(second.bundle),/不是空白/);
});
test('a declared private path cannot be smuggled into a fresh manifest',async t=>{
 const f=await fixture(t),r=await f.pack(),m=await readJson(r.bundle+'/fresh.json');m.files.find(x=>x.path==='project/.tools/napcat-v4.18.41/napcat.mjs').path='project/.tools/napcat-v4.18.41/config/private.json';await fs.mkdir(r.bundle+'/project/.tools/napcat-v4.18.41/config');await fs.rename(r.bundle+'/project/.tools/napcat-v4.18.41/napcat.mjs',r.bundle+'/project/.tools/napcat-v4.18.41/config/private.json');await put(r.bundle+'/fresh.json',m);await assert.rejects(verifyFresh(r.bundle),/工具运行数据/);
});
test('source secrets in program files stop publication before a package is produced',async t=>{
 const f=await fixture(t);await put(f.project+'/scripts/bad.mjs','const key="sk-'+'x'.repeat(32)+'";');await assert.rejects(f.pack(),/疑似模型密钥/);assert.equal(await fs.stat(f.root+'/packages').then(()=>true,()=>false),false);
});
test('source changes during compression prevent publishing a mixed package',async t=>{
 const f=await fixture(t);await assert.rejects(f.pack({compress:async(_b,z)=>{await fs.writeFile(z,'fake ZIP');await put(f.project+'/scripts/new.mjs','changed');}}),/清单发生变化/);assert(!(await fs.readdir(f.root+'/packages')).some(n=>n.endsWith('.zip')));
});
test('existing target roles are never erased or replaced for an empty-memory installation',async t=>{
 const f=await fixture(t),r=await f.pack();await put(f.target+'/runtime/dev/memory/original.json','HOME_ROLE_SENTINEL');await assert.rejects(f.install(r.bundle),/已有项目或角色/);assert.equal(await fs.readFile(f.target+'/runtime/dev/memory/original.json','utf8'),'HOME_ROLE_SENTINEL');assert.equal(await fs.stat(f.target+'/.fresh-install.json').then(()=>true,()=>false),false);
});
test('fresh install creates a new empty role only on target, with no carried memory or channels',async t=>{
 const f=await fixture(t),r=await f.pack(),installed=await f.install(r.bundle);assert.equal(installed.started,false);assert.equal(installed.blankAtInitialization,true);assert.match(installed.identity,/^[a-f0-9-]{36}$/);
 const db=new DatabaseSync(f.target+'/runtime/dev/companion/companion.sqlite',{readOnly:true});try{for(const table of ['growth_events','growth_versions','growth_heads','growth_batches'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,0);assert.equal(db.prepare("SELECT value FROM growth_meta WHERE key='identity'").get().value,installed.identity);}finally{db.close();}
 assert.deepEqual(await fs.readdir(f.target+'/runtime/dev/memory'),[]);assert.equal(await fs.stat(f.target+'/runtime/dev/channels').then(()=>true,()=>false),false);await assertNoMigration(f.target);
 await put(f.target+'/runtime/dev/memory/new-personal-data.json','new memory');const again=await f.install(r.bundle);assert.equal(again.alreadyReady,true);assert.equal(again.identity,installed.identity);assert.equal(await fs.readFile(f.target+'/runtime/dev/memory/new-personal-data.json','utf8'),'new memory');
});
test('partial setup remains blocked and same-package retry preserves a newly generated identity',async t=>{
 const f=await fixture(t),r=await f.pack();let firstId;
 await assert.rejects(installFresh({bundle:r.bundle,target:f.target,install:async(p,{id})=>{firstId=(await initializeFresh(p,id)).identity;throw Error('simulated setup interruption');}}),/interruption/);await assert.rejects(assertNoMigration(f.target),/空白部署尚未完成/);
 const next=await f.install(r.bundle);assert.equal(next.identity,firstId);await assertNoMigration(f.target);
});
test('fresh initialization rejects a database or memory unexpectedly introduced during setup',async t=>{
 const f=await fixture(t),r=await f.pack();await assert.rejects(installFresh({bundle:r.bundle,target:f.target,install:async(p,{id})=>{await put(p+'/runtime/dev/memory/foreign.json','FOREIGN');return initializeFresh(p,id);}}),/已有记忆/);assert.equal(await fs.readFile(f.target+'/runtime/dev/memory/foreign.json','utf8'),'FOREIGN');
});
test('a different package cannot reuse another fresh-install checkpoint',async t=>{
 const f=await fixture(t),r=await f.pack();await assert.rejects(installFresh({bundle:r.bundle,target:f.target,install:async()=>{throw Error('incomplete');}}));const other=await f.pack();await assert.rejects(f.install(other.bundle),/已有项目或角色/);
});
test('an active installer lock is respected without overwriting it',async t=>{
 const f=await fixture(t),r=await f.pack(),v=await verifyFresh(r.bundle);await put(f.target+'/.fresh-install.json',{schema:'ai-friend/fresh-install/1',id:v.manifest.id,digest:v.digest,target:f.target,phase:'installing'});await put(f.target+'/.fresh.lock',{id:v.manifest.id,pid:process.pid});await assert.rejects(f.install(r.bundle),/仍在执行/);assert.equal((await readJson(f.target+'/.fresh.lock')).pid,process.pid);
});
test('an interrupted dead installer lock can be recovered by only the same package',async t=>{
 const f=await fixture(t),r=await f.pack(),v=await verifyFresh(r.bundle),pid=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['-e',''],{windowsHide:true,stdio:'ignore'});p.once('error',reject);p.once('exit',()=>resolve(p.pid));});await put(f.target+'/.fresh-install.json',{schema:'ai-friend/fresh-install/1',id:v.manifest.id,digest:v.digest,target:f.target,phase:'installing'});await put(f.target+'/.fresh.lock',{id:v.manifest.id,pid});assert.equal((await f.install(r.bundle)).installed,true);
});
test('fresh package cannot be installed over its own extracted directory or a drive root',async t=>{
 const f=await fixture(t),r=await f.pack();for(const target of [r.bundle,path.join(r.bundle,'child'),path.parse(r.bundle).root])await assert.rejects(installFresh({bundle:r.bundle,target,install:async()=>({})}),/目录之外|磁盘根/);
});
test('fresh ZIP uses its own manifest and can be fully extracted and verified',async t=>{
 const f=await fixture(t),r=await f.pack({compress:(b,z)=>runChild('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scripts+'/migration-zip.ps1','-BundleRoot',b,'-Destination',z,'-ManifestName','fresh.json'],{cwd:f.root})});assert(r.zip&&r.zipSha256);const extracted=f.root+'/extracted',expand=f.root+'/expand.ps1';await put(expand,'param($Zip,$Destination)\nExpand-Archive -LiteralPath $Zip -DestinationPath $Destination\n');await runChild('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',expand,r.zip,extracted],{cwd:f.root});assert.equal((await verifyFresh(extracted)).manifest.containsRuntime,false);
});
