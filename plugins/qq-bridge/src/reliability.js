import {historyProvenance,normalizeHistoryMessage} from './history-source.js';
import {nativeLoginPhase} from './native-health.js';

const defaults=Object.freeze({enabled:true,pollMs:30000,lookbackMs:1800000,respondMs:900000,historyCount:50,threadsPerPoll:2,recoverPerPoll:10,suspectSamples:3,autoRestart:true,restartCooldownMs:1800000,restartWindowMs:86400000,maxNativeRestarts:3});
export function reliabilityConfig(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!(k in defaults)))throw Error('Unknown QQ reliability setting');const c={...defaults,...value};
 for(const k of ['enabled','autoRestart'])if(typeof c[k]!=='boolean')throw Error('Invalid QQ reliability switch');
 for(const [k,min,max]of [['pollMs',10000,300000],['lookbackMs',60000,3600000],['respondMs',30000,900000],['historyCount',1,100],['threadsPerPoll',1,4],['recoverPerPoll',1,30],['suspectSamples',2,10],['restartCooldownMs',300000,86400000],['restartWindowMs',3600000,604800000],['maxNativeRestarts',1,5]])if(!Number.isSafeInteger(c[k])||c[k]<min||c[k]>max)throw Error('QQ reliability setting out of range: '+k);
 if(c.respondMs>c.lookbackMs)throw Error('QQ reply window exceeds recovery lookback');return c;
}
export class QQReliability{
 constructor(channel,{config={},now=()=>Date.now(),phase,resetSocket}={}){
  this.channel=channel;this.platforms=channel.platforms;this.db=this.platforms.store.db;this.now=now;this.config=reliabilityConfig(config);this.key='qq-reliability:v1:'+channel.binding.id;
  const saved=this.db.prepare('SELECT value FROM platform_meta WHERE key=?').get(this.key);this.state=saved?JSON.parse(saved.value):{schema:1,account:channel.binding.bot_qq,baselineAt:Math.floor(this.now()/1000)*1000-1000,nativeAttempts:[],rotation:0,recovered:0,archived:0,coverage:{}};
  if(this.state.schema!==1||this.state.account!==channel.binding.bot_qq||!Number.isFinite(this.state.baselineAt)||!Array.isArray(this.state.nativeAttempts))throw Error('QQ reliability state does not match original binding');
  this.state.nativeAttempts=this.state.nativeAttempts.filter(Number.isFinite);this.state.classification='checking';this.state.badSamples=0;this.state.apiFailures=0;this.stop=new AbortController();this.closed=false;this.running=null;
  this.phase=phase??(signal=>nativeLoginPhase(this.platforms.instance,signal));this.resetSocket=resetSocket??(async()=>{await channel.connection.stop();if(!this.closed)channel.connection.start();});this.save();
 }
 save(){this.state.updatedAt=this.now();this.db.prepare('INSERT INTO platform_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key,JSON.stringify(this.state));}
 status(){const s=this.state;return {enabled:this.config.enabled,classification:s.classification,checkedAt:s.checkedAt??null,lastInboundAt:s.lastInboundAt??null,lastHeartbeatAt:s.lastHeartbeatAt??null,friendCount:s.friendCount??null,nativePhase:s.nativePhase??null,badSamples:s.badSamples,apiFailures:s.apiFailures,recoveryCount:s.nativeAttempts.filter(at=>at>this.now()-this.config.restartWindowMs).length,lastNativeRestartAt:s.nativeAttempts.at(-1)??null,lastSocketResetAt:s.lastSocketResetAt??null,recoveryHeld:s.recoveryHeld??null,restartReceipt:s.restartReceipt??null,action:s.classification==='login_required'?'Open-QQ-Login.cmd':null,recovered:s.recovered,archived:s.archived,coverage:s.coverage,lastIssue:s.lastIssue??null,baselineAt:s.baselineAt,scope:'Technical evidence only; idle/silence never implies failure; API success alone does not prove end-to-end delivery'};}
 start(){if(!this.config.enabled)return;this.timer=setInterval(()=>{void this.poll();},this.config.pollMs);this.timer.unref?.();void this.poll();}
 connected(){this.state.disconnectedSince??=this.now();this.state.classification='checking';}
 disconnected(){this.state.disconnectedSince??=this.now();this.state.classification='disconnected';}
 observe(event){
  if(String(event?.self_id)!==this.channel.binding.bot_qq)return;
  if(event.post_type==='meta_event'){this.state.lastHeartbeatAt=this.now();if(event.status?.online===false)this.state.metaOfflineAt=this.now();else if(event.status?.online===true)this.state.metaOfflineAt=null;return;}
  if(event.post_type!=='message'||String(event.user_id)===this.channel.binding.bot_qq)return;
  this.state.lastInboundAt=this.now();this.state.lastInboundSourceTime=Number.isSafeInteger(event.time)?event.time*1000:null;
  if(event.message_type==='private'&&/^\d{5,12}$/.test(String(event.user_id))){const peer=String(event.user_id);this.state.observedPeers=[{id:peer,at:this.now()},...(this.state.observedPeers??[]).filter(p=>p.id!==peer)].slice(0,8);}
 }
 provenance(event){return historyProvenance(event);}
 recoveredOwner(row){const raw=this.db.prepare('SELECT value FROM platform_meta WHERE key=?').get('qq-recovered-owner:'+row.id);if(!raw)return null;const p=JSON.parse(raw.value);return p.platformId===row.platform_id&&p.bodyHash===row.body_hash&&p.bindingId===row.binding_id?p:null;}
 saveOwner(row,proof){this.db.prepare('INSERT INTO platform_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING').run('qq-recovered-owner:'+row.id,JSON.stringify({...proof,bindingId:row.binding_id,bodyHash:row.body_hash}));}
 async call(action,args={}){this.stop.signal.throwIfAborted();return this.channel.connection.call(action,args);}
 poll(){if(this.running)return this.running;if(this.closed||!this.config.enabled)return Promise.resolve();this.running=this.work().catch(()=>{if(!this.closed){this.state.classification='inspection_failed';this.state.lastIssue='QQ health inspection did not finish';this.save();}}).finally(()=>{this.running=null;});return this.running;}
 async work(){
  const q=this.channel,s=this.state,c=this.config,now=this.now();s.checkedAt=now;
  if(!q.connection?.connected){q.ready=false;s.classification='disconnected';s.disconnectedSince??=now;s.nativePhase=await this.phase(this.stop.signal);if(s.nativePhase==='scan_required')s.classification='login_required';this.save();return;}
  let info,status,friends;
  try{
   info=await this.call('get_login_info');if(String(info.user_id)!==q.binding.bot_qq){q.ready=false;s.classification='wrong_account';s.lastIssue='Actual QQ account does not match binding';this.save();return;}
   status=await this.call('get_status');friends=await this.call('get_friend_list',{no_cache:true});if(typeof status?.online!=='boolean'||typeof status?.good!=='boolean'||!Array.isArray(friends))throw Error();
  }catch{
   this.stop.signal.throwIfAborted();s.apiFailures=(s.apiFailures??0)+1;s.classification='api_unavailable';s.lastIssue='Authenticated QQ business API unavailable';s.nativePhase=await this.phase(this.stop.signal);
   if(s.nativePhase==='scan_required'){s.classification='login_required';q.ready=false;}
   else if(s.apiFailures>=c.suspectSamples&&now-(s.lastSocketResetAt??0)>=300000){s.lastSocketResetAt=now;this.save();await this.resetSocket();}
   this.save();return;
  }
  s.apiFailures=0;s.friendCount=friends.length;
  const offline=status?.online===false||status?.good===false||s.metaOfflineAt&&s.metaOfflineAt>(s.lastInboundAt??0)&&now-s.metaOfflineAt<90000;
  const missingRoster=s.hadFriends===true&&friends.length===0;
  if(friends.length)s.hadFriends=true;
  if(offline||missingRoster){
   s.badSamples=(s.badSamples??0)+1;s.suspectSince??=now;s.classification='suspect';s.lastIssue=offline?'QQ backend reports offline':'Previously available friend roster became empty';s.nativePhase=await this.phase(this.stop.signal);
   if(s.nativePhase==='scan_required'){s.classification='login_required';q.ready=false;this.save();return;}
   // Empty history or a quiet chat never contributes to this decision.
   if(missingRoster&&s.badSamples>=c.suspectSamples&&s.nativePhase==='logged_in'&&(s.lastInboundAt??0)<s.suspectSince){
    let profileFailed=false;try{const profile=await this.call('get_stranger_info',{user_id:Number(q.binding.bot_qq),no_cache:true});profileFailed=String(profile?.user_id)!==q.binding.bot_qq;}catch{this.stop.signal.throwIfAborted();profileFailed=true;}
    if(profileFailed){s.classification='degraded';s.lastIssue='Empty roster plus self-profile query failure across repeated probes';await this.restartNative();}
   }
   this.save();return;
  }
  s.badSamples=0;s.suspectSince=null;s.classification='ready';s.lastIssue=null;s.recoveryHeld=null;s.nativePhase='not_required';s.metaOfflineAt=null;
  if(!q.ready)await q.handshake(q.epoch);
  delete s.disconnectedSince;await this.sweep(friends);await this.platforms.relationships?.poll(this.stop.signal);await this.platforms.incomingRequests?.poll(this.stop.signal);await this.platforms.qzoneInbox?.poll(this.stop.signal);this.save();
 }
 async restartNative(){
  const q=this.channel,s=this.state,c=this.config,now=this.now();s.nativeAttempts=s.nativeAttempts.filter(at=>at>now-c.restartWindowMs);
  if(!c.autoRestart||s.nativeAttempts.length>=c.maxNativeRestarts||now-(s.nativeAttempts.at(-1)??0)<c.restartCooldownMs){s.recoveryHeld='cooldown_or_limit';return;}
  if(q.sending||q.driving||this.platforms.active||q.host?.getAgent?.(q.binding.session_id)?.status==='running'){s.recoveryHeld='active_work';return;}
  const actual=await this.call('get_login_info');if(String(actual.user_id)!==q.binding.bot_qq){s.classification='wrong_account';q.ready=false;return;}
  s.nativeAttempts.push(now);s.recoveryHeld=null;s.classification='recovering';s.lastIssue='Authenticated NapCat worker reload requested once';this.save();q.ready=false;
  try{await this.call('set_restart',{});s.restartReceipt='accepted';}catch{s.restartReceipt='unknown_no_repeat';}
 }
 scopes(friends){
  const q=this.channel,account=q.binding.bot_qq,p=this.platforms.store.policy(),list=[{kind:'private',id:q.binding.owner_qq,key:'qq-private:'+account+':'+q.binding.owner_qq}];
  if(p.enabled){for(const id of p.groups)list.push({kind:'group',id,key:'qq-group:'+account+':'+id});if(p.friends){const known=new Set(friends.map(f=>String(f.user_id))),recent=this.db.prepare("SELECT sender FROM platform_events WHERE account=? AND kind='friend' GROUP BY sender ORDER BY max(created_at) DESC LIMIT 8").all(account).map(r=>r.sender);for(const id of [...new Set([...(this.state.observedPeers??[]).map(p=>p.id),...recent])].slice(0,8))if(id!==q.binding.owner_qq&&known.has(id))list.push({kind:'private',id,key:'qq-private:'+account+':'+id});}}
  return list;
 }
 async sweep(friends){
  const q=this.channel,s=this.state,c=this.config,scopes=this.scopes(friends);let admitted=0;
  for(let i=0;i<Math.min(c.threadsPerPoll,scopes.length)&&!this.closed;i++){
   const scope=scopes[s.rotation%scopes.length];s.rotation=(s.rotation+1)%scopes.length;
   const coverage={checkedAt:this.now(),count:0,limited:false,recovered:0,archived:0,skipped:0};s.coverage[scope.key]=coverage;
   let response;try{response=await this.call(scope.kind==='group'?'get_group_msg_history':'get_friend_msg_history',{[scope.kind==='group'?'group_id':'user_id']:Number(scope.id),count:c.historyCount});}catch{coverage.issue='history_unavailable';continue;}
   if(!Array.isArray(response?.messages)){coverage.issue='history_shape_invalid';continue;}
   coverage.count=response.messages.length;coverage.limited=response.messages.length>=c.historyCount;
   const rows=response.messages.slice(0,c.historyCount).map((raw,index)=>({raw,index})).sort((a,b)=>(Number(a.raw.time)||0)-(Number(b.raw.time)||0)||a.index-b.index);
   for(const {raw}of rows){
    if(this.closed)return;const event=normalizeHistoryMessage(raw,scope,q.binding,{now:this.now(),baselineAt:s.baselineAt,lookbackMs:c.lookbackMs,respondMs:c.respondMs});if(!event){coverage.skipped++;continue;}const proof=historyProvenance(event);
    const owner=scope.kind==='private'&&scope.id===q.binding.owner_qq;
    const existing=owner?q.store.byPlatform(q.binding.id,proof.platformId):this.platforms.store.db.prepare('SELECT id FROM platform_events WHERE event_key=?').get(scope.key+':'+proof.platformId);if(existing)continue;
    if(admitted>=c.recoverPerPoll){coverage.limited=true;break;}
    try{const result=await q.receive(event);if(['accepted','recovered_history'].includes(result?.status)){admitted++;const historical=result.status==='recovered_history';s[historical?'archived':'recovered']++;coverage[historical?'archived':'recovered']++;}else if(result?.status!=='duplicate')coverage.issue='source_not_admitted';}catch{coverage.issue='admission_waiting';}
   }
  }
  const active=new Set(scopes.map(s=>s.key));for(const key of Object.keys(s.coverage))if(!active.has(key))delete s.coverage[key];
 }
 async close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);this.stop.abort();await this.running;this.save();}
}
