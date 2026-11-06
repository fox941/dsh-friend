import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/** No host callbacks enter the guest: its only inputs and outputs are JSON. */
export function runWorkshopScript(payload,signal){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const worker=fileURLToPath(new URL('./workshop-worker.js',import.meta.url));
    const child=spawn(process.execPath,['--max-old-space-size=96',worker],{windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:fileURLToPath(new URL('.',import.meta.url)),env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot??'C:\\Windows',WINDIR:process.env.WINDIR??'C:\\Windows'}:{}});
    let output='',size=0,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);child.kill();error?reject(error):resolve(value);};
    const cancel=()=>finish(new Error('脚本执行已取消，未提交文件'));
    const timer=setTimeout(()=>finish(new Error('脚本进程超时，未提交文件')),10000);
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    child.on('error',()=>finish(new Error('隔离脚本进程未能启动')));
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>128*1024)return finish(new Error('脚本输出超过限制，未提交文件'));output+=chunk;});
    child.on('close',code=>{if(done)return;try{if(code!==0)throw Error('隔离脚本进程异常，未提交文件');const value=JSON.parse(output);if(!value.ok)throw Error(typeof value.error==='string'?value.error:'脚本执行失败');finish(null,value.value);}catch(e){finish(e);}});
    if(!done)child.stdin.end(JSON.stringify(payload));
  });
}
