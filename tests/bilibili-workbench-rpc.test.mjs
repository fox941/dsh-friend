import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import http from 'node:http';import {randomUUID} from 'node:crypto';
import {fixture,bload} from './bilibili-workbench-fixture.mjs';
const req=createRequire('D:/ai friend/node_modules/.pnpm/node_modules/@deepseek-ai/dsh-client-connection/package.json'),{Context}=await import(pathToFileURL(req.resolve('@deepseek-ai/cordis'))),{HostConnectionService}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-client-connection'))),{attachWorkbenchHost}=await bload('workbench-host.js');
test('real rc.3 carrier mounts workbench without webServer and rejects unauthenticated/agent peers',async t=>{
 const f=await fixture(t),ctx=new Context(),errors=[];ctx.on('internal/error',e=>errors.push(String(e)));
 const connection=new HostConnectionService(ctx,[],{isAuthenticated:r=>r.headers.cookie==='owner=yes',authenticateApi:()=>undefined});connection.rpc.intercept('/api',endpoint=>endpoint==='core/ping',async()=>({ok:true,value:'pong'}));
 const fiber=ctx.plugin({name:'workbench-owner-test',apply:bound=>{attachWorkbenchHost(bound,f.controller);}});await fiber.await();await new Promise(r=>setTimeout(r,30));assert.deepEqual(errors,[]);
 const shared=connection.createSharedFetchHandler('/api');
 assert.equal(shared.requestBodyMode({method:'POST',url:new URL('http://dsh.internal/api/ai-friend-bilibili-workbench-control')}),'streaming');
 const server=http.createServer(async(req,res)=>{try{const admission=connection.admit(req);if(admission.rejection){res.writeHead(admission.rejection);res.end();return;}const chunks=[];for await(const c of req)chunks.push(c);const request=new Request('http://dsh.internal'+req.url,{method:req.method,headers:req.headers,...chunks.length?{body:Buffer.concat(chunks)}:{}}),response=await shared.fetch(request,admission.peer);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await fiber.dispose();await ctx.dispose?.();});
 const base='http://127.0.0.1:'+server.address().port,headers={cookie:'owner=yes',origin:base},before=f.dump();
 for(const route of ['/api/ai-friend-bilibili-workbench','/api/ai-friend-bilibili-workbench?section=settings','/api/ai-friend-bilibili-workbench-detail?id='+f.activity.readings.status().recent[0].id]){
  assert.equal((await fetch(base+route)).status,401);const r=await fetch(base+route,{headers});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
  assert.equal((await shared.fetch(new Request(base+route),{principal:{kind:'agent'}})).status,403);
 }
 assert.equal(f.dump(),before);
 const cmd={kind:'settings',requestId:randomUUID(),expectedRevision:f.view.settings().revision,changes:{activity:{dailyLimit:7},video:{continuousFrames:16}}},body=JSON.stringify(cmd),route='/api/ai-friend-bilibili-workbench-control',request=h=>new Request('http://dsh.internal'+route,{method:'POST',headers:{...h,'content-type':'application/json'},body});
 assert.equal((await shared.fetch(request({...headers,host:new URL(base).host}),{principal:{kind:'agent'}})).status,403);
 assert.equal((await shared.fetch(request({'content-type':'application/json',origin:'https://outside.test',host:new URL(base).host}),{principal:{kind:'owner'}})).status,403);
 assert.equal(f.dump(),before);
 const applied=await fetch(base+route,{method:'POST',headers:{...headers,'content-type':'application/json'},body});assert.equal(applied.status,200);assert.equal((await applied.json()).applied[0].value,7);assert.equal(f.activity.video.config.continuousFrames,16);assert.equal(f.view.settings().values.video.continuousFrames,16);
 const ping=await fetch(base+'/api/core/ping',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'ping',method:'core/ping',payload:{}})});assert.equal((await ping.json()).result.value,'pong');
 assert.equal((await fetch(base+'/dsh-bilibili-tool/api/state',{headers})).status,404);
 assert.deepEqual(errors,[]);
});
