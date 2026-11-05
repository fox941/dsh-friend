import {withDiagnosticContext} from './diagnostic-context.js';
/** A bounded tool-free model request shared by growth and memory previews. */
export async function reviewStructured(llm,agent,snapshot,signal,{policy,label,maxTokens=4096,route,images=[],maxImages=6,reasoningEffort:requestedEffort,onProgress}={}){
  return withDiagnosticContext(label,snapshot,async()=>{
  const progress=event=>{try{onProgress?.(event);}catch{/* Metrics must not alter review semantics. */}};progress({phase:'route'});
  const latest=agent?.session?.requestHeader?.()?.config;
  const target=route??(latest?.provider&&latest?.model?latest:agent?.options);
  if(!llm?.stream||!target?.provider||!target?.model)throw new Error(`当前模型路由不可用于${label}`);
  // In real red-image probes, this exact model's low-effort vision gave green/white
  // while the same Files/inline input with thinking off correctly reported red.
  // This applies only to perceptual image requests, not the character's decisions.
  let reasoningEffort=requestedEffort??(images.length>0&&target.model==='deepseek-flash'?'off':undefined);
  if(reasoningEffort===undefined&&llm.resolveModelInfo){
    const info=await llm.resolveModelInfo(target.provider,target.model,signal);
    if(info.reasoning?.efforts?.some(row=>row.id==='low'))reasoningEffort='low';
  }
  if(!Number.isSafeInteger(maxImages)||maxImages<1||maxImages>24||!Array.isArray(images)||images.length>maxImages||images.some(ref=>!ref?.attachmentId||!['image/png','image/jpeg','image/webp','image/gif'].includes(ref.mediaType)))throw new Error('图片引用无效或数量超出预算');
  const options={provider:target.provider,model:target.model,system:policy,messages:[{role:'user',content:[{type:'text',text:JSON.stringify(snapshot)},...images.map(attachment=>({type:'image',attachment}))]}],temperature:0,maxTokens,signal,...agent?.id?{sessionId:agent.id}:{},...reasoningEffort?{reasoningEffort}:{}};
  const blocks=[];let finish,usage,first=true;progress({phase:'request',maxTokens,reasoningEffort:reasoningEffort??'provider-default'});
  for await(const chunk of llm.stream(options)){
    if(first){first=false;progress({phase:'first_chunk'});}progress({phase:'chunk'});
    signal?.throwIfAborted();
    if(finish)throw new Error(`${label}在结束后仍返回数据`);
    if(chunk.type==='block-end'){
      if(chunk.block.type==='text')blocks.push(chunk.block.text);
      else if(chunk.block.type!=='reasoning')throw new Error(`${label}不得调用工具或输出其他内容`);
    }
    if(chunk.type==='usage')usage=chunk.usage;
    if(chunk.type==='finish')finish=chunk.reason;
  }
  progress({phase:'model_done',finishKind:finish?.kind,outputCharacters:blocks.reduce((n,s)=>n+s.length,0),usage});
  if(finish?.kind!=='stop'||blocks.length!==1||blocks[0].length>18000){
    const code=String(finish?.failure?.code??'none').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,60);
    throw Object.assign(new Error(`${label}未完成（结束类型 ${finish?.kind??'missing'}，代码 ${code}，文本块 ${blocks.length}）`),{code:'STRUCTURED_INCOMPLETE',usage:usage??null});
  }
  let decision;try{decision=JSON.parse(blocks[0]);}catch{throw Object.assign(new Error(`${label} JSON 格式不正确`),{code:'STRUCTURED_JSON_INVALID',repairable:true,rawOutput:blocks[0],usage:usage??null});}
  progress({phase:'parsed'});return {decision,usage:usage??null,provider:target.provider,model:target.model,reasoningEffort:reasoningEffort??'provider-default'};
  });
}
