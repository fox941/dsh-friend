import {qqHelper} from './qq-helper-client.js';import {hash} from './validation.js';
const recovered=new WeakMap();
export const incomingRecovery=event=>recovered.get(event)??null;
export function requestKey(account,event){return 'request:'+account+':'+event.request_type+':'+hash(JSON.stringify({flag:event.flag,sender:String(event.user_id),group:event.group_id?String(event.group_id):null}));}
const validId=value=>/^[1-9]\d{4,11}$/.test(String(value));
export function recoverIncoming(raw,account,now){
 if(!raw||raw.post_type!=='request'||String(raw.self_id)!==account||!['friend','group'].includes(raw.request_type)||raw.request_type==='group'&&raw.sub_type!=='invite'||!validId(raw.user_id)||String(raw.user_id)===account||typeof raw.flag!=='string'||!/^\d{1,24}$/.test(raw.flag)||raw.request_type==='friend'&&!/^\d{10}$/.test(raw.flag)||raw.request_type==='group'&&!validId(raw.group_id)||!Number.isSafeInteger(raw.time)||raw.time*1000<now-7*86400000||raw.time*1000>now+30000||typeof raw.comment!=='string'||raw.comment.length>2000)return null;
 const event=structuredClone(raw);recovered.set(event,Object.freeze({method:'authenticated-native-pending-list',originalAt:new Date(raw.time*1000).toISOString(),recoveredAt:new Date(now).toISOString(),learningAllowed:false}));return event;
}
export class QQIncomingRequests{
 constructor({store,channel,instance,receive,query=qqHelper}){Object.assign(this,{store,channel,instance,receive,query});this.key='qq-incoming-requests:v1:'+channel.binding?.bot_qq;const saved=store.db.prepare('SELECT value FROM platform_meta WHERE key=?').get(this.key);this.state=saved?JSON.parse(saved.value):{schema:1,lastPollAt:0,coverage:{},recovered:0};this.running=null;}
 save(){this.store.db.prepare('INSERT INTO platform_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key,JSON.stringify(this.state));}
 status(){return {...this.state,enabled:this.store.policy().enabled,scope:'Pending incoming friend requests and self group invitations only; no outgoing friend add'};}
 poll(signal){if(this.running)return this.running;this.running=this.sweep(signal).finally(()=>{this.running=null;});return this.running;}
 async sweep(signal){const now=this.store.now().valueOf(),account=this.channel.binding?.bot_qq,p=this.store.policy();if(!p.enabled||!this.channel.ready||!account||this.channel.platforms?.active||now-this.state.lastPollAt<60000)return;this.state.lastPollAt=now;
  for(const kind of ['friend','group']){
   signal?.throwIfAborted();if(kind==='friend'&&!p.friends||kind==='group'&&!p.autonomousJoin&&!p.groups.length)continue;
   const coverage={checkedAt:now,count:0,admitted:0,skipped:0,limited:false};this.state.coverage[kind]=coverage;
   try{const result=await this.query(this.instance,account,'/incoming-requests',{kind,limit:50},signal);if(!Array.isArray(result.events)||result.events.length>50)throw Error();coverage.count=result.count;coverage.limited=result.limited===true;
    for(const raw of result.events){if(coverage.admitted>=20){coverage.limited=true;break;}const event=recoverIncoming(raw,account,now);if(!event){coverage.skipped++;continue;}const admitted=await this.receive(event);if(admitted?.status==='accepted'&&admitted?.newlyAccepted!==false){coverage.admitted++;this.state.recovered++;}}
   }catch{signal?.throwIfAborted();coverage.issue='native_pending_list_unavailable';}
  }this.save();
 }
}
