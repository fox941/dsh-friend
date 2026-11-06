import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';

// This trusted process loads WASM; guest code is never evaluated by Node or node:vm.
let raw='';
try{
  for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>1024*1024)throw Error('脚本输入超限');}
  const {code,input,files}=JSON.parse(raw),module=await newQuickJSWASMModuleFromVariant(variant);
  const runtime=module.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024);
  const deadline=Date.now()+2000;runtime.setInterruptHandler(()=>Date.now()>deadline);
  const vm=runtime.newContext();
  try{
    const data=JSON.stringify(JSON.stringify({input,files}));
    const source=`'use strict';\n(function(){\nconst data=JSON.parse(${data});\nconst input=data.input;const files=Object.freeze(data.files);\n${code}\nif(typeof main!=='function')throw Error('必须声明 function main(input, files)');\nconst value=main(input,files);\nif(value&&typeof value.then==='function')throw Error('首版工具只支持同步计算');\nconst result=JSON.stringify(value);if(typeof result!=='string')throw Error('工具必须返回JSON对象');return result;\n})()`;
    const result=vm.evalCode(source,'self-tool.js');
    if(result.error){const detail=vm.dump(result.error);result.error.dispose();throw Error(String(detail?.message??'脚本错误').slice(0,300));}
    const text=vm.getString(result.value);result.value.dispose();if(Buffer.byteLength(text)>96*1024)throw Error('工具返回结果过大');
    process.stdout.write(JSON.stringify({ok:true,value:JSON.parse(text)}));
  }finally{vm.dispose();runtime.dispose();}
}catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e.message).slice(0,350)}));process.exitCode=0;}
