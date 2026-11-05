import {fixture as base} from './self-state-fixture.mjs';import {pathToFileURL} from 'node:url';
const src=process.env.FRIEND_ADAPTER_SOURCE,{AttentionController}=await import(pathToFileURL(src+'/attention.js')),{Diagnostics}=await import(pathToFileURL(src+'/diagnostics.js')),{BehaviorView}=await import(pathToFileURL(src+'/behavior-view.js'));
export async function fixture(t){const cleanup=[],f=await base({after:fn=>cleanup.push(fn)}),diagnostics=new Diagnostics({journal:f.journal,now:()=>new Date(f.clock.now)}),attention=new AttentionController({journal:f.journal,now:()=>new Date(f.clock.now),diagnostics});f.a.attention=attention;f.a.diagnostics=diagnostics;attention.bind({});t.after(async()=>{try{await attention.close();diagnostics.close();}finally{for(const fn of cleanup.reverse())await fn();}});
 const intent=(summary='眼前一条普通消息。',payload={},kind='message')=>attention.offer({key:'fixture:'+Math.random(),kind,scope:'owner',summary,payload});
 const patch=(row,status,options)=>attention.store.patch(row.id,status,options);
 const decision=(d,status='committed')=>{const key=attention.store.begin(attention.store.meta().epoch,{candidates:[]});attention.store.finish(key,status,{decision:d});return key;};
 return {...f,attention,diagnostics,behavior:new BehaviorView(f.a),intent,patch,decision};
}
