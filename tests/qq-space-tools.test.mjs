import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const src=process.env.FRIEND_ADAPTER_SOURCE??path.resolve(import.meta.dirname,'../plugins/companion-adapter/src');
const {attachPlatforms}=await import(pathToFileURL(src+'/platform-agent.js'));
const bot='987654321';
function fixture(detail={content:'正文',pic:[{}],ugc_right:64}){
  const tools=new Map(),calls=[],adapter={qq:{binding:{bot_qq:bot}},platforms:{clients:{session:async()=>({}),zoneGet:async(...args)=>{calls.push(args);return detail;},zoneList:async()=>({items:[],complete:false})}}};
  attachPlatforms({systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}},adapter);
  const event={type:'user/message',data:{id:'actual-request',source:{kind:'user'},content:[{type:'text',text:'读取说说原件'}]}};
  const exec={agent:{session:{header:{},seq:1,eventAt:()=>event}},signal:new AbortController().signal};
  return {tool:tools.get('friend_qq_space_read'),exec,calls};
}
test('space detail without userId uses the AI account and returns lossless JSON with actual image count and visibility',async()=>{
  const f=fixture(),r=await f.tool.execute({tid:'real-post'},f.exec);
  assert.equal(r.userId,bot);assert.equal(r.visibility,64);assert.equal(r.imageCount,1);assert.equal(r.visibilitySettingAvailable,true);
  assert.deepEqual(JSON.parse(JSON.stringify(r)),r);assert.deepEqual(f.calls[0].slice(1),[bot,'real-post',{forceDetail:true}]);
});
test('missing visibility or image fields remain unknown instead of claiming a private successful post',async()=>{
  const f=fixture({con:'原文'}),r=await f.tool.execute({tid:'real-post',userId:'112233445'},f.exec);
  assert.equal(r.userId,'112233445');assert.equal(r.imageCount,null);assert.equal(r.visibility,null);assert.equal(r.visibilitySettingAvailable,false);assert.deepEqual(JSON.parse(JSON.stringify(r)),r);
  const g=fixture({content:'原文',pics:[],right:'4'}),v=await g.tool.execute({tid:'other'},g.exec);assert.equal(v.visibility,4);assert.equal(v.imageCount,0);
});
test('space detail keeps the existing owner guard and propagates an access denial',async()=>{
  const f=fixture();await assert.rejects(f.tool.execute({tid:'real-post'},{agent:{session:{header:{origin:'subagent'},seq:1,eventAt:()=>null}}}),/主用户/);
  f.exec.agent.session.header={};const g=fixture();g.calls.length=0;
  const adapter={qq:{binding:{bot_qq:bot}},platforms:{clients:{session:async()=>({}),zoneGet:async()=>{throw Error('access denied');}}}},tools=new Map();attachPlatforms({systemPrompt:{section(){}},tools:{register:t=>tools.set(t.name,t)}},adapter);
  await assert.rejects(tools.get('friend_qq_space_read').execute({tid:'real-post'},f.exec),/access denied/);
});
