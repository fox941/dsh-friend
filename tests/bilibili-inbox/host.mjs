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
const require=createRequire(path.join(instance,'dsh-home/profiles/web/package.json'));const source=path.dirname(require.resolve('@ai-friend/companion-adapter/bilibili-offline'));const {BilibiliInboxClient}=await import(pathToFileURL(path.join(source,'bilibili-inbox-client.js')));BilibiliInboxClient.prototype.open=async()=>({account:'123'});BilibiliInboxClient.prototype.stream=async function(_api,kind,state){const file=path.join(instance,'inbox-fixture.json');const feed=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];return {baseline:!state,events:state?feed.filter(x=>x.kind===kind):[],next:{since:Date.now()/1000}};};
const { runCli } = await import(pathToFileURL(bin).href);
await runCli();
