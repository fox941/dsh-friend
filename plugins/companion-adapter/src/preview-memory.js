import fs from 'node:fs/promises';
import path from 'node:path';
import {hash,noSecret,aborted} from './validation.js';
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
/** Uses the public Runtime JSON contract and Native read-only CLI. No source writes. */
export class PreviewMemoryReader{
  constructor({memoryDir,client,policy,runtimeContract,growth}){Object.assign(this,{memoryDir,client,policy,runtimeContract,growth});}
  async token(signal){
    aborted(signal);const policy=this.policy(),runtimeFile=path.join(this.memoryDir,this.runtimeContract.RUNTIME_DIRECTORY,this.runtimeContract.RUNTIME_MEMORIES_FILE);
    if(!policy.enabled||policy.previewRuntimeSupported!==true)throw new Error('预演仅支持已核对的本实例 Runtime 存储范围');
    const stat=await fs.stat(runtimeFile).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(stat){if(stat.size>1048576||!same(await fs.realpath(runtimeFile),runtimeFile))throw new Error('常驻资料大小或路径超出预演范围');}
    const runtime=await fs.readFile(runtimeFile,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const files=[];
    for(const space of policy.spaces.filter(row=>row.active))for(const suffix of ['','-wal']){
      const file=path.join(this.memoryDir,'data',space.id,`mnemon.db${suffix}`);
      const stat=await fs.stat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      files.push([space.id,suffix,stat?.size??null,stat?.mtimeMs??null]);
    }
    return hash(JSON.stringify({policy,runtime,growthRevision:this.growth.store.revision(),states:this.growth.read().states.map(row=>[row.id,row.effectiveStatus]),files}));
  }
  async read(queries,signal){
    aborted(signal);const policy=this.policy();
    if(!policy.enabled)throw new Error('当前本地记忆配置不能用于预演，请先核对配置');
    if(!same(await fs.realpath(this.memoryDir),this.memoryDir))throw new Error('预演记忆目录不能重定向');
    const before=await this.token(signal),items=[],notices=[],coverage={runtime:'unavailable',native:'sampled',self:'bounded',nativeIsComplete:false};
    const contract=this.runtimeContract,file=path.join(this.memoryDir,contract.RUNTIME_DIRECTORY,contract.RUNTIME_MEMORIES_FILE);
    const runtimeText=await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(runtimeText!==null){
      if(!same(await fs.realpath(file),file))throw new Error('常驻记忆文件不能重定向');
      const value=JSON.parse(runtimeText),summary=contract.summarizeRuntimeMemories(value);
      if(value.version!==contract.RUNTIME_MEMORY_VERSION||!summary.valid)throw new Error('常驻记忆格式不符合已安装版本的公开格式');
      coverage.runtime='complete';
      for(const row of value.entries){
        if(!row||!['user','memory'].includes(row.target)||typeof row.content!=='string'||row.content.length>6000){coverage.runtime='partial';continue;}
        try{noSecret(row.content);}catch{coverage.runtime='partial';notices.push('常驻记忆中疑似凭据已省略');continue;}
        if(row.branches?.length){coverage.runtime='partial';notices.push('本版未判断分支资料，已省略该条目');continue;}
        items.push({id:`runtime:${row.target}:${hash(row.content)}`,kind:'runtime',target:row.target,importance:row.importance,text:row.content,revision:hash(JSON.stringify(row)),createdAt:row.created_at,updatedAt:row.updated_at});
      }
    }else notices.push('常驻记忆文件尚不存在，不能据此判断长期空间为空');
    let characters=items.reduce((n,row)=>n+row.text.length,0);
    if(characters>12000){while(items.length&&characters>12000){characters-=items.pop().text.length;}coverage.runtime='partial';notices.push('常驻资料超出本次输入预算，已保留覆盖不完整标记');}
    const allSpaces=policy.spaces.filter(row=>row.active),spaces=allSpaces.slice(0,2),seen=new Set(items.map(row=>row.id));
    coverage.nativeOmittedSpaces=allSpaces.length-spaces.length;
    for(const space of spaces)for(const query of queries){
      aborted(signal);
      try{
        const response=await this.client.run(space.id,'recall',['--readonly','--limit','3','--verbose','--',query],{signal});
        if(!Array.isArray(response?.results))throw new Error('Native 未返回可核对的结果列表');
        for(const result of response.results){
          const row=result.insight,id=`native:${space.id}:${row?.id}`;
          if(!row?.id||typeof row.content!=='string'||row.content.length>6000||seen.has(id))continue;
          try{noSecret(row.content);}catch{notices.push('长期条目中疑似凭据已省略');continue;}
          if(characters+row.content.length>18000){notices.push('长期候选超出本次输入预算');continue;}
          items.push({id,kind:'native',importance:row.importance,category:row.category,storeId:space.id,recordId:row.id,text:row.content,revision:hash(JSON.stringify(row)),source:row.source,createdAt:row.created_at,updatedAt:row.updated_at});seen.add(id);characters+=row.content.length;
        }
      }catch(error){if(signal?.aborted)throw error;notices.push(`Native 空间 ${space.id} 查询未完成；不能判断其中没有相关记忆`);coverage.native='partial';}
    }
    const self=this.growth.read(),states=self.states.slice(0,24);coverage.selfOmitted=Math.max(0,self.states.length-states.length);
    for(const row of states){
      try{noSecret(row.statement);}catch{notices.push('自我状态中疑似凭据已省略');continue;}
      items.push({id:`self:${row.id}`,kind:'self',key:row.key,stateKind:row.kind,text:row.statement,status:row.effectiveStatus,revision:String(self.revision),expiresAt:row.expiresAt});
    }
    const after=await this.token(signal);
    return {items,queries,coverage,notices,token:after,changedDuringRead:before!==after,observedAt:new Date().toISOString()};
  }
}
