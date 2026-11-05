import fs from 'node:fs/promises';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
import {fixture as base,bot} from './qq-media-continuity-fixture.mjs';
const src=process.env.FRIEND_ADAPTER_SOURCE,load=n=>import(pathToFileURL(src+'/'+n)),req=createRequire(src+'/index.js');
const {GrowthController}=await load('growth.js'),{SocialExperience}=await load('social-experience.js'),{createSocialSnapshot}=await load('social-snapshot.js'),{QQSocialMemory}=await import(pathToFileURL(req.resolve('@ai-friend/qq-bridge/social-memory')));
export {message,picture,owner,alice,bob,group,bot} from './qq-media-continuity-fixture.mjs';
export async function fixture(t){
 const cleanup=[],f=await base({after:fn=>cleanup.push(fn)}),a=f.adapter,s={enabled:true,audits:0,snapshots:0,accept:true,hook:null,plan:[],frames:[],backupFail:false};
 let tail=Promise.resolve();const serial=fn=>{const next=tail.then(fn);tail=next.catch(()=>{});return next;};
 const now=()=>new Date(f.state.clock),growth=new GrowthController({journal:f.journal,serial,now,writeEnabled:()=>s.enabled});
 Object.assign(a,{growth,policy:()=>({enabled:true,writeEnabled:s.enabled}),applications:{active:null},nightly:{active:null}});Object.assign(a.attention.store,{time:()=>now().toISOString(),running:()=>[]});
 const memory=new QQSocialMemory({journal:f.journal,eventStore:f.platforms.store,enabled:()=>s.enabled,currentAccount:()=>bot,now});f.platforms.socialMemory=memory;f.platforms.qqSocial.memory=memory;
 const controller=new SocialExperience(a),instant=controller.immediate;a.socialExperience=controller;const snapshot=createSocialSnapshot(a);
 controller.bind({emotion:async frame=>{s.audits++;s.frames.push(frame);await s.hook?.(frame);return {decision:{decisions:frame.proposals.map((_p,index)=>({index,verdict:s.accept?'accept':'reject',independent:true,confidence:'medium',reason:'隔离审核核对原件与自己的临时反应'}))}};},snapshot:async(...args)=>{s.snapshots++;if(s.backupFail)throw Error('synthetic backup failure');return snapshot(...args);},propose:async()=>({decision:{growth:[],emotion:s.plan,reason:'可不改变'}}),link:async()=>({decision:{related:[],corrections:[],reason:'无新历史关联'}})});
 cleanup.push(()=>memory.close(),()=>growth.close(),()=>controller.close());t.after(async()=>{for(const fn of cleanup.reverse())await fn();});
 const job=id=>{const r=f.journal.db.prepare('SELECT id FROM social_chat_emotion_jobs WHERE event_id=?').get(id);return r?instant.read(r.id):null;};
 const proposal=(quote,extra={})=>({label:'好奇',topic:'眼前的聊天',statement:'对眼前的交流有一点好奇。',reason:'来自本次交流',appraisal:'这次交流值得注意，真实含义仍可澄清。',intensity:'slight',duration:'brief',evidenceQuote:quote,dependsOn:[],...extra});
 const details=()=>({emotion:growth.emotions.store.revision(),growth:growth.store.heads().length,audits:s.audits,snapshots:s.snapshots,budget:growth.store.budget()});
 return {...f,a,s,growth,controller,instant,job,proposal,details};
}
