import {fixture as base,bot,owner,alice} from './qzone-chat-emotion-fixture.mjs';
export {bot,owner,alice};
export async function fixture(t){
 const f=await base(t),episode={calls:[],selection:null,accept:true,corrections:null,hook:null};
 f.state.decision={disposition:'ignore',reason:'可以只看不回复'};
 f.controller.host.link=async frame=>{episode.calls.push(frame);return {decision:episode.selection??{relatedEventIds:[],corrections:[],reason:'本次不关联'}};};
 f.controller.host.linkAudit=async frame=>{await episode.hook?.(frame);return {decision:{accept:episode.accept,acceptedCorrections:episode.accept?(episode.corrections??frame.proposal.corrections.map((_,i)=>i)):[],reason:'隔离核对同人同评论线程的明确原话'}};};
 const job=e=>{const row=f.journal.db.prepare('SELECT id FROM social_experience_jobs WHERE event_id=?').get(e.id);return row?f.controller.read(row.id):null;};
 async function receive(body,options){const e=f.space(body,options);await f.execute(e);f.controller.collect();return f.platforms.store.event(e.id);}
 const evaluate=e=>f.controller.execute({payload:{socialExperienceId:job(e).id}},new AbortController().signal);
 const prime=async(body,options)=>{const e=await receive(body,options);await evaluate(e);return e;};
 const relate=(events,corrections=[])=>{episode.selection={relatedEventIds:events.map(e=>e.id),corrections,reason:'隔离关联提案'};};
 const follow=(e,body,options={})=>receive(body,{isReply:true,parentCommentId:e.raw.comment.isReply?e.raw.comment.parentCommentId:e.raw.comment.sequenceId,replyToQQ:bot,...options});
 return {...f,episode,backgroundJob:job,receiveSpace:receive,evaluate,prime,relate,follow};
}
