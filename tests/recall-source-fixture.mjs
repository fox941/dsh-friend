import fs from 'node:fs/promises';import {createRequire,registerHooks} from 'node:module';import {pathToFileURL,fileURLToPath} from 'node:url';
const project=process.env.AI_FRIEND_PROJECT_ROOT??fileURLToPath(new URL('../',import.meta.url)); const req=createRequire(project+'/runtime/dev/dsh-home/profiles/web/package.json'),core=createRequire(await fs.realpath(project+'/node_modules/@deepseek-ai/dsh/package.json'));
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('@deepseek-ai/'))try{return {url:pathToFileURL(core.resolve(specifier)).href,shortCircuit:true};}catch{}return next(specifier,context);}});
const {Context}=await import(pathToFileURL(core.resolve('@deepseek-ai/cordis'))),{installMemorySpaces}=await import(pathToFileURL(req.resolve('dsh-mnemon-source-memory-spaces'))),native=await import(pathToFileURL(req.resolve('dsh-mnemon-provider-mnemon-native')));
export async function createSource(dataDir){
 const root=new Context(),effects=[],children=[];let contribution;
 const ctx={get:()=>undefined,plugin(p,c){const child=root.plugin(p,c);children.push(child);return child;},effect(fn){const cleanup=fn();effects.push(cleanup);return cleanup;},mnemonMemory:{installContributions(c){contribution=c;return ()=>{};}}};
 const close=async()=>{await root.fiber.dispose();};
 try{await installMemorySpaces(ctx,[{instanceId:'mnemon-native',module:native.default,config:{}}],{instanceId:'quality-memory-spaces',config:{dataDir,cliPath:project+'/.tools/mnemon-0.2.13/mnemon.exe',timeoutMs:10000}});const definition=contribution.sources[0],source=definition.create({configuration:{},sourceInstanceKey:'source:quality-memory-spaces'});return {definition,source,query(query,{viewId='quality-view',memoryBodyIds=['default']}={}){return source.query({view:{id:viewId},grant:{sourceInstanceKey:'source:quality-memory-spaces',schema:'dsh-mnemon.memory-spaces/v1',value:{memoryBodyIds}},route:{id:'quality-recall',sourceRouteId:'recall',maxResults:8,maxCharacters:12000},input:{query,memoryBodyIds,limit:8},signal:new AbortController().signal});},async close(){await source.dispose?.();await close();}};}catch(e){await close();throw e;}
}


