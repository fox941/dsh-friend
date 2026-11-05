import {hash} from './validation.js';
export const resumableNightly=new Set(['queued','yielded','interrupted','retry_wait','budget_exhausted']);
// A replay of the same human request has the same identity. Wall-clock capture
// time is intentionally excluded; a genuinely new retry request gets a new key.
export function nightlyRequestKey(authorization={}){
 const a=authorization;
 return hash(JSON.stringify(a.kind==='nightly-control'?[a.kind,a.action??'legacy',a.sessionId,a.messageId,a.seq??null,a.quote]:[a.kind,a.policy,a.schedule,a.authorizedAt]));
}
export const nightlyIntentKey=run=>'nightly:'+run.id+':'+nightlyRequestKey(run.authorization);
export function matchesNightlyIntent(intent,run){
 if(!intent||!run||intent.kind!=='nightly'||intent.payload?.runId!==run.id)return false;
 if(intent.payload.requestKey)return intent.payload.requestKey===nightlyRequestKey(run.authorization);
 // Compatibility only for an original legacy request. A later manual retry
 // must never admit a stale selected/cancelled request from the prior generation.
 const a=run.authorization??{},stamp=a.at??a.authorizedAt,authorized=typeof stamp==='number'?stamp:Date.parse(stamp),offered=Date.parse(intent.created_at);
 return intent.event_key==='nightly:'+run.id&&a.action!=='retry'&&Number.isFinite(authorized)&&Number.isFinite(offered)&&authorized<=offered;
}
