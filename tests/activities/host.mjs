import path from 'node:path';
import {createRequire} from 'node:module';
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
const require=createRequire(path.join(instance,'dsh-home/profiles/web/package.json'));const offline=await import(pathToFileURL(require.resolve('@ai-friend/companion-adapter/bilibili-offline')));if(process.env.AI_FRIEND_REAL_BILIBILI!=='1')offline.BilibiliClient.prototype.withClient=async function(fn,signal){return fn({call:async(name,args={})=>{signal?.throwIfAborted();if(name==='check_bilibili_credentials')return {logged_in:true};if(name==='search_bilibili_videos'){if(typeof args.query!=='string')throw new Error('Expected actual MCP query parameter');return {results:[{bvid:'BV1Eb411u7Fw',title:'隔离资料：分步骤核对的方法'}]};}if(name==='get_bilibili_creator_content')return {mid:args.mid,section:args.section,videos:[{bvid:'BV1Eb411u7Fw',title:'隔离旧投稿',published_at:'2026-10-25T00:00:00Z'},{bvid:'BV1ZHnF6SEp5',title:'隔离最新投稿',published_at:'2026-10-26T00:00:00Z'}]};if(name==='get_bilibili_feed')return {accountUid:'123456',source:args.source,videos:[{bvid:'BV1Eb411u7Fw',title:'复杂问题如何分步核验（隔离夹具）',published_at:'2026-10-25T00:00:00Z',discovery_source:args.source}],dynamics:[]};if(name==='get_video_metadata')return {bvid:args.bvid_or_url,title:'隔离资料：分步骤核对的方法'};if(name==='get_video_transcript')return {bvid:args.bvid_or_url,page:args.page,data_source:'subtitle',language:'zh-CN',transcript:'这是一份隔离验收的模拟字幕，不代表真实视频内容。一个复杂问题可以分解成多个步骤，每一步先写出假设，再用实际结果检查。如果检查不通过，就回到对应步骤修正，而不是把所有结果推倒重来。保留每一步的原始依据，后面的人就能核对我们为什么这样判断。'};throw new Error('Unapproved simulated Bilibili call');}});};
const { runCli } = await import(pathToFileURL(bin).href);
await runCli();
