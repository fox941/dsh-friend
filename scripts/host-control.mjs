import net from 'node:net';
import path from 'node:path';
export function controlReplyMatches(record,value,{guard=false,requireProject=true}={}){
 const r=guard?value?.guard:value,same=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
 return Boolean(!value?.error&&r&&r.pid===record.pid&&typeof record.startedAt==='string'&&Number.isFinite(Date.parse(record.startedAt))&&r.startedAt===record.startedAt&&same(r.instanceRoot,record.instanceRoot)&&(!requireProject&&r.projectRoot==null||same(r.projectRoot,record.projectRoot)));
}
export function requestControl(record,command,timeoutMs=3000,maxBytes=131072){return new Promise((resolve,reject)=>{
 const socket=net.createConnection(record.pipe);let response='',done=false;
 const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
 const timer=setTimeout(()=>finish(new Error('Host control timed out')),timeoutMs);
 socket.once('connect',()=>socket.write(JSON.stringify({token:record.token,command})+'\n'));
 socket.on('data',chunk=>{response+=chunk;if(response.length>maxBytes)finish(new Error('Invalid host response'));});
 socket.once('error',error=>finish(error));socket.once('end',()=>{try{finish(null,JSON.parse(response));}catch(error){finish(error);}});
 socket.once('close',()=>{if(!done)finish(new Error('Host control closed without a response'));});
});}
