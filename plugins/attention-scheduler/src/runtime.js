import {assign,createActor,createMachine,fromPromise,toPromise} from 'xstate';

const stopped=()=>new Error('调度执行器已关闭');
const decisionMachine=createMachine({
 id:'decision',initial:'working',context:({input})=>({run:input,outcome:null}),
 on:{CLOSE:{target:'.cancelled',actions:assign({outcome:()=>({ok:false,error:stopped()})})}},
 states:{
  working:{invoke:{src:fromPromise(({input,signal})=>Promise.resolve().then(()=>input(signal))),input:({context})=>context.run,
   onDone:{target:'finished',actions:assign({outcome:({event})=>({ok:true,value:event.output})})},
   onError:{target:'finished',actions:assign({outcome:({event})=>({ok:false,error:event.error})})}}},
  finished:{type:'final'},cancelled:{type:'final'}
 },output:({context})=>context.outcome
});

/** One XState invocation shared by simultaneous decision requests. No hidden model retries. */
export class DecisionRunner{
 constructor(){this.active=null;this.closed=false;}
 run(fn){
  if(this.closed)return Promise.reject(stopped());if(this.active)return this.active.promise;
  const actor=createActor(decisionMachine,{input:fn});
  const active={actor,promise:null};this.active=active;
  active.promise=toPromise(actor).then(outcome=>{if(!outcome.ok)throw outcome.error;return outcome.value;}).finally(()=>{actor.stop();if(this.active===active)this.active=null;});
  actor.start();return active.promise;
 }
 status(){return this.closed?'closed':this.active?.actor.getSnapshot().value??'idle';}
 close(){this.closed=true;this.active?.actor.send({type:'CLOSE'});}
}

const admissionMachine=createMachine({
 id:'admission',initial:'idle',context:{queue:[]},
 on:{
  ENQUEUE:{actions:assign({queue:({context,event})=>[...context.queue,event.job]})},
  CLOSE:{target:'.closed',actions:[({context})=>{for(const job of context.queue)job.reject(stopped());},assign({queue:()=>[]})]}
 },
 states:{
  idle:{always:{guard:({context})=>context.queue.length>0,target:'working'}},
  working:{invoke:{src:fromPromise(({input,signal})=>Promise.resolve().then(()=>{signal.throwIfAborted();return input.run(signal);})),input:({context})=>context.queue[0],
   onDone:{target:'idle',actions:[({context,event})=>context.queue[0].resolve(event.output),assign({queue:({context})=>context.queue.slice(1)})]},
   onError:{target:'idle',actions:[({context,event})=>context.queue[0].reject(event.error),assign({queue:({context})=>context.queue.slice(1)})]}}},
  closed:{type:'final'}
 }
});

/** FIFO admission only. Running platform tasks may yield at their own verified checkpoints. */
export class SerialExecutor{
 constructor(){this.closed=false;this.pending=new Set();this.actor=createActor(admissionMachine).start();}
 run(fn){
  if(this.closed)return Promise.reject(stopped());
  let job;const promise=new Promise((resolve,reject)=>{job={run:fn,resolve,reject};});this.pending.add(promise);
  promise.then(()=>this.pending.delete(promise),()=>this.pending.delete(promise));
  this.actor.send({type:'ENQUEUE',job});return promise;
 }
 idle(){return Promise.allSettled([...this.pending]).then(()=>{});}
 status(){const snapshot=this.actor.getSnapshot();return {phase:snapshot.value,queued:snapshot.context.queue.length};}
 close(){if(this.closed)return;this.closed=true;this.actor.send({type:'CLOSE'});this.actor.stop();}
}
