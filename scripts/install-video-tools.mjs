import {requireMain} from './instances.mjs';
requireMain('scripts/install-video-tools.mjs');
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {execFileSync,spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {projectRoot} from './paths.mjs';
import {preparePinnedModel} from './video-model.mjs';
const project=projectRoot,root=path.join(project,'.tools/video');
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('当前便携媒体工具仅适配Windows x64');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function download(url,cap=150*1024*1024){const r=await fetch(url,{headers:{'user-agent':'ai-friend-video-setup'},signal:AbortSignal.timeout(180000)});if(!r.ok)throw new Error('Download HTTP '+r.status);const parts=[];let n=0;for await(const p of r.body){n+=p.length;if(n>cap)throw new Error('Download limit');parts.push(p);}return Buffer.concat(parts);}
await fs.mkdir(root,{recursive:true});
const manifest={schema:'ai-friend-video-tools/1',platform:process.platform,arch:process.arch,createdAt:new Date().toISOString(),dependencies:{}};
const ffmpeg=path.join(root,'ffmpeg.exe');
try{await fs.access(ffmpeg);}catch{const gzip=await download('https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz');await fs.writeFile(ffmpeg,gunzipSync(gzip));}
manifest.dependencies.ffmpeg={version:'6.1.1',source:'https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1',file:'ffmpeg.exe',sha256:sha(await fs.readFile(ffmpeg))};
if(manifest.dependencies.ffmpeg.sha256!=='04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00')throw new Error('FFmpeg binary does not match pinned artifact');
console.log('FFmpeg ready');
const python=path.join(root,'python/tools/python.exe');
try{await fs.access(python);}catch{const bytes=await download('https://api.nuget.org/v3-flatcontainer/python/3.12.10/python.3.12.10.nupkg',50*1024*1024),registration=JSON.parse((await download('https://api.nuget.org/v3/registration5-semver1/python/3.12.10.json',1024*1024)).toString()),catalog=JSON.parse((await download(registration.catalogEntry,1024*1024)).toString());if(catalog.packageHashAlgorithm!=='SHA512'||createHash('sha512').update(bytes).digest('base64')!==catalog.packageHash)throw new Error('NuGet SHA512 mismatch');const zip=path.join(root,'python.zip');await fs.writeFile(zip,bytes);execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'scripts/extract-video-python.ps1'),'-Zip',zip,'-Destination',path.join(root,'python')],{windowsHide:true,stdio:'pipe'});await fs.unlink(zip);}
manifest.dependencies.python={version:'3.12.10',source:'https://www.nuget.org/packages/python/3.12.10',file:'python/tools/python.exe',sha256:sha(await fs.readFile(python))};
console.log('Portable Python ready');
const require=createRequire(path.join(project,'runtime/dev/dsh-home/profiles/web/package.json')),entry=require.resolve('@xzxzzx/bilibili-mcp');
const {runAsrInstallation,buildAsrChildEnv}=await import(pathToFileURL(path.join(path.dirname(entry),'asr/installer.js')));
const {deriveAsrPaths,readAsrState}=await import(pathToFileURL(path.join(path.dirname(entry),'asr/state.js')));
if(readAsrState(deriveAsrPaths(path.join(root,'asr')).stateFile).kind!=='ready')await preparePinnedModel(path.join(root,'model-cache'));
process.env.HF_HOME=path.join(root,'hf-cache');process.env.PIP_CACHE_DIR=path.join(root,'pip-cache');
manifest.dependencies.asr={ready:false};await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const spawnFn=async(file,args,signal)=>{if(args.some(a=>a.includes('snapshot_download'))){const cache=path.join(root,'model-cache'),m=JSON.parse(await fs.readFile(path.join(cache,'manifest.json'),'utf8')),at=args.indexOf('-c'),[repo,revision,destination]=args.slice(at+2);if(repo!==m.repository||revision!==m.revision||path.dirname(destination)!==path.join(root,'asr')||!path.basename(destination).startsWith('.models-staging-'))throw new Error('Pinned model destination mismatch');for(const record of m.records){if(!['config.json','model.bin','tokenizer.json','vocabulary.txt'].includes(record.name))throw new Error('Unexpected model cache file');const bytes=await fs.readFile(path.join(cache,record.name));if(sha(bytes)!==record.sha256)throw new Error('Cached model hash mismatch');await fs.writeFile(path.join(destination,record.name),bytes);}return {code:0,stdout:'DOWNLOADED',stderr:''};}if(args.includes('pip')&&args.includes('install'))args=[...args,'av==18.1.0','-r',path.join(project,'scripts/video-requirements.lock.txt')];return new Promise((resolve,reject)=>{args=args.map(a=>a.includes('def fail(category, code):')?a.replace('except Exception as error:\n    message = str(error).lower()',"except Exception as error:\n    print(type(error).__name__ + ': ' + str(error), file=sys.stderr, flush=True)\n    message = str(error).lower()"):a);const env={...buildAsrChildEnv(process.env),HF_HOME:path.join(root,'hf-cache'),PIP_CACHE_DIR:path.join(root,'pip-cache'),HF_HUB_DISABLE_XET:'1'};for(const key of ['HTTPS_PROXY','HTTP_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];const child=spawn(file,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('ASR setup step timed out'));},300000);child.stdout.on('data',b=>{stdout+=b;if(stdout.length>2000000)child.kill();});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>2000000)child.kill();});child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',async code=>{clearTimeout(timer);if(code!==0&&args.some(a=>a.includes('def fail(category, code):'))){console.log('CPU probe diagnostic: '+stderr.slice(-1800));const candidate=args[args.indexOf('-c')+2];if(path.dirname(candidate)===path.join(root,'asr')&&path.basename(candidate).startsWith('.models-staging-'))await fs.cp(candidate,path.join(root,'probe-model'),{recursive:true});}resolve({code,stdout,stderr});});signal?.addEventListener('abort',()=>{child.kill();reject(signal.reason);},{once:true});});};
const result=await runAsrInstallation({asrBase:path.join(root,'asr'),pythonOverride:python,modelKey:'base',devicePreference:'cpu',spawnFn,onStage:s=>console.log(String(s).slice(0,300))});
manifest.dependencies.asr={mcpVersion:'1.14.5',model:'base',engine:'faster-whisper==1.2.1',runtime:'ctranslate2==4.8.0',pyav:'18.1.0',ready:result.success===true};
await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({ffmpeg:true,python:true,asrReady:result.success===true,...result.success?{}:{error:String(result.error).slice(0,600)}}));
if(!result.success)process.exitCode=1;
