import path from 'node:path';
import fs from 'node:fs';import {createRequire} from 'node:module';
import { pathToFileURL,fileURLToPath } from 'node:url';

const instance = process.env.AI_FRIEND_TEST_INSTANCE;
const port = process.env.AI_FRIEND_TEST_PORT;
if (!instance || !port) throw new Error('Isolated test instance and port are required');
process.once('message', message => {
  if (message?.command === 'stop') {
    process.disconnect();
    process.emit('SIGINT');
  }
});
process.chdir(path.join(instance, 'workspace'));
const bin = process.env.AI_FRIEND_PROJECT_ROOT?path.join(process.env.AI_FRIEND_PROJECT_ROOT,'node_modules/@deepseek-ai/dsh/lib/bin.js'):fileURLToPath(new URL('../../node_modules/@deepseek-ai/dsh/lib/bin.js',import.meta.url));
process.argv = [process.execPath, bin, 'web', '--host', '127.0.0.1', '--port', port, '--no-open'];
const require=createRequire(path.join(instance,'dsh-home/profiles/web/package.json')),source=path.dirname(require.resolve('@ai-friend/companion-adapter/bilibili-offline'));
const {BilibiliInboxClient}=await import(pathToFileURL(path.join(source,'bilibili-inbox-client.js'))),{BilibiliSocialClient}=await import(pathToFileURL(path.join(source,'bilibili-social-client.js')));
const feed=()=>{try{return JSON.parse(fs.readFileSync(path.join(instance,'social-fixture.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
BilibiliInboxClient.prototype.open=async()=>({account:'123'});BilibiliInboxClient.prototype.stream=async(_api,kind,state)=>({baseline:!state,events:state?feed().filter(x=>x.kind===kind):[],next:{since:Date.now()/1000}});
const sentFile=path.join(instance,'simulated-publications.json');const sent=()=>fs.existsSync(sentFile)?JSON.parse(fs.readFileSync(sentFile,'utf8')):[];
BilibiliSocialClient.prototype.open=async()=>({account:'123'});BilibiliSocialClient.prototype.preflight=async(_api,event,target)=>{if(target.peer!==event.sender||!feed().some(x=>x.key===event.payload.key&&x.text===event.payload.text))throw new Error('Fixture original changed');};
BilibiliSocialClient.prototype.publish=async(_api,target,body,device,_signal,operationId)=>{const rows=sent(),platformId=String(8000+rows.length);rows.push({platformId,target,body,device,operationId,at:Date.now()});fs.writeFileSync(sentFile,JSON.stringify(rows));return {platformId,apiAccepted:true};};
BilibiliSocialClient.prototype.verifyPublished=async(_api,outbox)=>sent().some(x=>x.platformId===outbox.platform_id&&x.body===outbox.body&&JSON.stringify(x.target)===JSON.stringify(outbox.target));
const { runCli } = await import(pathToFileURL(bin).href);
await runCli();
