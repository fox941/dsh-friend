// Isolated test Host: no DSH, provider or platform credentials.
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';import crypto from 'node:crypto';
import {processStamp} from '../../scripts/process-records.mjs';
const [root,project]=process.argv.slice(2),file=path.join(root,'host.json'),lock=path.join(root,'host.lock'),token=crypto.randomUUID();
const pipe=process.platform==='win32'?`\\\\.\\pipe\\friend-runtime-fixture-${crypto.randomUUID()}`:path.join(root,'fixture.sock');
const record={pid:process.pid,...await processStamp(),startedAt:new Date().toISOString(),instanceRoot:root,projectRoot:project,token,pipe};
fs.appendFileSync(path.join(root,'launches.txt'),'start\n');
fs.writeFileSync(lock,JSON.stringify({pid:process.pid,processIdentity:record.processIdentity}),{flag:'wx'});
const server=net.createServer({allowHalfOpen:true},socket=>{let input='';socket.on('error',()=>{});socket.on('data',chunk=>{input+=chunk;if(!input.includes('\n'))return;const m=JSON.parse(input);if(m.token!==token){socket.end('{"error":"Unauthorized"}');return;}if(m.command==='crash'){socket.end('{"accepted":true}');setTimeout(()=>process.exit(23),30);return;}if(m.command==='stop'){socket.end('{"accepted":true}');setTimeout(()=>{server.close();process.exit(0);},30);return;}socket.end(JSON.stringify({...record,health:{available:true,identity:'fixture-identity',memory:{configured:true,activeSpaces:1,stores:[{readable:true}]},models:{active:[]}}}));});});
process.on('exit',()=>{for(const f of [file,lock])try{if(JSON.parse(fs.readFileSync(f)).pid===process.pid)fs.unlinkSync(f);}catch{}});
server.listen(pipe,()=>fs.writeFileSync(file,JSON.stringify(record)));
