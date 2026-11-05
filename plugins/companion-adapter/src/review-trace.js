/** Timing and counts only: never retain prompts, tokens, chunks or model text. */
export class ReviewTrace {
 constructor({clock=()=>performance.now()}={}){this.clock=clock;this.started=clock();this.durations={};this.marks={};this.chunks=0;this.finishKind=null;this.outputCharacters=null;this.inputCharacters=null;this.rebatches=0;}
 elapsed(){return Math.max(0,Math.round(this.clock()-this.started));}
 async step(name,fn){const start=this.clock(),previous=this.currentPhase;this.currentPhase=name;try{return await fn();}finally{this.currentPhase=previous;this.durations[name]=(this.durations[name]??0)+Math.max(0,Math.round(this.clock()-start));}}
 progress(event){
  if(event.phase==='chunk'){this.chunks++;return;}
  if(!['route','request','first_chunk','model_done','parsed'].includes(event.phase))return;
  this.marks[event.phase]??=this.elapsed();
  if(event.phase==='request'){
   if(Number.isSafeInteger(event.maxTokens)&&event.maxTokens>0)this.maxTokens=event.maxTokens;
   if(/^(off|low|medium|high|max|provider-default)$/.test(event.reasoningEffort??''))this.reasoningEffort=event.reasoningEffort;
  }
  if(event.phase==='model_done'){
   this.finishKind=/^[a-z-]{1,32}$/.test(event.finishKind??'')?event.finishKind:'unknown';
   if(Number.isSafeInteger(event.outputCharacters)&&event.outputCharacters>=0)this.outputCharacters=event.outputCharacters;
   if(event.usage&&typeof event.usage==='object')this.usage=Object.fromEntries(['inputTokens','outputTokens','reasoningTokens','totalTokens','cacheReadTokens','cacheWriteTokens'].filter(k=>Number.isSafeInteger(event.usage[k])&&event.usage[k]>=0).map(k=>[k,event.usage[k]]));
  }
 }
 snapshot(){
  const delta=(end,start)=>this.marks[end]===undefined||this.marks[start]===undefined?null:Math.max(0,this.marks[end]-this.marks[start]);
  return {version:1,totalMs:this.elapsed(),currentPhase:this.currentPhase??null,phases:{...this.durations},milestones:{...this.marks},requestSetupMs:delta('request','route'),firstChunkWaitMs:delta('first_chunk','request'),streamMs:delta('model_done','first_chunk'),requestElapsedMs:this.marks.request===undefined?null:(this.marks.model_done??this.elapsed())-this.marks.request,parseMs:delta('parsed','model_done'),chunks:this.chunks,finishKind:this.finishKind,maxTokens:this.maxTokens??null,reasoningEffort:this.reasoningEffort??null,usage:this.usage?{...this.usage}:null,outputCharacters:this.outputCharacters,inputCharacters:this.inputCharacters,rebatches:this.rebatches};
 }
}
