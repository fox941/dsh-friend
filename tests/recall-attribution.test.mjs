import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const src=process.env.FRIEND_ADAPTER_SOURCE??path.resolve(import.meta.dirname,'../plugins/companion-adapter/src');
const {RecallEvidenceLedger}=await import(pathToFileURL(path.join(src,'recall-evidence.js')));
const {recallEvidence}=await import(pathToFileURL(path.join(src,'recall.js')));
const signal=new AbortController().signal;
function actor(){
 const events=[{type:'turn/start'},{type:'user/message',data:{id:'same-message-label',source:{kind:'user'},content:[{type:'text',text:'比较两次虚构观察。'}]}}];
 return {events,session:{header:{},get seq(){return events.length;},eventAt:i=>structuredClone(events[i])}};
}
async function read(ledger,agent,rows){
 const started=ledger.begin(agent);
 const result=await recallEvidence({query:'虚构观察'},async()=>({results:rows.map(([id,content])=>({id,content,memoryBodyId:'default'})),memoryEvidence:{sourceInstanceKey:'allowed-source',viewId:'pinned-view',id:'actual-read'}}),signal);
 return ledger.admit(agent,started,result);
}
const claim=(r,i,quote)=>({evidenceToken:r.results[i].evidenceToken,quote,use:'record'});

test('read and exact checks share a host-issued current-user-turn context across calls',async()=>{
 const l=new RecallEvidenceLedger(),a=actor(),first=await read(l,a,[['a','第一次观察。']]),second=await read(l,a,[['b','第二次观察。']]);
 assert.deepEqual(first.evidenceContext,second.evidenceContext);
 assert.match(first.evidenceContext.turnId,/^[0-9a-f-]{36}$/);
 assert.equal(first.evidenceContext.scope,'current_user_turn');assert.equal(first.evidenceContext.includesPreviousTurns,false);
 const c=l.check(a,{claims:[claim(first,0,'第一次观察。'),claim(second,0,'第二次观察。')]});
 assert.equal(c.status,'quotes_verified');assert.deepEqual(c.evidenceContext,first.evidenceContext);
 assert(c.checks.every(x=>x.supportScope==='this_source_only'&&x.semanticMatch==='model_must_assess'));
});

test('a new turn with the same message label gets a new context and cannot verify prior tokens',async()=>{
 const l=new RecallEvidenceLedger(),a=actor(),old=await read(l,a,[['old','上轮资料。']]);
 a.events.push({type:'turn/start'},structuredClone(a.events[1]));
 const current=await read(l,a,[['new','本轮资料。']]);
 assert.notEqual(current.evidenceContext.turnId,old.evidenceContext.turnId);
 assert.deepEqual(current.results.map(r=>r.id),['new']);
 const c=l.check(a,{claims:[claim(old,0,'上轮资料。')]});
 assert.equal(c.status,'needs_review');assert.equal(c.checks[0].status,'not_observed');
 assert.equal(c.evidenceContext.turnId,current.evidenceContext.turnId);
});

test('one source quote does not verify a detail missing from the other source',async()=>{
 const l=new RecallEvidenceLedger(),a=actor(),r=await read(l,a,[['early','早期记录：风筝落地了。'],['later','后期记录：风筝落地了。后来风筝被收进木盒。']]);
 const c=l.check(a,{claims:[claim(r,0,'后来风筝被收进木盒。'),claim(r,1,'后来风筝被收进木盒。')]});
 assert.equal(c.status,'needs_review');assert.deepEqual(c.checks.map(x=>x.status),['quote_mismatch','quote_verified']);
 assert.deepEqual(c.checks.map(x=>x.id),['early','later']);assert(c.checks.every(x=>x.supportScope==='this_source_only'));
 // Both common quotes can pass without certifying every later claim about them.
 const common=l.check(a,{claims:[claim(r,0,'风筝落地了。'),claim(r,1,'风筝落地了。')]});
 assert.equal(common.status,'quotes_verified');assert(common.checks.every(x=>x.semanticMatch==='model_must_assess'&&!x.currentStateVerified));
});

test('an empty new-turn result has its own context and does not inherit earlier sources',async()=>{
 const l=new RecallEvidenceLedger(),a=actor(),old=await read(l,a,[['old','先前来源。']]);
 a.events.push({type:'user/message',data:{id:'next-user-message',source:{kind:'user'},content:[]}});
 const current=await read(l,a,[]);assert.equal(current.results.length,0);
 assert.notEqual(current.evidenceContext.turnId,old.evidenceContext.turnId);
 assert.equal(current.evidenceContext.includesPreviousTurns,false);
 assert.equal(l.check(a,{claims:[claim(old,0,'先前来源。')]}).checks[0].status,'not_observed');
 const other=await read(l,actor(),[]);assert.notEqual(other.evidenceContext.turnId,current.evidenceContext.turnId);
});

test('a successful quote check returns only the requested fragment and retains single-source boundaries',async()=>{
 const l=new RecallEvidenceLedger(),a=actor(),r=await read(l,a,[['early','第一份：风筝落地。'],['later','第二份：风筝落地。后来被收进木盒。']]);
 const common=l.check(a,{claims:[claim(r,0,'风筝落地。'),claim(r,1,'风筝落地。')]});
 assert.equal(common.status,'quotes_verified');assert(common.checks.every(x=>x.checkedQuote==='风筝落地。'&&x.verificationScope==='literal_quote_only'&&x.supportScope==='this_source_only'&&x.semanticMatch==='model_must_assess'));
 const detail=l.check(a,{claims:[claim(r,0,'后来被收进木盒。'),claim(r,1,'后来被收进木盒。')]});
 assert.deepEqual(detail.checks.map(x=>x.quoteVerified),[false,true]);assert(detail.checks.every(x=>x.checkedQuote==='后来被收进木盒。'));
});
