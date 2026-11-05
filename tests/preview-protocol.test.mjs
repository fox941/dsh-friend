import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
const source=process.env.FRIEND_ADAPTER_SOURCE??fileURLToPath(new URL('../plugins/companion-adapter/src',import.meta.url));
const {validatePreviewShape,previewRepairEligibility,assertPreviewRepairScope,previewJsonSchema}=await import(pathToFileURL(source+'/preview-protocol.js'));
const {validatePreview}=await import(pathToFileURL(source+'/preview.js'));
const {previewRequest,previewInputCharacters,previewRepairInputCharacters,PREVIEW_POLICY}=await import(pathToFileURL(source+'/preview-reviewer.js'));
const snapshot={sources:{sources:[{id:'u1',kind:'user_message',text:'周末我会去看鸟。'},{id:'a1',kind:'assistant_response',text:'我猜你喜欢鸟。'}]},memories:{items:[{id:'m1',kind:'native',text:'旧记录'}]}};
const valid=()=>({summary:'仅预演建议。',proposals:[{action:'supplement',summary:'补充看鸟安排。',reason:'原话有依据。',evidence:[{sourceId:'u1',quote:'周末我会去看鸟。'}],referenceIds:[]}]});
function errorOf(v){try{validatePreviewShape(v);}catch(e){return e;}throw Error('Expected invalid schema');}
test('schema identifies action, evidence and reference paths without copying invalid values or extra keys',()=>{
 const v=valid();Object.assign(v.proposals[0],{action:'keep|defer',evidence:{privateValue:'不能进入诊断'},referenceIds:'m1'});v['private-extra-field']='不能进入诊断';
 const error=errorOf(v);assert.equal(error.code,'PREVIEW_SCHEMA_INVALID');assert(error.issues.some(i=>i.path==='proposals.0.action'));assert(error.issues.some(i=>i.path==='proposals.0.evidence'));assert(error.issues.some(i=>i.path==='proposals.0.referenceIds'));
 assert(!JSON.stringify(error.issues).includes('private'));assert(!JSON.stringify(error.issues).includes('不能进入诊断'));assert(!error.message.includes('keep|defer'));
});
test('generated contract has one action enum and exact available source/reference IDs',()=>{
 const request=previewRequest(snapshot);assert.deepEqual(request.decisionContract.userSourceIds,['u1']);assert.deepEqual(request.decisionContract.referenceIds,['m1']);assert.deepEqual(previewJsonSchema().properties.proposals.items.properties.action.enum,['keep','duplicate','supplement','temporal_change','conflict','leave_hot','review_self','defer']);
 assert(!PREVIEW_POLICY.includes('"action":"keep|'));assert.equal(previewInputCharacters(snapshot),PREVIEW_POLICY.length+JSON.stringify(request).length);
 const repair={snapshot,previous:valid(),problem:{code:'PREVIEW_SCHEMA_INVALID',issues:[]}};assert(previewRepairInputCharacters(repair)>previewInputCharacters(snapshot));assert.equal(previewRequest(snapshot,repair).formatCorrection.maximumAttempts,1);
});
for(const [label,modify]of [['unknown source',p=>p.evidence[0].sourceId='unknown'],['changed quote',p=>p.evidence[0].quote='她从没说过'],['assistant only',p=>p.evidence=[{sourceId:'a1',quote:'我猜你喜欢鸟。'}]],['unknown old reference',p=>p.referenceIds=['unknown']]])test('grounding errors cannot request repair: '+label,()=>{
 const v=valid();modify(v.proposals[0]);assert.throws(()=>validatePreview(v,snapshot),e=>e.code==='PREVIEW_GROUNDING_INVALID'&&e.repairable===false);
 v.proposals[0].action='keep|defer';assert.equal(previewRepairEligibility(v,errorOf(v),snapshot).allowed,false);
});
for(const [label,modify]of [['summary',v=>v.summary='换了个意思'],['proposal text',v=>v.proposals[0].summary='完全不同'],['proposal count',v=>v.proposals=[]],['valid action',v=>v.proposals[0].action='keep'],['quote',v=>v.proposals[0].evidence[0].quote='周末'],['existing refs',v=>v.proposals[0].referenceIds=[]]])test('repair scope rejects content replacement: '+label,()=>{
 const before=valid();before.proposals[0].referenceIds=['m1'];const after=structuredClone(before);modify(after);assert.throws(()=>assertPreviewRepairScope(before,after),e=>e.code==='PREVIEW_GROUNDING_INVALID');
});
test('bounded container repair retains all existing meaning and evidence',()=>{
 const before=valid(),after=structuredClone(before);before.proposals[0].evidence=before.proposals[0].evidence[0];before.proposals[0].referenceIds='m1';after.proposals[0].referenceIds=['m1'];before.proposals=before.proposals[0];
 assert.equal(previewRepairEligibility(before,errorOf(before),snapshot).allowed,true);assertPreviewRepairScope(before,validatePreview(after,snapshot));
});
test('oversized and sensitive drafts cannot be repaired',()=>{
 const large=valid();large.proposals[0].summary='大'.repeat(501);assert.equal(previewRepairEligibility(large,errorOf(large),snapshot).allowed,false);
 const sensitive=valid();sensitive.proposals[0].action='invalid';sensitive.extra='sk-'+'x'.repeat(25);assert.equal(previewRepairEligibility(sensitive,errorOf(sensitive),snapshot).allowed,false);
});
