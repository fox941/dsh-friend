import {eligibleHeader} from './preview-sessions.js';
import {hash,noSecret,aborted} from './validation.js';
import {ownerIdentity,assistantResponseDelivered} from './source-identity.js';
import {verifyObservation} from './activity-source.js';
const text=blocks=>(blocks??[]).filter(row=>row.type==='text'&&typeof row.text==='string').map(row=>row.text).join('\n');
export async function verifyReportSources(sources,persistence,workspace,signal){
  if(sources.some(source=>source.kind!=='external_observation')&&!persistence?.open)throw new Error('原始交流读取接口不可用');
  const handles=new Map();
  try{
    for(const source of sources){
      if(source.kind==='external_observation'){aborted(signal);verifyObservation(source,workspace);noSecret(source.text);continue;}
      aborted(signal);let handle=handles.get(source.sessionId);
      if(!handle){handle=await persistence.open(source.sessionId,'read',{signal});handles.set(source.sessionId,handle);if(!eligibleHeader(handle.header,workspace)||handle.header.id!==source.sessionId)throw new Error('报告引用的会话已不在允许范围');}
      const response=await handle.read(source.seq,1,{signal}),event=response.events[0];
      if(!event||event.seq!==source.seq||source.id!==`event:${hash(`${source.sessionId}:${source.seq}:${source.kind}`)}`||new Date(event.time).toISOString()!==source.occurredAt)throw new Error('报告的原始事件身份不匹配');
      let actual;
      if(source.kind==='user_message'){
        const identity=ownerIdentity(event,handle.header);
        if(!identity||event.data.id!==source.messageId||source.channel&&source.channel!==identity.channel||source.qq&&JSON.stringify(source.qq)!==JSON.stringify(identity.qq))throw new Error('报告引用的主用户来源不能核实');
        actual=text(event.data.content);
      }else if(source.kind==='assistant_response'){
        if(!assistantResponseDelivered(event,handle.header))throw new Error('报告引用的实际回应不能核实，待发或沉默草稿不算已发送');actual=text(event.data.message.content);
      }else if(source.kind==='tool_observation'){
        if(event.type!=='tool/result'||event.data.message.isError)throw new Error('工具观察回执不能核实');actual=text(event.data.message.content);
      }else throw new Error('应用不接收未知的依据类型');
      if(actual!==source.text||hash(actual)!==source.contentHash)throw new Error('报告内容与原始交流不一致');noSecret(actual);
    }
  }finally{await Promise.allSettled([...handles.values()].map(handle=>handle.close()));}
}
